"""Every liveness rule has a test here. Each one runs under the pytest timeout."""

import threading
import time

import pytest

import tolquane as tq


def _threads_settled() -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not [t for t in threading.enumerate() if t.name.startswith("tolquane:")]:
            return
        time.sleep(0.01)
    raise AssertionError("tolquane threads still alive")


def test_exception_in_worker_cancels_the_run(runtime: str) -> None:
    @tq.node
    def boom(x: int) -> int:
        if x == 7:
            raise ValueError("seven")
        return x

    with pytest.raises(tq.NodeError) as info:
        tq.run(
            tq.from_iterable(range(100_000)) >> tq.farm(boom, 3) >> tq.to_list(), runtime=runtime
        )
    assert info.value.node.startswith("boom.")
    assert isinstance(info.value.__cause__, ValueError)
    _threads_settled()


def test_exception_in_source_and_in_on_end(runtime: str) -> None:
    @tq.source
    def bad():  # type: ignore[no-untyped-def]
        yield 1
        raise RuntimeError("source broke")

    with pytest.raises(tq.NodeError, match="source broke"):
        tq.run(bad >> tq.to_list(), runtime=runtime)

    class Ender:
        def __call__(self, x: int) -> int:
            return x

        def on_end(self, ctx: tq.Context) -> None:
            raise RuntimeError("end broke")

    with pytest.raises(tq.NodeError, match="end broke"):
        tq.run(tq.from_iterable([1]) >> tq.node(Ender) >> tq.to_list(), runtime=runtime)
    _threads_settled()


def test_two_failures_become_an_exception_group() -> None:
    @tq.node
    def boom(x: int) -> int:
        time.sleep(0.01)
        raise ValueError(f"w{x}")

    with pytest.raises(ExceptionGroup) as info:
        tq.run(tq.from_iterable(range(4)) >> tq.farm(boom, 4, emit="broadcast") >> tq.to_list())
    assert all(isinstance(e, tq.NodeError) for e in info.value.exceptions)
    _threads_settled()


def test_keyboard_interrupt_in_a_node_propagates(runtime: str) -> None:
    @tq.node
    def ctrl_c(x: int) -> int:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        tq.run(tq.from_iterable(range(10)) >> ctrl_c >> tq.to_list(), runtime=runtime)
    _threads_settled()


