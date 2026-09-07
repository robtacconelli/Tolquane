"""The distributed runtime, exercised with several groups on loopback in one process."""

import random
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

import tolquane as tq
from tolquane import net
from tolquane.net import load_deployment, partition

# Workers at module level so the processes runtime can find them too.


def double(x: int) -> int:
    return x * 2


def add_index(x: int, ctx: tq.Context) -> None:
    ctx.send(x + ctx.index)


def jitter(x: int) -> int:
    time.sleep(random.random() * 0.002)
    return x


def slow_first(x: int, ctx: tq.Context) -> None:
    if x == 0:
        time.sleep(0.5)
    ctx.send(x)


def boom(x: int) -> int:
    if x == 5:
        raise ValueError("five over the wire")
    return x


class RunningSum:
    def __init__(self) -> None:
        self.total = 0

    def __call__(self, x: int) -> int:
        self.total += x
        return self.total


# ----------------------------------------------------------------------------- helpers


def free_ports(n: int) -> list[int]:
    ports = []
    socks = []
    for _ in range(n):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        socks.append(s)
        ports.append(s.getsockname()[1])
    for s in socks:
        s.close()
    return ports


def deploy(groups: dict[str, list[str]], **options: Any) -> dict[str, Any]:
    ports = free_ports(len(groups))
    return {
        "groups": {
            name: {"endpoint": f"127.0.0.1:{port}", "nodes": nodes}
            for (name, nodes), port in zip(groups.items(), ports, strict=True)
        },
        "options": {"connect_timeout": 20, "reconnect_timeout": 10, **options},
    }


def run_groups(
    graph: Any,
    deployment: dict[str, Any],
    *,
    runtimes: dict[str, str] | None = None,
    delays: dict[str, float] | None = None,
    timeout: float = 60.0,
    **options: Any,
) -> dict[str, Any]:
    """Run every group in its own thread; return report or exception per group."""
    results: dict[str, Any] = {}

    def one(name: str) -> None:
        if delays and name in delays:
            time.sleep(delays[name])
        try:
            results[name] = tq.run(
                graph,
                deploy=deployment,
                group=name,
                runtime=(runtimes or {}).get(name, "threads"),
                **options,
            )
        except BaseException as exc:
            results[name] = exc

    threads = [threading.Thread(target=one, args=(g,), daemon=True) for g in deployment["groups"]]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout)
        assert not t.is_alive(), "a group did not finish in time"
    return results


# ----------------------------------------------------------------------------- deploy files


def test_load_deployment_from_toml(tmp_path: Path) -> None:
    path = tmp_path / "deploy.toml"
    path.write_text(
        '[groups.A]\nendpoint = "10.0.0.1:7000"\nnodes = ["numbers", "double"]\n'
        '[groups.B]\nendpoint = "10.0.0.2:7000"\nnodes = ["show"]\n'
        '[options]\nsecret = "s3"\nconnect_timeout = 5\n'
    )
    d = load_deployment(path)
    assert d.group("A").endpoint == "10.0.0.1:7000"
    assert d.group("B").patterns == ("show",)
    assert d.secret == "s3"
    assert d.connect_timeout == 5.0
    with pytest.raises(tq.GraphError, match="unknown group"):
        d.group("C")
    bad = tmp_path / "bad.toml"
    bad.write_text('[groups.A]\nendpoint = "nohost"\nnodes = ["x"]\n')
    with pytest.raises(tq.GraphError, match="host:port"):
        load_deployment(bad)
    with pytest.raises(tq.GraphError, match="does not exist"):
        load_deployment(tmp_path / "missing.toml")


