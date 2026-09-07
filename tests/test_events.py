"""Live run events: progress snapshots, taps, stopping a run, and the CLI's JSON lines."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

import tolquane as tq

# Workers live at module level so the processes runtime can send them by reference.


def slow_double(x: int) -> int:
    time.sleep(0.01)
    return x * 2


def double(x: int) -> int:
    return x * 2


@tq.node
def double_node(x: int) -> int:
    return x * 2


def _cycle_graph() -> tq.Graph:
    """Two nodes that both send before they read: a real deadlock."""
    from tolquane.graph import EdgeSpec, NodeSpec

    def chatty(ctx: tq.Context) -> None:
        for i in range(10):
            ctx.send(i)
        for _ in ctx.inputs():
            pass

    return tq.Graph(
        nodes=[NodeSpec("a", "raw", chatty), NodeSpec("b", "raw", chatty)],
        edges=[EdgeSpec("a", "b", "1-1"), EdgeSpec("b", "a", "1-1")],
    )


# --------------------------------------------------------------------------- snapshots


@pytest.mark.parametrize("runtime", ["threads", "sync", "processes"])
def test_snapshots_arrive_on_every_runtime(runtime: str) -> None:
    snaps: list[tq.Progress] = []
    out = tq.to_list()
    report = tq.run(
        tq.from_iterable(range(30)) >> tq.farm(slow_double, 2) >> out,
        runtime=runtime,
        on_progress=snaps.append,
        progress_interval=0.05,
    )
    assert sorted(out.items) == [2 * i for i in range(30)]
    assert len(snaps) >= 2  # at least one while it ran, and the one at the end
    assert [s.phase for s in snaps[:-1]] == ["running"] * (len(snaps) - 1)
    last = snaps[-1]
    assert last.phase == "done"
    assert last.elapsed > 0
    # A remote worker's proxy is a node like any other.
    assert set(last.nodes) == set(report.nodes)
    assert last.nodes["from_iterable"].items_out == 30
    assert last.nodes["from_iterable"].state == "done"
    assert sum(last.nodes[f"slow_double.{i}"].items_in for i in range(2)) == 30
    assert last.edges["slow_double.emitter->slow_double.0"].capacity == 1024
    assert all(e.queued == 0 for e in last.edges.values())
    assert any(e.high_water > 0 for e in last.edges.values())


def test_a_snapshot_of_a_running_graph_says_what_each_node_is_doing() -> None:
    seen: list[tq.Progress] = []

    def hold(x: int) -> int:
        time.sleep(0.2)
        return x

    tq.run(
        tq.from_iterable(range(4)) >> hold >> tq.to_list(),
        capacity=1,
        on_progress=seen.append,
        progress_interval=0.05,
    )
    running = [s for s in seen if s.phase == "running"]
    assert running
    mid = running[len(running) // 2]
    states = {n.state for n in mid.nodes.values()}
    assert states <= {"new", "running", "waiting", "done", "failed"}
    waiting = [n for n in mid.nodes.values() if n.state == "waiting"]
    assert waiting, "with a slow middle stage its neighbours must be waiting"
    assert {n.reason for n in waiting} <= {"input", "output", "window", "loop"}
    assert all(n.detail for n in waiting)
    assert mid.nodes["hold"].busy > 0


# --------------------------------------------------------------------------- end phase


def test_the_last_snapshot_says_the_run_is_done(runtime: str) -> None:
    snaps: list[tq.Progress] = []
    tq.run(
        tq.from_iterable(range(5)) >> double_node >> tq.to_list(),
        runtime=runtime,
        on_progress=snaps.append,
    )
    assert snaps[-1].phase == "done"


def test_the_last_snapshot_says_the_run_failed(runtime: str) -> None:
    @tq.node
    def boom(x: int) -> int:
        if x == 3:
            raise ValueError("three is bad")
        return x

    snaps: list[tq.Progress] = []
    with pytest.raises(tq.NodeError):
        tq.run(
            tq.from_iterable(range(10)) >> boom >> tq.to_list(),
            runtime=runtime,
            on_progress=snaps.append,
        )
    assert snaps[-1].phase == "failed"
    assert snaps[-1].nodes["boom"].state == "failed"


def test_the_last_snapshot_says_the_run_deadlocked(runtime: str) -> None:
    snaps: list[tq.Progress] = []
    with pytest.raises(tq.DeadlockError):
        tq.run(_cycle_graph(), runtime=runtime, capacity=2, on_progress=snaps.append)
    assert snaps[-1].phase == "deadlock"


def test_the_last_snapshot_says_the_run_was_cancelled() -> None:
    snaps: list[tq.Progress] = []
    stop = threading.Event()
    with pytest.raises(tq.RunCancelled):
        tq.run(_endless(), stop=stop, on_progress=_stop_after(snaps, stop, 2))
    assert snaps[-1].phase == "cancelled"
    assert [s.phase for s in snaps[:-1]] == ["running"] * (len(snaps) - 1)


# --------------------------------------------------------------------------- taps


def test_taps_keep_the_last_items_that_crossed_each_edge(runtime: str) -> None:
    snaps: list[tq.Progress] = []
    tq.run(
        tq.from_iterable(range(10)) >> double_node >> tq.to_list(),
        runtime=runtime,
        tap=3,
        on_progress=snaps.append,
    )
    edges = snaps[-1].edges
    assert edges["from_iterable->double_node"].taps == ["7", "8", "9"]
    assert edges["double_node->to_list"].taps == ["14", "16", "18"]


def test_taps_stay_empty_when_tap_is_zero(runtime: str) -> None:
    snaps: list[tq.Progress] = []
    tq.run(
        tq.from_iterable(range(10)) >> double_node >> tq.to_list(),
        runtime=runtime,
        on_progress=snaps.append,
    )
    assert all(e.taps == [] for e in snaps[-1].edges.values())
    assert any(e.high_water > 0 for e in snaps[-1].edges.values())


def test_a_tap_shows_an_item_as_it_was_sent_not_as_it_ended_up() -> None:
    item = {"n": 1}

    @tq.sink
    def mutate(d: dict[str, int]) -> None:
        d["n"] = 999

    snaps: list[tq.Progress] = []
    tq.run(tq.from_iterable([item]) >> mutate, tap=1, on_progress=snaps.append)
    assert snaps[-1].edges["from_iterable->mutate"].taps == ["{'n': 1}"]
    assert item["n"] == 999


def test_a_tapped_item_is_cut_to_200_characters() -> None:
    snaps: list[tq.Progress] = []
    tq.run(tq.from_iterable(["x" * 1000]) >> tq.to_list(), tap=1, on_progress=snaps.append)
    (tapped,) = snaps[-1].edges["from_iterable->to_list"].taps
    assert len(tapped) == 200


def test_taps_follow_a_farm_worker_to_its_own_process() -> None:
    snaps: list[tq.Progress] = []
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(6)) >> tq.farm(double, 2) >> out,
        runtime="processes",
        tap=5,
        on_progress=snaps.append,
    )
    assert sorted(out.items) == [0, 2, 4, 6, 8, 10]
    crossed = [
        t
        for key, e in snaps[-1].edges.items()
        if key.endswith("->double.collector")
        for t in e.taps
    ]
    assert sorted(int(t) for t in crossed) == [0, 2, 4, 6, 8, 10]


# --------------------------------------------------------------------------- stopping


def _endless() -> Any:
    @tq.source
    def endless():  # type: ignore[no-untyped-def]
        i = 0
        while True:
            yield i
            i += 1

    @tq.sink
    def swallow(x: int) -> None:
        pass

    return endless >> swallow


def _stop_after(snaps: list[tq.Progress], stop: threading.Event, n: int) -> Any:
    """A callback that records snapshots and sets ``stop`` once ``n`` have arrived."""

    def on_progress(p: tq.Progress) -> None:
        snaps.append(p)
        if len(snaps) >= n:
            stop.set()

    return on_progress


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_stop_ends_a_run_that_would_never_end_by_itself(runtime: str) -> None:
    stop = threading.Event()
    stopped_at: list[float] = []

    def on_progress(p: tq.Progress) -> None:
        if not stopped_at:
            stopped_at.append(time.perf_counter())
            stop.set()

    t0 = time.perf_counter()
    with pytest.raises(tq.RunCancelled, match="stopped"):
        tq.run(
            _endless(),
            runtime=runtime,
            capacity=8,
            deadlock_timeout=0.3,
            stop=stop,
            on_progress=on_progress,
            progress_interval=0.05,
        )
    ended = time.perf_counter()
    assert ended - t0 < 10  # it would otherwise run for ever
    # Generous: what is already queued is still worked through, as after a failure.
    assert ended - stopped_at[0] < 2.0


def test_a_stop_set_before_the_run_starts_cancels_it_at_once() -> None:
    stop = threading.Event()
    stop.set()
    with pytest.raises(tq.RunCancelled):
        tq.run(tq.from_iterable(range(10)) >> double_node >> tq.to_list(), stop=stop)


def test_a_source_whose_sends_are_all_dropped_still_notices_the_stop() -> None:
    """The consumer is gone, so nothing blocks the source: it has to be told to stop."""

    @tq.source
    def endless():  # type: ignore[no-untyped-def]
        i = 0
        while True:
            yield i
            i += 1

    @tq.sink
    def take_one(x: int, ctx: tq.Context) -> None:
        ctx.stop()  # this node ends at once and its inbox drops everything after

    stop = threading.Event()
    started = time.perf_counter()
    with pytest.raises(tq.RunCancelled):
        tq.run(
            endless >> take_one,
            stop=stop,
            on_progress=_stop_after([], stop, 1),
            progress_interval=0.05,
        )
    assert time.perf_counter() - started < 3  # a spinning source would hold the join up


def test_a_failure_is_reported_rather_than_the_cancellation_it_caused() -> None:
    stop = threading.Event()

    @tq.node
    def boom(x: int) -> int:
        stop.set()
        raise ValueError("boom")

    snaps: list[tq.Progress] = []
    with pytest.raises(tq.NodeError, match="boom"):
        tq.run(
            tq.from_iterable(range(10)) >> boom >> tq.to_list(),
            stop=stop,
            on_progress=snaps.append,
        )
    assert snaps[-1].phase == "failed"


def test_a_session_takes_a_stop_event() -> None:
    stop = threading.Event()

    def feed() -> None:
        with tq.session(double_node, stop=stop) as s:
            s.put(1)
            assert s.get(timeout=5) == 2
            stop.set()

    with pytest.raises(tq.RunCancelled):
        feed()


# --------------------------------------------------------------------------- the report


def test_report_to_dict_is_json_ready() -> None:
    out = tq.to_list()
    report = tq.run(tq.from_iterable(range(10)) >> double_node >> out)
    data = report.to_dict()
    assert json.loads(json.dumps(data)) == data
    assert data["runtime"] == "threads"
    assert data["elapsed"] > 0
    assert data["nodes"]["double_node"]["items_in"] == 10
    assert data["nodes"]["double_node"]["items_out"] == 10
    assert 0.0 <= data["nodes"]["double_node"]["busy_share"] <= 1.0
    assert data["edges"]["from_iterable->double_node"] >= 1
    assert data["busiest"] == report.busiest(3)


def test_progress_to_dict_is_json_ready() -> None:
    snaps: list[tq.Progress] = []
    tq.run(
        tq.from_iterable(range(4)) >> double_node >> tq.to_list(), tap=2, on_progress=snaps.append
    )
    data = snaps[-1].to_dict()
    assert json.loads(json.dumps(data)) == data
    assert data["phase"] == "done"
    assert data["nodes"]["double_node"]["state"] == "done"
    assert data["edges"]["from_iterable->double_node"]["taps"] == ["2", "3"]


def test_bad_progress_options_are_refused() -> None:
    block = tq.from_iterable(range(2)) >> tq.to_list()
    with pytest.raises(tq.TolquaneError, match="progress_interval"):
        tq.run(block, progress_interval=0)
    with pytest.raises(tq.TolquaneError, match="tap"):
        tq.run(block, tap=-1)


# --------------------------------------------------------------------------- the CLI

WORKING_FLOW = '''
"""A flow that prints once, near the end."""

import time

import tolquane as tq


@tq.node
def double(x):
    time.sleep(0.02)
    return x * 2


@tq.sink
def show(x):
    if x == 38:
        print(f"got {x}")


def build(source=None):
    items = source if source is not None else range(20)
    return tq.from_iterable(items) >> tq.farm(double, 2) >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

FAILING_FLOW = '''
"""A flow whose node raises."""

import sys

import tolquane as tq


@tq.node
def boom(x):
    print("about to fail", file=sys.stderr)
    raise ValueError("three is bad")


def build(source=None):
    return tq.from_iterable(range(3)) >> boom >> tq.to_list()


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

ENDLESS_FLOW = '''
"""A flow that never ends by itself."""

import tolquane as tq


@tq.source
def endless():
    i = 0
    while True:
        yield i
        i += 1


@tq.sink
def swallow(x):
    pass


def build(source=None):
    return endless >> swallow


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''


DEADLOCK_FLOW = '''
"""A flow whose two nodes both send before they read."""

import tolquane as tq
from tolquane.graph import EdgeSpec, NodeSpec


def chatty(ctx):
    for i in range(2000):
        ctx.send(i)
    for _ in ctx.inputs():
        pass


def build(source=None):
    return tq.Graph(
        nodes=[NodeSpec("a", "raw", chatty), NodeSpec("b", "raw", chatty)],
        edges=[EdgeSpec("a", "b", "1-1"), EdgeSpec("b", "a", "1-1")],
    )


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''


def _write(tmp_path: Path, name: str, source: str) -> Path:
    path = tmp_path / name
    path.write_text(source)
    return path


def _command(flow: Path, *extra: str) -> list[str]:
    return [sys.executable, "-m", "tolquane", "run", str(flow), "--events", *extra]


def _events(text: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in text.splitlines()]


def _first(kinds: list[str], name: str) -> int:
    assert name in kinds, f"no {name!r} event in {kinds}"
    return kinds.index(name)


def test_events_report_a_whole_run_as_json_lines(tmp_path: Path) -> None:
    flow = _write(tmp_path, "flow.py", WORKING_FLOW)
    done = subprocess.run(
        _command(flow, "--progress-interval", "0.05", "--tap", "2"),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    events = _events(done.stdout)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "start"
    assert kinds[-1] == "done"
    wanted = ["start", "progress", "stdout", "report", "done"]
    assert [_first(kinds, name) for name in wanted] == sorted(_first(kinds, n) for n in wanted)

    start = events[0]
    assert start["runtime"] == "threads"
    assert start["flow"] == str(flow)
    names = [n["name"] for n in start["graph"]["nodes"]]
    assert names == [
        "from_iterable",
        "double.emitter",
        "double.0",
        "double.1",
        "double.collector",
        "show",
    ]
    assert start["graph"]["nodes"][0]["kind"] == "source"
    assert start["graph"]["nodes"][-1]["is_sink"] is True
    assert {
        "src": "double.collector",
        "dst": "show",
        "rule": "1-1",
        "feedback": False,
        "capacity": None,
        "batch": None,
    } in start["graph"]["edges"]
    assert start["graph"]["loops"] == []
    assert start["graph"]["windows"] == {}

    printed = [e["text"] for e in events if e["event"] == "stdout"]
    assert printed == ["got 38\n"]
    snapshot = next(e["progress"] for e in events if e["event"] == "progress")
    assert snapshot["phase"] == "running"
    assert "double.emitter->double.0" in snapshot["edges"]
    assert [e["progress"]["phase"] for e in events if e["event"] == "progress"][-1] == "done"
    report = next(e["report"] for e in events if e["event"] == "report")
    assert report["nodes"]["show"]["items_in"] == 20
    assert events[-1] == {"event": "done", "status": "done", "elapsed": events[-1]["elapsed"]}
    assert events[-1]["elapsed"] > 0


def test_events_report_a_failing_flow(tmp_path: Path) -> None:
    flow = _write(tmp_path, "boom.py", FAILING_FLOW)
    done = subprocess.run(_command(flow), capture_output=True, text=True, timeout=60)
    assert done.returncode == 1
    events = _events(done.stdout)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "start"
    assert _first(kinds, "error") < _first(kinds, "done")
    error = next(e for e in events if e["event"] == "error")
    assert error["type"] == "NodeError"
    assert "three is bad" in error["message"]
    assert error["node"] == "boom"
    assert "ValueError: three is bad" in error["traceback"]
    assert [e["text"] for e in events if e["event"] == "stderr"] == ["about to fail\n"]
    assert events[-1]["status"] == "failed"
    assert "report" not in kinds
    assert [e["progress"]["phase"] for e in events if e["event"] == "progress"][-1] == "failed"


def test_a_missing_flow_is_an_error_event(tmp_path: Path) -> None:
    done = subprocess.run(
        _command(tmp_path / "nowhere.py"), capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 1
    events = _events(done.stdout)
    assert events[0]["event"] == "error"
    assert "no such file" in events[0]["message"]
    assert events[-1]["status"] == "failed"


def test_events_report_a_deadlock(tmp_path: Path) -> None:
    flow = _write(tmp_path, "stuck.py", DEADLOCK_FLOW)
    done = subprocess.run(
        _command(flow, "--progress-interval", "0.05"), capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 1
    events = _events(done.stdout)
    kinds = [e["event"] for e in events]
    assert _first(kinds, "deadlock") < _first(kinds, "done")
    message = next(e["message"] for e in events if e["event"] == "deadlock")
    assert message.startswith("deadlock:")
    assert "a: " in message
    assert "b: " in message
    assert events[-1]["status"] == "deadlock"
    assert [e["progress"]["phase"] for e in events if e["event"] == "progress"][-1] == "deadlock"


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no SIGTERM: terminate kills")
def test_sigterm_cancels_the_run_and_exits_130(tmp_path: Path) -> None:
    flow = _write(tmp_path, "endless.py", ENDLESS_FLOW)
    child = subprocess.Popen(
        _command(flow, "--progress-interval", "0.05"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            line = child.stdout.readline()
            assert line, "the child ended before it reported any progress"
            if json.loads(line)["event"] == "progress":
                break
        else:  # pragma: no cover - only on a machine that never scheduled the child
            pytest.fail("no progress event arrived")
        child.send_signal(signal.SIGTERM)
        rest, _ = child.communicate(timeout=20)
    finally:
        if child.poll() is None:  # pragma: no cover - only if the signal was ignored
            child.kill()
            child.communicate()
    assert child.returncode == 130
    events = _events(rest)
    assert events[-1]["event"] == "done"
    assert events[-1]["status"] == "cancelled"
    assert [e["progress"]["phase"] for e in events if e["event"] == "progress"][-1] == "cancelled"


# --------------------------------------------------------------------------- overhead


def _pipeline_seconds(n: int, **options: Any) -> float:
    """The two-node pipeline of ``benchmarks/pipeline2.py``, timed."""

    @tq.source
    def produce():  # type: ignore[no-untyped-def]
        yield from range(1, n + 1)

    class Consume:
        def __init__(self) -> None:
            self.total = 0

        def __call__(self, x: int) -> None:
            self.total += x * 2

    started = time.perf_counter()
    tq.run(produce >> tq.sink(Consume), capacity=1024, batch=1, **options)
    return time.perf_counter() - started


@pytest.mark.timeout(120)
def test_watching_a_run_barely_slows_it_down() -> None:
    n = 300_000
    _pipeline_seconds(20_000)  # warm the interpreter up
    plain = sorted(_pipeline_seconds(n) for _ in range(3))
    snaps: list[tq.Progress] = []
    watched = sorted(
        _pipeline_seconds(n, on_progress=snaps.append, progress_interval=0.5) for _ in range(3)
    )
    assert snaps, "the run was too short to be watched at all"
    spread = (plain[-1] - plain[0]) / plain[0]
    if spread > 0.25:
        pytest.skip(
            f"this machine is too busy to measure the difference: identical runs "
            f"differ by {spread:.0%}"
        )
    # The measured cost is under one percent (benchmarks/README.md); the bound only has
    # to catch a regression. A shared CI runner varies by more than that between two
    # identical runs, so it gets the looser bound.
    allowed = 1.25 if os.environ.get("CI") else 1.10
    assert watched[0] < plain[0] * allowed, (
        f"watching cost {watched[0] / plain[0] - 1:.1%}: plain {plain}, watched {watched}"
    )