def test_every_output_is_closed_when_a_node_finishes(runtime: str) -> None:
    # A map node with three outputs (1xN). BBFlow closed only output 0 here.
    out = tq.to_list()
    report = tq.run(
        tq.from_iterable(range(9))
        >> tq.node(lambda x: x, name="fan")
        >> tq.farm(lambda x: x, 3, emitter=False)
        >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == list(range(9))
    assert all(report.nodes[f"lambda.{i}"].items_in == 3 for i in range(3))


def test_slow_consumer_under_broadcast_applies_backpressure(runtime: str) -> None:
    @tq.node
    def slow(x: int, ctx: tq.Context) -> None:
        if ctx.index == 0:
            time.sleep(0.001)
        ctx.send(x)

    out = tq.to_list()
    report = tq.run(
        tq.from_iterable(range(50)) >> tq.farm(slow, 3, emit="broadcast") >> out,
        runtime=runtime,
        capacity=2,
    )
    assert len(out.items) == 150
    assert all(hw <= 3 for hw in report.edges.values())  # capacity plus the EOS marker


def _selective_graph(out: tq.ListSink) -> tq.Block:
    @tq.node
    def split(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=0)
        ctx.send(x, to=1)

    @tq.raw
    def one_source_first(ctx: tq.Context) -> None:
        # Drains source 1 completely before touching source 0. Items from source 0 are
        # buffered while holding their credit, so worker 0 blocks after `capacity` items.
        while (r := ctx.recv(source=1)) is not None:
            ctx.send(("b", r[1]))
        for _, item in ctx.inputs():
            ctx.send(("a", item))

    return (
        tq.from_iterable(range(50))
        >> tq.farm(lambda x: x, 2, emitter=split, collector=one_source_first)
        >> out
    )


def test_selective_recv_completes_when_buffers_fit(runtime: str) -> None:
    out = tq.to_list()
    report = tq.run(_selective_graph(out), runtime=runtime, capacity=64)
    assert out.items == [("b", i) for i in range(50)] + [("a", i) for i in range(50)]
    assert report.edges[("lambda.0", "lambda.collector")] <= 51
    _threads_settled()


def test_selective_recv_starvation_is_detected(runtime: str) -> None:
    # With capacity 2 the buffered source-0 items hold their credits, worker 0 fills up,
    # the round-robin emitter blocks on it, and source 1 starves: a real cycle.
    out = tq.to_list()
    with pytest.raises(tq.DeadlockError) as info:
        tq.run(_selective_graph(out), runtime=runtime, capacity=2)
    msg = str(info.value)
    assert "lambda.collector: waiting for input from lambda.0, lambda.1" in msg
    assert "lambda.emitter: sending to 'lambda.0' (queue full, capacity 2)" in msg
    _threads_settled()


def test_deadlock_is_reported_not_hung(runtime: str) -> None:
    from tolquane.graph import EdgeSpec, NodeSpec

    @tq.raw
    def chatty(ctx: tq.Context) -> None:
        # Sends before it reads. Two of these in a cycle block each other for ever.
        for i in range(10):
            ctx.send(i)
        for _ in ctx.inputs():
            pass

    cycle = tq.Graph(
        nodes=[NodeSpec("a", "raw", chatty.target), NodeSpec("b", "raw", chatty.target)],
        edges=[EdgeSpec("a", "b", "1-1"), EdgeSpec("b", "a", "1-1")],
    )
    with pytest.raises(tq.DeadlockError) as info:
        tq.run(cycle, runtime=runtime, capacity=2)
    msg = str(info.value)
    assert "a: sending to 'b' (queue full, capacity 2)" in msg
    assert "b: sending to 'a' (queue full, capacity 2)" in msg
    assert "fix:" in msg
    _threads_settled()


def test_send_after_close_raises(runtime: str) -> None:
    holder: dict[str, tq.Context] = {}

    @tq.raw
    def keep_ctx(ctx: tq.Context) -> None:
        holder["ctx"] = ctx
        ctx.send(1)

    tq.run(keep_ctx >> tq.to_list(), runtime=runtime)
    with pytest.raises(tq.ChannelClosed):
        holder["ctx"].send(2)


def test_gather_with_dropped_parts_does_not_hang(runtime: str) -> None:
    @tq.node
    def drop_small(chunk: list[int]) -> list[int]:
        return tq.SKIP if len(chunk) < 3 else chunk

    out = tq.to_list()
    tq.run(
        tq.from_iterable([list(range(10))]) >> tq.farm(drop_small, 4, emit="scatter") >> out,
        runtime=runtime,
    )
    assert out.items == [[0, 1, 2, 3, 4, 5]]


def test_ordered_window_bounds_in_flight_items(runtime: str) -> None:
    @tq.node
    def slow_first(x: int, ctx: tq.Context) -> None:
        if x == 0:
            time.sleep(0.05)
        ctx.send(x)

    out = tq.to_list()
    report = tq.run(
        tq.from_iterable(range(40)) >> tq.farm(slow_first, 4, ordered=True, window=4) >> out,
        runtime=runtime,
        capacity=None,
    )
    assert out.items == list(range(40))
    assert all(hw <= 5 for (src, _), hw in report.edges.items() if src == "slow_first.emitter")


def test_early_stop_wakes_blocked_producers(runtime: str) -> None:
    @tq.sink
    def one(x: int, ctx: tq.Context) -> None:
        ctx.stop()

    report = tq.run(
        tq.from_iterable(range(10_000)) >> tq.farm(lambda x: x, 4) >> one,
        runtime=runtime,
        capacity=2,
    )
    assert report.nodes["one"].items_in == 1
    _threads_settled()


def test_thread_runtime_does_not_flag_slow_user_code_as_deadlock() -> None:
    @tq.node
    def slow(x: int) -> int:
        time.sleep(0.5)
        return x

    out = tq.to_list()
    tq.run(tq.from_iterable([1]) >> slow >> out, deadlock_timeout=0.2)
    assert out.items == [1]
