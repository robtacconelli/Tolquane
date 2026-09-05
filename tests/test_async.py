"""Async nodes: coroutine pools on an event loop inside the threads runtime."""

from __future__ import annotations

import asyncio
import json
import time

import pytest

import tolquane as tq


async def double(x: int) -> int:
    await asyncio.sleep(0)
    return x * 2


async def slow_double(x: int) -> int:
    await asyncio.sleep(0.05)
    return x * 2


async def evens(x: int) -> int:
    return x if x % 2 == 0 else tq.SKIP


async def pair(x: int):
    yield x
    await asyncio.sleep(0)
    yield -x


@tq.source
async def ticks():
    for i in range(5):
        await asyncio.sleep(0.001)
        yield i


class Total:
    def __init__(self) -> None:
        self.total = 0
        self.started = False

    async def on_start(self, ctx: tq.Context) -> None:
        self.started = True

    async def __call__(self, x: int):
        self.total += x
        return tq.SKIP

    async def on_end(self, ctx: tq.Context) -> None:
        ctx.send(self.total)


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_async_map(runtime: str) -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(10)) >> double >> out, runtime=runtime)
    assert out.items == [2 * i for i in range(10)]


def test_pool_runs_concurrently() -> None:
    out = tq.to_list()
    t0 = time.perf_counter()
    tq.run(tq.from_iterable(range(40)) >> tq.farm(slow_double, workers=40) >> out)
    elapsed = time.perf_counter() - t0
    assert sorted(out.items) == [2 * i for i in range(40)]
    assert elapsed < 1.0, elapsed  # 40 x 50 ms sequentially would be 2 s


def test_pool_respects_workers() -> None:
    in_flight = 0
    peak = 0

    async def probe(x: int) -> int:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return x

    tq.run(tq.from_iterable(range(30)) >> tq.farm(probe, workers=3) >> tq.to_list())
    assert peak == 3


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_ordered_pool(runtime: str) -> None:
    async def jitter(x: int) -> int:
        await asyncio.sleep(0.01 * (x % 3))
        return x

    out = tq.to_list()
    tq.run(tq.from_iterable(range(20)) >> tq.farm(jitter, 5, ordered=True) >> out, runtime=runtime)
    assert out.items == list(range(20))


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_pool_deadlock_is_still_reported(runtime: str) -> None:
    # A loop whose items multiply on edges of capacity one jams; the detector must name
    # the pool as idle (its coroutines are done) rather than wait for them forever.
    @tq.raw
    def multiply(ctx: tq.Context) -> None:
        for _, item in ctx.inputs():
            ctx.feedback(item)
            ctx.feedback(item)

    with pytest.raises(tq.DeadlockError, match="multiply"):
        tq.run(
            tq.from_iterable([1]) >> tq.feedback(tq.farm(double, 2) >> multiply) >> tq.to_list(),
            runtime=runtime,
            capacity=1,
            batch=1,
            deadlock_timeout=0.3,
        )


def test_skip_flat_and_source() -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(6)) >> evens >> out)
    assert out.items == [0, 2, 4]
    out = tq.to_list()
    tq.run(tq.from_iterable(range(3)) >> pair >> out)
    assert out.items == [0, 0, 1, -1, 2, -2]
    out = tq.to_list()
    tq.run(ticks >> out)
    assert out.items == [0, 1, 2, 3, 4]


def test_async_class_with_async_hooks() -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(1, 5)) >> tq.node(Total) >> out)
    assert out.items == [10]


def test_async_sink() -> None:
    seen: list[int] = []

    @tq.sink
    async def keep(x: int) -> None:
        seen.append(x)

    tq.run(tq.from_iterable(range(5)) >> keep)
    assert sorted(seen) == [0, 1, 2, 3, 4]


def test_error_names_the_node() -> None:
    async def boom(x: int) -> int:
        if x == 3:
            raise ValueError("three")
        return x

    with pytest.raises(tq.NodeError, match=r"boom.*three"):
        tq.run(tq.from_iterable(range(100)) >> tq.farm(boom, 4) >> tq.to_list())


def test_async_in_feedback_loop() -> None:
    async def step(state: tuple[int, int]) -> tuple[int, int]:
        n, x = state
        return n, x + 1

    @tq.node
    def route(state: tuple[int, int], ctx: tq.Context) -> None:
        n, x = state
        if x >= n:
            ctx.send(x)
        else:
            ctx.feedback(state)

    out = tq.to_list()
    tq.run(tq.from_iterable([(3, 0), (5, 0)]) >> tq.feedback(tq.farm(step, 2) >> route) >> out)
    assert sorted(out.items) == [3, 5]


def test_refusals() -> None:
    async def with_ctx(x: int, ctx: tq.Context) -> None:
        ctx.send(x)

    @tq.node
    def keep(x: int) -> int:
        return x

    with pytest.raises(tq.GraphError, match=r"takes \(item, ctx\)"):
        tq.check(tq.from_iterable([1]) >> with_ctx >> tq.to_list())
    with pytest.raises(tq.GraphError, match="comb"):
        tq.check(tq.from_iterable([1]) >> tq.comb(double, double) >> tq.to_list())
    with pytest.raises(tq.GraphError, match="one pool"):
        tq.check(tq.from_iterable([1]) >> tq.farm(double, 2, emit="on_demand") >> tq.to_list())
    with pytest.raises(tq.GraphError, match="same coroutine"):
        tq.check(tq.from_iterable([1]) >> tq.farm([double, evens]) >> tq.to_list())
    with pytest.raises(tq.GraphError, match="no emitter or collector"):
        tq.check(tq.from_iterable([1]) >> tq.farm(double, 2, collector=keep) >> tq.to_list())


def test_trace_file(tmp_path) -> None:
    path = tmp_path / "trace.json"
    tq.run(tq.from_iterable(range(100)) >> tq.farm(double, 2) >> tq.to_list(), trace=str(path))
    events = json.loads(path.read_text())["traceEvents"]
    names = {e["args"]["name"] for e in events if e["ph"] == "M"}
    assert {"from_iterable", "double", "to_list"} <= names  # a pool is one node
    runs = [e for e in events if e["ph"] == "X" and e["name"] == "node"]
    assert len(runs) == len(names)
    assert all(e["dur"] >= 0 for e in runs)
