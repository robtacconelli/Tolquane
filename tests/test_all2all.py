"""all2all: the eight FastFlow cases and the thesis test shapes."""

import pytest

import tolquane as tq


@tq.node
def ident(x: int) -> int:
    return x


def _left(n: int = 3) -> tq.Farm:
    return tq.farm(ident, n, name="L")


def _right(n: int = 2) -> tq.Farm:
    return tq.farm(ident, n, name="R")


def test_requires_two_farms() -> None:
    with pytest.raises(tq.GraphError, match="joins two farms"):
        tq.all2all(ident, _right())  # type: ignore[arg-type]
    with pytest.raises(tq.GraphError, match="ordered or gather"):
        tq.all2all(tq.farm(ident, 2, ordered=True), _right())


def test_plain_all_to_all_wires_every_pair() -> None:
    g = tq.check(tq.from_iterable([1]) >> tq.all2all(_left(3), _right(2)) >> tq.to_list())
    between = [e for e in g.edges if e.src.startswith("L.") and e.dst.startswith("R.")]
    assert len(between) == 6
    assert {e.rule for e in between} == {"NxM"}
    names = {n.name for n in g.nodes}
    assert "L.collector" not in names
    assert "R.emitter" not in names
    assert {"L.emitter", "R.collector"} <= names


def test_merge_without_r_and_g_pairs_equal_degrees() -> None:
    g = tq.check(
        tq.from_iterable([1]) >> tq.all2all(_left(3), _right(3), merge=True) >> tq.to_list()
    )
    between = [e for e in g.edges if e.src.startswith("L.") and e.dst.startswith("R.")]
    assert len(between) == 3
    assert {e.rule for e in between} == {"N-N"}
    g = tq.check(
        tq.from_iterable([1]) >> tq.all2all(_left(3), _right(2), merge=True) >> tq.to_list()
    )
    between = [e for e in g.edges if e.src.startswith("L.") and e.dst.startswith("R.")]
    assert len(between) == 6


def test_r_and_g_are_fused_into_workers(runtime: str) -> None:
    @tq.node
    def plus_ten(x: int) -> int:
        return x + 10

    @tq.node
    def times_two(x: int) -> int:
        return x * 2

    out = tq.to_list()
    g = tq.from_iterable(range(6)) >> tq.all2all(_left(), _right(), R=plus_ten, G=times_two) >> out
    graph = tq.check(g)
    assert graph.node("L.0").kind == "comb"
    assert graph.node("R.0").kind == "comb"
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == sorted((x + 10) * 2 for x in range(6))


def test_only_r_and_only_g(runtime: str) -> None:
    @tq.node
    def plus_ten(x: int) -> int:
        return x + 10

    for kwargs in ({"R": plus_ten}, {"G": plus_ten}):
        out = tq.to_list()
        tq.run(
            tq.from_iterable(range(6)) >> tq.all2all(_left(), _right(), **kwargs) >> out,
            runtime=runtime,
        )
        assert sorted(out.items) == [x + 10 for x in range(6)]


def test_merge_with_r_and_g_makes_one_middle_node(runtime: str) -> None:
    @tq.node
    def plus_ten(x: int) -> int:
        return x + 10

    @tq.node
    def times_two(x: int) -> int:
        return x * 2

    out = tq.to_list()
    g = (
        tq.from_iterable(range(6))
        >> tq.all2all(_left(), _right(), R=plus_ten, G=times_two, merge=True)
        >> out
    )
    graph = tq.check(g)
    middle = [n for n in graph.nodes if n.kind == "comb"]
    assert len(middle) == 1
    assert middle[0].name == "plus_ten+times_two"
    assert len(graph.incoming(middle[0].name)) == 3
    assert len(graph.outgoing(middle[0].name)) == 2
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == sorted((x + 10) * 2 for x in range(6))


def test_merge_with_only_r(runtime: str) -> None:
    @tq.node
    def route(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % ctx.n_outputs)

    out = tq.to_list()
    g = tq.from_iterable(range(10)) >> tq.all2all(_left(), _right(), R=route, merge=True) >> out
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == list(range(10))


def test_thesis_all2all_generators_to_sinks(runtime: str) -> None:
    """all2all.java: three self-fed workers, no emitter, into three collectors."""

    class Gen:
        def __call__(self, x: int) -> object:
            return tq.SKIP

        def on_start(self, ctx: tq.Context) -> None:
            for i in range(100):
                ctx.send(ctx.index * 1000 + i)

    out = tq.to_list()
    left = tq.farm(Gen, 3, emitter=False, name="gen")
    right = tq.farm(ident, 3, name="sink")
    tq.run(tq.all2all(left, right) >> out, runtime=runtime)
    assert len(out.items) == 300


def test_thesis_all2all2_router_farms(runtime: str) -> None:
    """all2all2.java: routers (even/odd) to two accumulators through all-to-all."""
    values = [13, 17, 14, 27, 31, 6, 8, 4, 26, 31, 105, 238, 47, 48]

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
    g = tq.from_iterable(values) >> tq.all2all(tq.farm(router, 3), tq.farm(Accumulate, 2)) >> out
    tq.run(g, runtime=runtime)
    assert dict(out.items) == {
        0: sum(v for v in values if v % 2 == 0),
        1: sum(v for v in values if v % 2),
    }


def test_thesis_all2all4_two_all2alls_in_pipeline(runtime: str) -> None:
    """all2all4.java: all2all(gen x3, f1 x3) >> all2all(f2 x3, f3 x2), N-N between them."""

    class Gen:
        def __call__(self, x: int) -> object:
            return tq.SKIP

        def on_start(self, ctx: tq.Context) -> None:
            for i in range(ctx.index * 10 + 1, ctx.index * 10 + 12):
                ctx.send(i, to=i % 3)

    out = tq.to_list()
    stage1 = tq.all2all(
        tq.farm(Gen, 3, emitter=False, name="gen"), tq.farm(ident, 3, collector=False, name="f1")
    )
    stage2 = tq.all2all(tq.farm(ident, 3, emitter=False, name="f2"), tq.farm(ident, 2, name="f3"))
    g = stage1 >> stage2 >> out
    graph = tq.check(g)
    middle = [e for e in graph.edges if e.src.startswith("f1.") and e.dst.startswith("f2.")]
    assert {e.rule for e in middle} == {"N-N"}
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == sorted(i for k in range(3) for i in range(k * 10 + 1, k * 10 + 12))


def test_thesis_all2all5_farm_without_collector_into_all2all(runtime: str) -> None:
    @tq.node
    def emitter(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 3)

    out = tq.to_list()
    first = tq.farm(ident, 3, emitter=emitter, collector=False, name="w")
    second = tq.all2all(tq.farm(ident, 3, emitter=False, name="f1"), tq.farm(ident, 2, name="f2"))
    tq.run(tq.from_iterable(range(1, 101)) >> first >> second >> out, runtime=runtime)
    assert sorted(out.items) == list(range(1, 101))


def test_thesis_all2all7_multi_output_collector_into_workers(runtime: str) -> None:
    out = tq.to_list()
    first = tq.farm(ident, 3, name="w")  # default collector, one output fanned out 1xN
    second = tq.all2all(tq.farm(ident, 3, emitter=False, name="f1"), tq.farm(ident, 2, name="f2"))
    g = tq.from_iterable(range(1, 101)) >> first >> second >> out
    graph = tq.check(g)
    fan = [e for e in graph.edges if e.src == "w.collector"]
    assert {e.rule for e in fan} == {"1xN"}
    assert len(fan) == 3
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == list(range(1, 101))