def test_assignment_and_partition() -> None:
    g = tq.check(tq.from_iterable([1]) >> tq.farm(double, 2, name="work") >> tq.to_list())
    d = load_deployment(deploy({"A": ["from_iterable", "work"], "B": ["to_list"]}))
    state = net._State(d, "A")
    local, edges = partition(g, d, "A", state)
    assert [n.name for n in local.nodes][:5] == [
        "from_iterable",
        "work.emitter",
        "work.0",
        "work.1",
        "work.collector",
    ]
    assert local.nodes[-1].name == "net.out:work.collector->to_list#0"
    assert [e.id for e in edges] == ["work.collector->to_list#0"]
    local_b, _ = partition(g, d, "B", net._State(d, "B"))
    assert [n.name for n in local_b.nodes] == ["to_list", "net.in:work.collector->to_list#0"]
    # Glob patterns split a farm between groups; the farm name alone covers all of it.
    d2 = load_deployment(
        deploy(
            {
                "A": ["from_iterable", "work.emitter", "work.collector", "to_list"],
                "B": ["work.[0-9]*"],
            }
        )
    )
    _local_a, edges_a = partition(g, d2, "A", net._State(d2, "A"))
    assert len(edges_a) == 4
    with pytest.raises(tq.GraphError, match="not assigned"):
        partition(
            g,
            load_deployment(deploy({"A": ["from_iterable"], "B": ["to_list"]})),
            "A",
            net._State(d, "A"),
        )
    with pytest.raises(tq.GraphError, match="claimed by several"):
        partition(
            g,
            load_deployment(deploy({"A": ["work", "from_iterable"], "B": ["work.0", "to_list"]})),
            "A",
            net._State(d, "A"),
        )


def test_loops_and_ordered_ends_must_stay_in_one_group() -> None:
    @tq.node
    def back(x: int, ctx: tq.Context) -> None:
        ctx.feedback(x)

    loop = tq.check(
        tq.from_iterable([1])
        >> tq.feedback(tq.farm(double, 2, collector=back, name="w"))
        >> tq.to_list()
    )
    d = load_deployment(
        deploy({"A": ["from_iterable", "w.emitter", "to_list"], "B": ["w.[0-9]*", "w.collector"]})
    )
    with pytest.raises(tq.GraphError, match="spans groups"):
        partition(loop, d, "A", net._State(d, "A"))
    ordered = tq.check(
        tq.from_iterable([1]) >> tq.farm(double, 2, ordered=True, name="w") >> tq.to_list()
    )
    d = load_deployment(
        deploy({"A": ["from_iterable", "w.emitter", "to_list"], "B": ["w.[0-9]*", "w.collector"]})
    )
    with pytest.raises(tq.GraphError, match="emitter and collector"):
        partition(ordered, d, "A", net._State(d, "A"))


def test_run_needs_both_deploy_and_group() -> None:
    with pytest.raises(tq.TolquaneError, match="go together"):
        tq.run(tq.from_iterable([1]) >> tq.to_list(), group="A")


# ----------------------------------------------------------------------------- the thesis programs


def test_pipeline_network() -> None:
    """pipeline_network.java: two nodes on two hosts, one channel between them."""
    out = tq.to_list()
    g = tq.from_iterable(range(1, 101)) >> double >> out
    results = run_groups(g, deploy({"A": ["from_iterable", "double"], "B": ["to_list"]}))
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == [2 * i for i in range(1, 101)]
    assert results["A"].nodes["net.out:double->to_list#0"].items_out == 100
    assert results["B"].nodes["net.in:double->to_list#0"].items_in == 100


def test_network_test_farm_then_tcp_then_out_node() -> None:
    """networkTest.java: a farm with round-robin ends, a TCP channel, an out node."""
    out = tq.to_list()
    g = (
        tq.from_iterable(range(2000))
        >> tq.farm(RunningSum, 4, collect="round_robin", name="w")
        >> out
    )
    results = run_groups(g, deploy({"A": ["from_iterable", "w"], "B": ["to_list"]}))
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert len(out.items) == 2000
    assert max(out.items) == max(sum(i for i in range(2000) if i % 4 == k) for k in range(4))


def test_benchmark_network_farm_shape_workers_on_another_host() -> None:
    """benchmark_network_farm.java: emitter and collector here, the workers over there."""
    out = tq.to_list()
    g = tq.from_iterable(range(300)) >> tq.farm(add_index, 3, name="w") >> out
    results = run_groups(
        g,
        deploy({"A": ["from_iterable", "w.emitter", "w.collector", "to_list"], "B": ["w.[0-9]*"]}),
    )
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert len(out.items) == 300
    assert {x - i for x in out.items for i in (0, 1, 2)} >= set(range(300))


