"""The processes runtime: farm workers in child processes, the rest in the parent."""

import multiprocessing as mp
import os
import sys
import threading
import time

import pytest

import tolquane as tq

PARENT = os.getpid()


# Workers live at module level so that plain pickle can send them by reference.


def pid_of(x: int) -> tuple[int, int]:
    return os.getpid(), x


def double(x: int) -> int:
    return x * 2


def heavy(x: int) -> int:
    y = x
    for _ in range(3_000_000):  # about 0.1 s of pure Python per item
        y = y * 1000 // 999
    return y


def jitter(x: int) -> int:
    time.sleep((x % 5) * 0.0004)
    return x


def boom(x: int) -> int:
    if x == 7:
        raise ValueError("seven in a child")
    return x


def crash(x: int) -> int:
    if x == 3:
        os._exit(3)
    return x


def slow_first(x: int, ctx: tq.Context) -> None:
    if x == 0:
        time.sleep(1.0)
    ctx.send(x)


def with_index(x: int, ctx: tq.Context) -> None:
    ctx.send((ctx.index, os.getpid(), x))


def record_source(x: int, ctx: tq.Context) -> None:
    ctx.send((ctx.source, x))


def route_two(x: int, ctx: tq.Context) -> None:
    ctx.send(x, to=x % 2)


def inc(chunk: list[int]) -> list[int]:
    return [c + 1 for c in chunk]


def twice(x: int):  # type: ignore[no-untyped-def]
    yield x
    yield x


class Summer:
    def __init__(self) -> None:
        self.total = 0
        self.pid = os.getpid()

    def __call__(self, x: int) -> object:
        self.total += x
        return tq.SKIP

    def on_end(self, ctx: tq.Context) -> None:
        ctx.send((self.pid, self.total))


class Newton:
    """One Newton step on (n, x, change, iterations)."""

    def __call__(self, state: tuple) -> tuple:
        n, x, _, i = state
        nxt = 0.5 * (x + n / x)
        return (n, nxt, abs(nxt - x), i + 1)


def route_converged(state: tuple, ctx: tq.Context) -> None:
    if state[2] < 1e-9:
        ctx.send(state)
    else:
        ctx.feedback(state)


class Unpicklable:
    def __init__(self) -> None:
        self.lock = threading.Lock()

    def __call__(self, x: int) -> int:
        return x


# ----------------------------------------------------------------------------- basics


def test_workers_run_in_their_own_processes() -> None:
    out = tq.to_list()
    report = tq.run(tq.from_iterable(range(50)) >> tq.farm(pid_of, 4) >> out, runtime="processes")
    pids = {p for p, _ in out.items}
    assert sorted(x for _, x in out.items) == list(range(50))
    assert len(pids) == 4
    assert PARENT not in pids
    assert report.nodes["pid_of.0"].items_in + report.nodes["pid_of.1"].items_in <= 50
    assert not mp.active_children()


def test_every_policy_under_processes() -> None:
    data = list(range(60))
    for farm, expected, ordered in (
        (tq.farm(jitter, 3), data, False),
        (tq.farm(jitter, 3, emit="broadcast"), data * 3, False),
        (tq.farm(jitter, 3, ordered=True), data, True),
        (tq.farm(jitter, 3, collect="round_robin"), data, True),
        (tq.farm(jitter, 3, emit="on_demand"), data, False),
        (tq.farm(jitter, 3, key=lambda x: x % 7), data, False),
        (tq.farm(twice, 3, ordered=True), [x for x in data for _ in range(2)], True),
        (tq.farm(tq.comb(double, jitter), 3), [2 * x for x in data], False),
    ):
        out = tq.to_list()
        tq.run(tq.from_iterable(data) >> farm >> out, runtime="processes", capacity=8)
        assert sorted(out.items) == sorted(expected)
        if ordered:
            assert out.items == expected


def test_scatter_gather_under_processes() -> None:
    rows = [list(range(n)) for n in (10, 0, 3, 50)]
    out = tq.to_list()
    tq.run(tq.from_iterable(rows) >> tq.farm(inc, 4, emit="scatter") >> out, runtime="processes")
    assert out.items == [[v + 1 for v in r] for r in rows]


def test_class_workers_keep_state_in_the_child() -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(1, 101)) >> tq.farm(Summer, 4) >> out, runtime="processes")
    assert sum(t for _, t in out.items) == 5050
    assert len({p for p, _ in out.items}) == 4
    assert PARENT not in {p for p, _ in out.items}


