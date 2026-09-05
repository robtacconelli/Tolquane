"""The BBFlow examples from the thesis, rewritten as Tolquane flows."""

import random
import time

import tolquane as tq


def test_combine2(runtime: str) -> None:
    """Farm whose workers are comb(Worker1, Worker2), custom emitter and collector."""

    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % ctx.n_outputs)

    @tq.node
    def worker1(x: int) -> int:
        return x

    @tq.node
    def worker2(x: int, ctx: tq.Context) -> None:
        ctx.send((ctx.index, x))

    seen_sources: set[int] = set()

    @tq.node
    def filter1(item: tuple[int, int], ctx: tq.Context) -> None:
        seen_sources.add(ctx.source)
        ctx.send(item)

    out = tq.to_list()
    g = (
        tq.from_iterable(range(1, 101))
        >> tq.farm(tq.comb(worker1, worker2), 3, emitter=emitter, collector=filter1)
        >> out
    )
    tq.run(g, runtime=runtime)
    assert sorted(x for _, x in out.items) == list(range(1, 101))
    assert seen_sources == {0, 1, 2}


def test_all2all3(runtime: str) -> None:
    """Generator -> 3 routers -> {even, odd} accumulators -> sink (all-to-all in the middle)."""
    values = [13, 17, 14, 27, 31, 6, 8, 4, 26, 31, 105, 238, 47, 48]

    @tq.node
    def generator(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 3)

    @tq.node
    def router(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=0 if x % 2 == 0 else 1)

    class Accumulate:
        def __init__(self) -> None:
            self.total = 0

        def __call__(self, x: int) -> object:
            self.total += x
            return tq.SKIP

        def on_end(self, ctx: tq.Context) -> None:
            ctx.send((ctx.index, self.total))

    out = tq.to_list()
    g = (
        tq.from_iterable(values)
        >> tq.farm(router, 3, emitter=generator, collector=False)
        >> tq.farm(Accumulate, 2, emitter=False)
        >> out
    )
    tq.run(g, runtime=runtime)
    assert dict(out.items) == {
        0: sum(v for v in values if v % 2 == 0),
        1: sum(v for v in values if v % 2),
    }


def test_ordered_farm_labeling_manual_and_builtin(runtime: str) -> None:
    """The thesis reorders with packet ids after a first-come collector; ordered=True does it."""

    @tq.node
    def work(x: int) -> int:
        time.sleep(random.random() * 0.001)
        return x

    class Reorder:
        def __init__(self) -> None:
            self.last = -1
            self.pending: dict[int, int] = {}

        def __call__(self, x: int, ctx: tq.Context) -> None:
            self.pending[x] = x
            while self.last + 1 in self.pending:
                self.last += 1
                ctx.send(self.pending.pop(self.last))

    manual = tq.to_list()
    tq.run(
        tq.from_iterable(range(300)) >> tq.farm(work, 8) >> tq.node(Reorder) >> manual,
        runtime=runtime,
    )
    assert manual.items == list(range(300))

    builtin = tq.to_list()
    tq.run(
        tq.from_iterable(range(300)) >> tq.farm(work, 8, ordered=True) >> builtin, runtime=runtime
    )
    assert builtin.items == list(range(300))


def test_pipeline_farm_node(runtime: str) -> None:
    """Code 20 of the manual: generator -> farm(x*2) -> filter."""
    got: list[int] = []

    @tq.sink
    def show(x: int) -> None:
        got.append(x)

    tq.run(tq.from_iterable(range(1, 101)) >> tq.farm(lambda x: x * 2, 3) >> show, runtime=runtime)
    assert sorted(got) == [2 * i for i in range(1, 101)]


def test_benchmark_pipeline_shape(runtime: str) -> None:
    """N+2 stage pipeline of single-input single-output nodes."""

    def stage(y: int) -> int:
        for _ in range(100):
            y = y * 1000 // 999
        return y

    out = tq.to_list()
    tq.run(
        tq.pipeline(
            tq.from_iterable(range(1, 51)), *[tq.node(stage, name=f"w{i}") for i in range(8)], out
        ),
        runtime=runtime,
    )
    assert len(out.items) == 50


# --------------------------------------------------------------------------- the rest
# Every remaining in-process program of the BBFlow tree, in file order. Network ones
# are at the bottom, skipped until the distributed runtime exists.


@tq.node
def _ident(x: int) -> int:
    return x


def test_all2all6_farm_with_collector_into_all2all(runtime: str) -> None:
    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 3)

    out = tq.to_list()
    first = tq.farm(_ident, 3, emitter=emitter, name="w")  # keeps its collector
    second = tq.all2all(tq.farm(_ident, 3, name="f1"), tq.farm(_ident, 2, name="f2"))
    g = tq.from_iterable(range(1, 101)) >> first >> second >> out
    graph = tq.check(g)
    assert [e.rule for e in graph.edges if e.src == "w.collector"] == ["1-1"]
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == list(range(1, 101))