def test_combine2_network_feedback_shape() -> None:
    """combine2_network_feedback.java: the last stage sends its items back over TCP."""

    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % ctx.n_outputs)

    @tq.node
    def worker1(x: int) -> int:
        return x

    @tq.node
    def worker2(x: int) -> int:
        return x

    @tq.node
    def filter1(x: int, ctx: tq.Context) -> None:
        ctx.send(x)

    @tq.node
    def filter2(x: int, ctx: tq.Context) -> None:
        ctx.send(x)

    back = tq.to_list(name="back_home")
    g = (
        tq.from_iterable(range(1, 101))
        >> tq.farm(tq.comb(worker1, worker2), 3, emitter=emitter, collector=filter1, name="s2")
        >> filter2
        >> back
    )
    results = run_groups(g, deploy({"A": ["from_iterable", "s2", "back_home"], "B": ["filter2"]}))
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert sorted(back.items) == list(range(1, 101))


def test_benchmark_network_two_nodes_batched() -> None:
    """benchmark_network.java: a stream of integers over one channel, batched."""
    out = tq.to_list()
    g = tq.from_iterable(range(20_000)) >> out
    results = run_groups(g, deploy({"A": ["from_iterable"], "B": ["to_list"]}), batch=64)
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == list(range(20_000))


# ----------------------------------------------------------------------------- across the wire


def test_ordered_farm_with_remote_workers_keeps_order() -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(200)) >> tq.farm(jitter, 3, ordered=True, name="w") >> out
    results = run_groups(
        g,
        deploy({"A": ["from_iterable", "w.emitter", "w.collector", "to_list"], "B": ["w.[0-9]*"]}),
    )
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == list(range(200))


def test_on_demand_across_groups_and_no_false_deadlock() -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(30)) >> tq.farm(slow_first, 3, emit="on_demand", name="w") >> out
    results = run_groups(
        g,
        deploy({"A": ["from_iterable", "w.emitter", "w.collector", "to_list"], "B": ["w.[0-9]*"]}),
        deadlock_timeout=0.2,
    )
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert sorted(out.items) == list(range(30))


def test_groups_may_start_in_any_order() -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(50)) >> double >> out
    d = deploy({"A": ["from_iterable", "double"], "B": ["to_list"]})
    results = run_groups(g, d, delays={"B": 1.0})  # receiver late: sender waits and retries
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == [2 * i for i in range(50)]
    out = tq.to_list()
    g = tq.from_iterable(range(50)) >> double >> out
    results = run_groups(
        g, deploy({"A": ["from_iterable", "double"], "B": ["to_list"]}), delays={"A": 1.0}
    )
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == [2 * i for i in range(50)]


def test_dropped_connection_is_resumed_without_loss_or_duplicates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = net._Receiver._serve
    drops = {"left": 2}

    def flaky(self: Any, sock: socket.socket, outbox: Any) -> bool:
        if drops["left"] > 0:
            drops["left"] -= 1
            # Take one frame, ack it, then cut the connection.
            kind, obj = net.recv_frame(sock)
            assert kind == net.DATA
            first, items = obj
            skip = self.expected - first
            for item in items[skip:]:
                self.ctx.send(item)
            self.expected = max(self.expected, first + len(items))
            net.send_frame(sock, net.ACK, self.expected)
            raise ConnectionError("simulated drop")
        return original(self, sock, outbox)

    monkeypatch.setattr(net._Receiver, "_serve", flaky)
    out = tq.to_list()
    g = tq.from_iterable(range(500)) >> out
    results = run_groups(g, deploy({"A": ["from_iterable"], "B": ["to_list"]}), batch=16)
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == list(range(500))
    assert drops["left"] == 0