def test_multi_input_remote_workers_keep_their_source_index() -> None:
    out = tq.to_list()
    g = (
        tq.from_iterable(range(30))
        >> tq.farm(route_two, 3, collector=False, name="L")
        >> tq.farm(record_source, 2, emitter=False, name="R")
        >> out
    )
    tq.run(g, runtime="processes")
    assert sorted(x for _, x in out.items) == list(range(30))
    assert {src for src, _ in out.items} == {0, 1, 2}


def test_feedback_loop_with_remote_workers() -> None:
    out = tq.to_list()
    g = (
        tq.from_iterable([(n, float(n), float("inf"), 0) for n in (2, 3, 5)])
        >> tq.feedback(tq.farm(Newton, 3, collector=route_converged))
        >> out
    )
    tq.run(g, runtime="processes")
    assert sorted(round(x, 9) for _, x, _, _ in out.items) == [
        round(2**0.5, 9),
        round(3**0.5, 9),
        round(5**0.5, 9),
    ]
    assert all(i > 3 for _, _, _, i in out.items)


def test_mixed_graph_and_sync_ignores_placement() -> None:
    out = tq.to_list()
    g = (
        tq.from_iterable(range(20))
        >> tq.farm(pid_of, 2, runtime="processes")
        >> tq.farm(double, 2)
        >> out
    )
    tq.run(g)  # threads run, one farm remote
    assert len(out.items) == 20
    graph = tq.check(g)
    assert graph.node("pid_of.0").remote
    assert not graph.node("double.0").remote
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(5)) >> tq.farm(pid_of, 2, runtime="processes") >> out, runtime="sync"
    )
    assert {p for p, _ in out.items} == {PARENT}


def test_session_with_processes() -> None:
    with tq.session(tq.farm(pid_of, 2), runtime="processes") as s:
        for i in range(4):
            s.put(i)
        got = [s.get(timeout=30) for _ in range(4)]
    assert sorted(x for _, x in got) == [0, 1, 2, 3]
    assert PARENT not in {p for p, _ in got}
    assert not mp.active_children()


# ----------------------------------------------------------------------------- failures


def test_exception_in_a_child_is_a_node_error_with_the_cause() -> None:
    with pytest.raises(tq.NodeError) as info:
        tq.run(
            tq.from_iterable(range(100)) >> tq.farm(boom, 3) >> tq.to_list(), runtime="processes"
        )
    assert info.value.node.startswith("boom.")
    assert isinstance(info.value.__cause__, ValueError)
    assert "seven in a child" in str(info.value)
    time.sleep(0.2)
    assert not mp.active_children()


def test_a_dying_child_is_reported() -> None:
    with pytest.raises(tq.WorkerDied, match="died without finishing"):
        tq.run(
            tq.from_iterable(range(100)) >> tq.farm(crash, 2) >> tq.to_list(), runtime="processes"
        )
    time.sleep(0.2)
    assert not mp.active_children()


def test_unpicklable_worker_gets_a_clear_error() -> None:
    with pytest.raises(tq.TolquaneError, match="cannot be sent to a process"):
        tq.run(
            tq.from_iterable(range(3)) >> tq.farm(Unpicklable(), 2) >> tq.to_list(),
            runtime="processes",
        )


def test_feedback_from_a_remote_worker_is_refused() -> None:
    g = (
        tq.from_iterable([1])
        >> tq.feedback(tq.farm(route_converged, 2, collector=False))
        >> tq.to_list()
    )
    with pytest.raises(tq.GraphError, match="sends feedback and cannot run in a process"):
        tq.run(g, runtime="processes")


def test_slow_child_is_not_a_deadlock() -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(6)) >> tq.farm(slow_first, 2) >> out,
        runtime="processes",
        deadlock_timeout=0.3,
    )
    assert sorted(out.items) == list(range(6))


def test_on_demand_gives_the_slow_child_fewer_items() -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(40)) >> tq.farm(slow_first, 3, emit="on_demand") >> out,
        runtime="processes",
    )
    assert sorted(out.items) == list(range(40))


# ----------------------------------------------------------------------------- speed


def test_processes_beat_the_gil() -> None:
    t0 = time.perf_counter()
    expected = [heavy(x) for x in range(16)]
    sequential = time.perf_counter() - t0
    out = tq.to_list()
    t0 = time.perf_counter()
    tq.run(tq.from_iterable(range(16)) >> tq.farm(heavy, 4) >> out, runtime="processes")
    parallel = time.perf_counter() - t0
    assert sorted(out.items) == sorted(expected)
    if sys.platform.startswith("linux"):
        assert parallel < 0.8 * sequential, (sequential, parallel)
