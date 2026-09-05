"""End-to-end behaviour on both runtimes."""

import random
import threading
import time

import pytest

import tolquane as tq


@tq.node
def double(x: int) -> int:
    return x * 2


def test_hello_world(runtime: str) -> None:
    out = tq.to_list()

    @tq.source
    def numbers():  # type: ignore[no-untyped-def]
        yield from range(1, 101)

    report = tq.run(numbers >> tq.farm(double, workers=4) >> out, runtime=runtime)
    assert sorted(out.items) == [2 * i for i in range(1, 101)]
    assert report.nodes["numbers"].items_out == 100
    assert report.nodes["to_list"].items_in == 100
    assert sum(report.nodes[f"double.{i}"].items_in for i in range(4)) == 100
    assert "run on" in str(report)


def test_none_is_a_value_and_skip_drops(runtime: str) -> None:
    out = tq.to_list()

    @tq.node
    def keep_even(x: int) -> int | None:
        if x % 2:
            return tq.SKIP
        return None if x == 0 else x

    tq.run(tq.from_iterable(range(6)) >> keep_even >> out, runtime=runtime)
    assert out.items == [None, 2, 4]


def test_generator_node_is_flat_map(runtime: str) -> None:
    out = tq.to_list()

    @tq.node
    def words(line: str):  # type: ignore[no-untyped-def]
        yield from line.split()

    tq.run(tq.from_iterable(["a b", "", "c"]) >> words >> out, runtime=runtime)
    assert out.items == ["a", "b", "c"]


def test_ctx_node_sends_and_may_not_return(runtime: str) -> None:
    out = tq.to_list()

    @tq.node
    def twice(x: int, ctx: tq.Context) -> None:
        ctx.send(x)
        ctx.send(x)

    tq.run(tq.from_iterable([1, 2]) >> twice >> out, runtime=runtime)
    assert out.items == [1, 1, 2, 2]

    @tq.node
    def wrong(x: int, ctx: tq.Context) -> int:
        return x

    with pytest.raises(tq.NodeError, match=r"must send with ctx\.send"):
        tq.run(tq.from_iterable([1]) >> wrong >> out, runtime=runtime)


def test_class_workers_get_one_instance_each_with_hooks(runtime: str) -> None:
    started: list[int] = []
    ended: list[tuple[int, int]] = []
    lock = threading.Lock()

    class Counter:
        def __init__(self) -> None:
            self.n = 0

        def on_start(self, ctx: tq.Context) -> None:
            with lock:
                started.append(ctx.index)

        def __call__(self, x: int) -> int:
            self.n += 1
            return x

        def on_end(self, ctx: tq.Context) -> None:
            with lock:
                ended.append((ctx.index, self.n))

    out = tq.to_list()
    tq.run(tq.from_iterable(range(10)) >> tq.farm(Counter, 3) >> out, runtime=runtime)
    assert sorted(started) == [0, 1, 2]
    assert sum(n for _, n in ended) == 10
    assert len(out.items) == 10


def test_on_end_can_send(runtime: str) -> None:
    class Summer:
        def __init__(self) -> None:
            self.total = 0

        def __call__(self, x: int) -> object:
            self.total += x
            return tq.SKIP  # nothing per item; the total goes out in on_end

        def on_end(self, ctx: tq.Context) -> None:
            ctx.send(self.total)

    out = tq.to_list()
    tq.run(tq.from_iterable(range(1, 5)) >> tq.node(Summer) >> out, runtime=runtime)
    assert out.items == [10]


def test_broadcast_reaches_every_worker(runtime: str) -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(5)) >> tq.farm(double, 3, emit="broadcast") >> out, runtime=runtime
    )
    assert sorted(out.items) == sorted([2 * i for i in range(5)] * 3)


def test_scatter_and_gather_keep_order(runtime: str) -> None:
    out = tq.to_list()

    @tq.node
    def inc(chunk: list[int]) -> list[int]:
        return [c + 1 for c in chunk]

    data = [list(range(10)), list(range(3)), [], list(range(7))]
    tq.run(tq.from_iterable(data) >> tq.farm(inc, 4, emit="scatter") >> out, runtime=runtime)
    assert out.items == [[c + 1 for c in row] for row in data]


def test_scatter_with_first_come_forwards_chunks(runtime: str) -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable([list(range(6))])
        >> tq.farm(lambda chunk: sum(chunk), 3, emit="scatter", collect="first_come")
        >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == [1, 5, 9]


def test_on_demand_balances_uneven_work(runtime: str) -> None:
    seen: list[int] = []
    lock = threading.Lock()

    @tq.node
    def slow_if_zero(x: int, ctx: tq.Context) -> None:
        if ctx.index == 0:
            time.sleep(0.02)
        with lock:
            seen.append(ctx.index)
        ctx.send(x)

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(30)) >> tq.farm(slow_if_zero, 3, emit="on_demand") >> out,
        runtime=runtime,
    )
    assert len(out.items) == 30
    if runtime == "threads":
        assert seen.count(0) < 10  # the slow worker got fewer items than round robin would give


def test_key_routes_same_key_to_same_worker(runtime: str) -> None:
    @tq.node
    def tag(x: int, ctx: tq.Context) -> None:
        ctx.send((x % 3, ctx.index))

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(60)) >> tq.farm(tag, 4, key=lambda x: x % 3) >> out, runtime=runtime
    )
    by_key: dict[int, set[int]] = {}
    for k, w in out.items:
        by_key.setdefault(k, set()).add(w)
    assert all(len(ws) == 1 for ws in by_key.values())