def test_failure_in_one_group_reaches_the_other() -> None:
    # The sender still has most of its stream to deliver when the receiver's node fails.
    out = tq.to_list()
    g = tq.from_iterable(range(100_000)) >> boom >> out
    results = run_groups(g, deploy({"A": ["from_iterable"], "B": ["boom", "to_list"]}), capacity=64)
    assert isinstance(results["B"], tq.NodeError)
    assert isinstance(results["A"], tq.PeerFailed), results["A"]
    assert "five over the wire" in str(results["A"])
    # And the other direction: the sender fails, the receiver learns why.
    out = tq.to_list()
    g = tq.from_iterable(range(100)) >> boom >> out
    results = run_groups(g, deploy({"A": ["from_iterable", "boom"], "B": ["to_list"]}))
    assert isinstance(results["A"], tq.NodeError)
    assert isinstance(results["B"], tq.PeerFailed), results["B"]


def test_unreachable_peer_is_reported_within_the_budget() -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(3)) >> out
    d = deploy({"A": ["from_iterable"], "B": ["to_list"]}, connect_timeout=2)
    t0 = time.monotonic()
    with pytest.raises(tq.PeerLost, match="not reachable"):
        tq.run(g, deploy=d, group="A")
    assert time.monotonic() - t0 < 10
    with pytest.raises(tq.PeerLost, match="never connected"):
        tq.run(g, deploy=d, group="B")


def test_shared_secret() -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(10)) >> out
    results = run_groups(g, deploy({"A": ["from_iterable"], "B": ["to_list"]}, secret="hunter2"))
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert out.items == list(range(10))
    # A sender with the wrong secret is refused at once.
    d_good = deploy({"A": ["from_iterable"], "B": ["to_list"]}, secret="right", connect_timeout=5)
    d_bad = {**d_good, "options": {**d_good["options"], "secret": "wrong"}}
    out = tq.to_list()
    g = tq.from_iterable(range(10)) >> out
    results: dict[str, Any] = {}

    def side(name: str, dep: dict[str, Any]) -> None:
        try:
            results[name] = tq.run(g, deploy=dep, group=name)
        except BaseException as exc:
            results[name] = exc

    ta = threading.Thread(target=side, args=("A", d_bad), daemon=True)
    tb = threading.Thread(target=side, args=("B", d_good), daemon=True)
    tb.start()
    ta.start()
    ta.join(30)
    tb.join(30)
    assert isinstance(results["A"], tq.PeerLost)
    assert "authentication failed" in str(results["A"])


def test_remote_group_can_use_processes() -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(40)) >> tq.farm(double, 2, name="w") >> out
    results = run_groups(
        g,
        deploy({"A": ["from_iterable", "w.emitter", "w.collector", "to_list"], "B": ["w.[0-9]*"]}),
        runtimes={"B": "processes"},
    )
    assert all(isinstance(r, tq.Report) for r in results.values()), results
    assert sorted(out.items) == [2 * i for i in range(40)]


def test_cli_run_with_deploy(tmp_path: Path) -> None:
    import subprocess

    flow = tmp_path / "flow.py"
    flow.write_text(
        "import tolquane as tq\n\n"
        "@tq.source\ndef numbers():\n    yield from range(5)\n\n"
        "@tq.node\ndef double(x):\n    return x * 2\n\n"
        "@tq.sink\ndef show(x):\n    print(x)\n\n"
        "def build(source=None):\n"
        "    start = tq.from_iterable(source) if source is not None else numbers\n"
        "    return start >> double >> show\n"
    )
    port_a, port_b = free_ports(2)
    (tmp_path / "deploy.toml").write_text(
        f'[groups.A]\nendpoint = "127.0.0.1:{port_a}"\nnodes = ["numbers", "double"]\n'
        f'[groups.B]\nendpoint = "127.0.0.1:{port_b}"\nnodes = ["show"]\n'
        "[options]\nconnect_timeout = 20\n"
    )
    procs = [
        subprocess.Popen(
            [
                sys.executable,
                "-m",
                "tolquane.cli",
                "run",
                "flow.py",
                "--deploy",
                "deploy.toml",
                "--group",
                g,
            ],
            cwd=tmp_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for g in ("A", "B")
    ]
    outs = [p.communicate(timeout=60) for p in procs]
    assert [p.returncode for p in procs] == [0, 0], outs
    assert outs[1][0].split() == ["0", "2", "4", "6", "8"]
