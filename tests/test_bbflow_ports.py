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
