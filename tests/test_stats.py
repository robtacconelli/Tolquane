"""Busy and wait times per node in the run report."""

from __future__ import annotations

import time

import pytest

import tolquane as tq


@tq.node
def slow(x: int) -> int:
    time.sleep(0.005)
    return x


@tq.node
def fast(x: int) -> int:
    return x


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_bottleneck_is_the_busiest_node(runtime: str) -> None:
    report = tq.run(
        tq.from_iterable(range(40)) >> fast >> slow >> tq.to_list(), runtime=runtime, capacity=4
    )
    s = report.nodes["slow"]
    assert s.busy >= 0.15
    assert s.busy_share > 0.8
    assert report.nodes["to_list"].wait_in > report.nodes["to_list"].busy
    assert report.busiest(1) == ["slow"]
    text = str(report)
    assert "busy" in text
    assert "wait-in" in text
    assert "wait-out" in text


def test_producer_blocked_on_output_shows_wait_out() -> None:
    report = tq.run(tq.from_iterable(range(40)) >> slow >> tq.to_list(), capacity=2)
    src = report.nodes["from_iterable"]
    assert src.wait_out > src.busy
    assert src.elapsed >= src.busy + src.wait_in + src.wait_out - 1e-6


def test_pool_waiting_on_coroutines_counts_as_busy() -> None:
    import asyncio

    async def nap(x: int) -> int:
        await asyncio.sleep(0.02)
        return x

    report = tq.run(tq.from_iterable(range(10)) >> tq.farm(nap, 2) >> tq.to_list())
    assert report.nodes["nap"].busy_share > 0.5