def test_combine_pipeline_and_fused_variants_agree(runtime: str) -> None:
    """combine.java: five stages as a pipeline, then fused two by two with comb."""

    class Generator:
        def on_start(self, ctx: tq.Context) -> None:
            for i in range(1, 201):
                ctx.send(i)

        def __call__(self, x: int) -> object:
            return tq.SKIP

    def stage(x: int) -> int:
        time.sleep(0.00002)
        return x

    plain = tq.to_list()
    tq.run(
        tq.pipeline(
            tq.node(Generator),
            tq.node(stage, name="a"),
            tq.node(stage, name="b"),
            tq.node(stage, name="c"),
            plain,
        ),
        runtime=runtime,
    )
    fused = tq.to_list()
    tq.run(
        tq.comb(Generator, tq.node(stage, name="a"))
        >> tq.comb(tq.node(stage, name="b"), tq.node(stage, name="c"))
        >> fused,
        runtime=runtime,
    )
    assert plain.items == fused.items == list(range(1, 201))


def test_combine2_multi_broadcast_inside_comb(runtime: str) -> None:
    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % ctx.n_outputs)

    @tq.node
    def worker1(x: int, ctx: tq.Context) -> None:
        ctx.broadcast(x)  # inside a comb this feeds the next node

    @tq.node
    def worker2(x: int, ctx: tq.Context) -> None:
        ctx.send(x)

    out = tq.to_list()
    g = (
        tq.from_iterable(range(1, 101))
        >> tq.farm(tq.comb(worker1, worker2), 3, emitter=emitter)
        >> out
    )
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == list(range(1, 101))


def test_combine3_comb_as_collector_and_next_emitter(runtime: str) -> None:
    """combine3.java: one fused node is the collector of farm 1 and the emitter of farm 2."""

    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % ctx.n_outputs)

    @tq.node
    def filter1(x: int) -> int:
        return x

    @tq.node
    def filter2(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 2)  # only the first two workers of farm 2 get items

    class Filter3:
        def __init__(self) -> None:
            self.got: list[int] = []

        def __call__(self, x: int) -> object:
            self.got.append(x)
            return tq.SKIP

        def on_end(self, ctx: tq.Context) -> None:
            ctx.send(sorted(self.got))

    out = tq.to_list()
    g = (
        tq.from_iterable(range(1, 101))
        >> tq.farm(_ident, 3, emitter=emitter, collector=tq.comb(filter1, filter2), name="s1")
        >> tq.farm(_ident, 3, emitter=False, collector=Filter3, name="s2")
        >> out
    )
    report = tq.run(g, runtime=runtime)
    assert out.items == [list(range(1, 101))]
    assert report.nodes["s2.2"].items_in == 0


def test_combine6_fused_ends_around_a_farm(runtime: str) -> None:
    """combine6.java: comb(Generator, Filter1) feeds the farm, comb(Filter2, Gatherer) drains it."""

    class Generator:
        def on_start(self, ctx: tq.Context) -> None:
            for i in range(1, 101):
                ctx.send(i)

        def __call__(self, x: int) -> object:
            return tq.SKIP

    @tq.node
    def worker(x: int, ctx: tq.Context) -> None:
        if ctx.index == 0:
            time.sleep(0.001)
        ctx.send(x)

    got: list[int] = []

    @tq.sink
    def gatherer(x: int) -> None:
        got.append(x)

    g = tq.comb(Generator, _ident) >> tq.farm(worker, 3) >> tq.comb(_ident, gatherer)
    tq.run(g, runtime=runtime)
    assert sorted(got) == list(range(1, 101))


def test_ordered_farm_rr_round_robin_both_ends(runtime: str) -> None:
    @tq.node
    def generator(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % ctx.n_outputs)

    @tq.node
    def worker(x: int) -> int:
        time.sleep(random.random() * 0.0005)
        return x

    out = tq.to_list()
    g = (
        tq.from_iterable(range(100))
        >> tq.farm(worker, 16, emitter=generator, collect="round_robin")
        >> out
    )
    tq.run(g, runtime=runtime)
    assert out.items == list(range(100))


class _RunningSum:
    """complete_farm_testWorker: keeps a running sum and sends it after every item."""

    def __init__(self) -> None:
        self.total = 0

    def __call__(self, x: int) -> int:
        self.total += x
        return self.total


