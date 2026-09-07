"""Batching: identical results for every policy, bounded latency, credits balanced."""

import random
import time

import pytest

import tolquane as tq


@pytest.mark.parametrize("batch", [1, 7, 64])
def test_every_policy_gives_the_same_result_with_batches(runtime: str, batch: int) -> None:
    @tq.node
    def jitter(x: int) -> int:
        time.sleep(random.random() * 0.0005)
        return x

    data = list(range(200))
    for farm in (
        tq.farm(jitter, 3),
        tq.farm(jitter, 3, emit="broadcast"),
        tq.farm(jitter, 3, ordered=True),
        tq.farm(jitter, 3, collect="round_robin"),
        tq.farm(jitter, 3, emit="on_demand"),
        tq.farm(jitter, 3, key=lambda x: x % 5),
    ):
        out = tq.to_list()
        report = tq.run(
            tq.from_iterable(data) >> farm >> out, runtime=runtime, batch=batch, capacity=16
        )
        expected = data * 3 if farm.emit == "broadcast" else data
        assert sorted(out.items) == sorted(expected)
        if farm.collect in ("ordered", "round_robin"):
            assert out.items == data
        assert report.nodes["jitter.emitter"].items_in == 200


def test_scatter_gather_with_batches(runtime: str) -> None:
    out = tq.to_list()
    rows = [list(range(n)) for n in (10, 0, 3, 50)]
    tq.run(
        tq.from_iterable(rows) >> tq.farm(lambda c: [v + 1 for v in c], 4, emit="scatter") >> out,
        runtime=runtime,
        batch=8,
    )
    assert out.items == [[v + 1 for v in r] for r in rows]


def test_partial_batches_are_flushed_promptly() -> None:
    """A slow source with a big batch must not hold items for long."""
    arrivals: list[float] = []

    @tq.source
    def slow():  # type: ignore[no-untyped-def]
        for i in range(5):
            time.sleep(0.02)
            yield (i, time.perf_counter())

    @tq.sink
    def stamp(item: tuple[int, float]) -> None:
        arrivals.append(time.perf_counter() - item[1])

    tq.run(slow >> stamp, batch=1000)
    assert len(arrivals) == 5
    assert max(arrivals) < 0.05  # a shared CI runner can be slow to reschedule a thread


def test_batches_keep_backpressure(runtime: str) -> None:
    @tq.node
    def slow(x: int) -> int:
        time.sleep(0.0005)
        return x

    out = tq.to_list()
    report = tq.run(
        tq.from_iterable(range(500)) >> slow >> out, runtime=runtime, batch=64, capacity=128
    )
    assert out.items == list(range(500))
    # High-water marks count items: credits keep the queue within the capacity.
    assert report.edges[("from_iterable", "slow")] <= 128


def test_stop_with_pending_batches(runtime: str) -> None:
    got: list[int] = []

    @tq.sink
    def some(x: int, ctx: tq.Context) -> None:
        got.append(x)
        if len(got) == 10:
            ctx.stop()

    tq.run(
        tq.from_iterable(range(10_000)) >> tq.farm(lambda x: x, 2) >> some,
        runtime=runtime,
        batch=32,
    )
    assert len(got) == 10


def test_batch_option_is_validated() -> None:
    with pytest.raises(tq.TolquaneError, match="batch must be at least 1"):
        tq.run(tq.from_iterable([1]) >> tq.to_list(), batch=0)