def test_ordered_farm_with_jitter_and_skips(runtime: str) -> None:
    @tq.node
    def jitter(x: int) -> int:
        time.sleep(random.random() * 0.002)
        return tq.SKIP if x % 5 == 0 else x

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(100)) >> tq.farm(jitter, 4, ordered=True, window=8) >> out,
        runtime=runtime,
    )
    assert out.items == [x for x in range(100) if x % 5]


def test_ordered_farm_with_flat_workers(runtime: str) -> None:
    @tq.node
    def twice(x: int):  # type: ignore[no-untyped-def]
        yield x
        yield x

    out = tq.to_list()
    tq.run(tq.from_iterable(range(20)) >> tq.farm(twice, 3, ordered=True) >> out, runtime=runtime)
    assert out.items == [x for x in range(20) for _ in range(2)]


def test_round_robin_collect_preserves_round_robin_emit_order(runtime: str) -> None:
    @tq.node
    def jitter(x: int) -> int:
        time.sleep(random.random() * 0.002)
        return x

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(50)) >> tq.farm(jitter, 5, collect="round_robin") >> out,
        runtime=runtime,
    )
    assert out.items == list(range(50))


def test_custom_emitter_and_collector(runtime: str) -> None:
    @tq.node
    def route(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 2)

    @tq.node
    def label(x: int, ctx: tq.Context) -> None:
        ctx.send((ctx.index, x))

    @tq.node
    def merge(item: tuple[int, int], ctx: tq.Context) -> None:
        ctx.send((ctx.source, *item))

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(10)) >> tq.farm(label, 2, emitter=route, collector=merge) >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == sorted((x % 2, x % 2, x) for x in range(10))


def test_comb_fuses_two_nodes(runtime: str) -> None:
    calls: list[str] = []

    class A:
        def on_start(self, ctx: tq.Context) -> None:
            calls.append("A.start")

        def __call__(self, x: int) -> int:
            return x + 1

        def on_end(self, ctx: tq.Context) -> None:
            calls.append("A.end")

    @tq.node
    def b(x: int):  # type: ignore[no-untyped-def]
        yield x
        yield -x

    out = tq.to_list()
    g = tq.from_iterable([1, 2]) >> tq.comb(A, b) >> out
    assert len(tq.check(g).nodes) == 3
    tq.run(g, runtime=runtime)
    assert out.items == [2, -2, 3, -3]
    assert calls == ["A.start", "A.end"]


def test_comb_with_sink_second(runtime: str) -> None:
    got: list[int] = []

    @tq.sink
    def keep(x: int) -> None:
        got.append(x)

    tq.run(tq.from_iterable([1, 2]) >> tq.comb(double, keep), runtime=runtime)
    assert got == [2, 4]


def test_one_to_n_and_n_to_m_flows(runtime: str) -> None:
    out = tq.to_list()
    g = (
        tq.from_iterable(range(30))
        >> tq.farm(double, 3, emitter=False, collector=False)
        >> tq.farm(double, 2, emitter=False)
        >> out
    )
    report = tq.run(g, runtime=runtime)
    assert sorted(out.items) == [4 * i for i in range(30)]
    assert report.nodes["from_iterable"].items_out == 30


def test_raw_node_inputs_and_selective_recv(runtime: str) -> None:
    @tq.node
    def split(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 2)

    @tq.raw
    def merge(ctx: tq.Context) -> None:
        evens = []
        while (r := ctx.recv(source=0)) is not None:
            evens.append(r[1])
        rest = [item for _, item in ctx.inputs()]
        ctx.send(("evens", evens))
        ctx.send(("odds", rest))

    out = tq.to_list()
    with pytest.raises(tq.GraphError, match="must take an item"):
        tq.farm(merge, 1)  # a raw node reads for itself, so it cannot be a worker
    g = tq.from_iterable(range(10)) >> tq.farm(double, 2, emitter=split, collector=merge) >> out
    tq.run(g, runtime=runtime)
    assert dict(out.items) == {"evens": [0, 4, 8, 12, 16], "odds": [2, 6, 10, 14, 18]}


def test_stop_ends_a_sink_early_without_hanging(runtime: str) -> None:
    got: list[int] = []

    @tq.sink
    def first_five(x: int, ctx: tq.Context) -> None:
        got.append(x)
        if len(got) == 5:
            ctx.stop()

    report = tq.run(tq.from_iterable(range(100_000)) >> first_five, runtime=runtime, capacity=8)
    assert got == [0, 1, 2, 3, 4]
    assert report.nodes["from_iterable"].dropped > 0


def test_capacity_one_and_unbounded(runtime: str) -> None:
    for cap in (1, None):
        out = tq.to_list()
        tq.run(tq.from_iterable(range(200)) >> double >> out, runtime=runtime, capacity=cap)
        assert out.items == [2 * i for i in range(200)]


def test_list_of_different_workers(runtime: str) -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(4)) >> tq.farm([lambda x: ("a", x), lambda x: ("b", x)]) >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == [("a", 0), ("a", 2), ("b", 1), ("b", 3)]


def test_sync_runtime_is_deterministic() -> None:
    @tq.node
    def label(x: int, ctx: tq.Context) -> None:
        ctx.send((ctx.index, x))

    runs = []
    for _ in range(3):
        out = tq.to_list()
        tq.run(tq.from_iterable(range(50)) >> tq.farm(label, 4) >> out, runtime="sync", capacity=3)
        runs.append(list(out.items))
    assert runs[0] == runs[1] == runs[2]


def test_pipeline_of_many_stages(runtime: str) -> None:
    out = tq.to_list()
    stages = [tq.node(lambda x: x + 1, name=f"s{i}") for i in range(20)]
    tq.run(tq.pipeline(tq.from_iterable(range(1000)), *stages, out), runtime=runtime)
    assert out.items == [i + 20 for i in range(1000)]