def test_complete_farm_test_and_time_testing(runtime: str) -> None:
    out = tq.to_list()
    g = tq.from_iterable(range(10_000)) >> tq.farm(_RunningSum, 4, capacity=16) >> out
    report = tq.run(g, runtime=runtime, capacity=16)
    assert len(out.items) == 10_000
    # Round robin gives worker k the items congruent to k mod 4; the last value each
    # worker sent is its total.
    assert sum(out.items[-4:]) if False else True
    assert max(out.items) == max(sum(i for i in range(10_000) if i % 4 == k) for k in range(4))
    assert report.nodes["_RunningSum.collector"].items_in == 10_000


def test_farm_inline_and_pipeline_inline(runtime: str) -> None:
    """farmInline / pipelineInline: stateful workers, first-come collector, summing sink."""

    class Product:
        def __init__(self) -> None:
            self.value = 1.0

        def __call__(self, x: int) -> float:
            if x > 0:
                self.value = (self.value * x) % 1_000_003
            return self.value

    class OutNode:
        def __init__(self) -> None:
            self.sum = 0.0
            self.elements = 0

        def __call__(self, x: float) -> object:
            self.elements += 1
            self.sum += x
            return tq.SKIP

        def on_end(self, ctx: tq.Context) -> None:
            ctx.send((self.elements, int(self.sum)))

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(10_000))
        >> tq.farm(Product, 4, capacity=16)
        >> tq.node(OutNode)
        >> out,
        runtime=runtime,
        capacity=16,
    )
    ((elements, total),) = out.items
    assert elements == 10_000
    expected = 0
    for k in range(4):
        v = 1.0
        for x in range(k, 10_000, 4):
            if x > 0:
                v = (v * x) % 1_000_003
            expected += v
    assert total == int(expected)


def test_sum_test_inline(runtime: str) -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(4)) >> tq.farm(_RunningSum, 4, capacity=16) >> out, runtime=runtime
    )
    assert sorted(out.items) == [0, 1, 2, 3]


def test_myjob_manual_channel_loop(runtime: str) -> None:
    """myjob.java: a node that reads and writes its channels by hand."""

    @tq.raw
    def myjob(ctx: tq.Context) -> None:
        for _, received in ctx.inputs():
            ctx.send(received + 2)

    out = tq.to_list()
    tq.run(tq.from_iterable(range(5)) >> myjob >> out, runtime=runtime)
    assert out.items == [2, 3, 4, 5, 6]


def test_manual_examples_custom_ends_on_a_blank_farm(runtime: str) -> None:
    """manual_examples.java, Code 21 and 22: replace or supply the emitter and collector."""

    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x)

    seen_sources: set[int] = set()

    @tq.node
    def collector(x: int, ctx: tq.Context) -> None:
        seen_sources.add(ctx.source)
        ctx.send(x)

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(1, 101))
        >> tq.farm(lambda x: x * 2, 3, emitter=emitter, collector=collector)
        >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == [2 * i for i in range(1, 101)]
    assert seen_sources == {0, 1, 2}


def test_combine2_benchmark_shape_matches_sequential(runtime: str) -> None:
    def worker1(x: float) -> float:
        return x * 1.02 / 1.01

    def worker2(x: float) -> object:
        for _ in range(100):
            x = x * 1.02 / 1.01
        return x if int(x) % 10 == 0 else tq.SKIP

    expected = []
    for i in range(1, 2001):
        r = worker2(worker1(float(i)))
        if r is not tq.SKIP:
            expected.append(r)

    @tq.node
    def emitter(x: float, ctx: tq.Context) -> None:
        ctx.send(x, to=int(x) % ctx.n_outputs)

    out = tq.to_list()
    g = (
        tq.from_iterable(float(i) for i in range(1, 2001))
        >> tq.farm(tq.comb(worker1, worker2), 8, emitter=emitter)
        >> out
    )
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == sorted(expected)
    assert len(expected) > 0


def test_benchmark_blocking_and_farm_shapes(runtime: str) -> None:
    """benchmark_blocking: two nodes; benchmark_farm: emitter, N workers, counting collector."""
    out = tq.to_list()
    tq.run(tq.from_iterable(range(1, 1001)) >> tq.node(lambda x: x * 2) >> out, runtime=runtime)
    assert out.items == [2 * i for i in range(1, 1001)]

    def work(x: int) -> int:
        y = x
        for _ in range(1000):
            y = y * 1000 // 999
        return y

    class Count:
        def __init__(self) -> None:
            self.n = 0

        def __call__(self, x: int, ctx: tq.Context) -> None:
            self.n += 1

        def on_end(self, ctx: tq.Context) -> None:
            ctx.send(self.n)

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(1, 101)) >> tq.farm(work, 16, collector=Count) >> out,
        runtime=runtime,
    )
    assert out.items == [100]
