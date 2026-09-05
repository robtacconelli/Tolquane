"""Build-time behaviour: kind inference, naming, topology rules, validation, views."""

import pytest

import tolquane as tq
from tolquane.graph import build


def test_decorated_functions_stay_callable() -> None:
    @tq.node
    def double(x: int) -> int:
        return x * 2

    assert double(3) == 6
    assert double.kind == "map"
    assert double.__wrapped__(4) == 8


def test_kind_inference() -> None:
    def one(x):  # type: ignore[no-untyped-def]
        return x

    def two(x, ctx):  # type: ignore[no-untyped-def]
        ctx.send(x)

    def gen(x):  # type: ignore[no-untyped-def]
        yield x

    def zero():  # type: ignore[no-untyped-def]
        return [1]

    class Worker:
        def __call__(self, x: int) -> int:
            return x

    assert tq.Node(one).kind == "map"
    assert tq.Node(two).kind == "ctx"
    assert tq.Node(gen).kind == "flat"
    assert tq.Node(zero).kind == "source"
    w = tq.Node(Worker)
    assert w.kind == "map"
    assert w.factory
    instance = tq.Node(Worker())
    assert instance.kind == "map"
    assert not instance.factory


def test_declared_kinds_are_checked() -> None:
    with pytest.raises(tq.GraphError, match="takes 1 parameter"):
        tq.source(lambda x: x)
    with pytest.raises(tq.GraphError, match="raw node"):
        tq.raw(lambda x, y: x)
    with pytest.raises(tq.GraphError, match="takes no parameter"):
        tq.sink(lambda: None)
    with pytest.raises(tq.GraphError, match="3 positional parameters"):
        tq.node(lambda a, b, c: a)


def test_unique_names_when_a_node_is_used_twice() -> None:
    @tq.node
    def double(x: int) -> int:
        return x * 2

    g = build(tq.from_iterable([1]) >> double >> double >> tq.to_list())
    assert [n.name for n in g.nodes] == ["from_iterable", "double", "double#2", "to_list"]


@pytest.mark.parametrize(
    ("left", "right", "rules"),
    [
        (1, 1, {"1-1"}),
        (1, 3, {"1xN"}),
        (3, 1, {"Nx1"}),
        (3, 3, {"N-N"}),
        (3, 2, {"NxM"}),
    ],
)
def test_topology_rules(left: int, right: int, rules: set[str]) -> None:
    def w(x: int) -> int:
        return x

    def side(n: int, name: str) -> tq.Block:
        if n == 1:
            return tq.node(w, name=name)
        return tq.farm(w, n, emitter=False, collector=False, name=name)

    g = build(tq.from_iterable([1]) >> side(left, "L") >> side(right, "R") >> tq.to_list())
    between = [e for e in g.edges if e.src.startswith("L") and e.dst.startswith("R")]
    assert {e.rule for e in between} == rules
    expected = left * right if rules == {"NxM"} else max(left, right)
    assert len(between) == expected


def test_validation_messages() -> None:
    @tq.node
    def double(x: int) -> int:
        return x * 2

    @tq.source
    def src():  # type: ignore[no-untyped-def]
        yield 1

    with pytest.raises(tq.GraphError, match="has no input"):
        tq.check(double)
    with pytest.raises(tq.GraphError, match="nothing reads them"):
        tq.check(src >> double)
    with pytest.raises(tq.GraphError, match="has no inputs, so it cannot follow"):
        tq.check(src >> src)
    with pytest.raises(tq.GraphError, match="has no outputs, so nothing can follow"):
        tq.check(src >> tq.to_list() >> double)
    with pytest.raises(tq.GraphError, match="must take an item"):
        tq.farm(src, 2)
    with pytest.raises(tq.GraphError, match="workers must be a positive integer"):
        tq.farm(double, 0)
    with pytest.raises(tq.GraphError, match="unknown emit policy"):
        tq.farm(double, 2, emit="random")
    with pytest.raises(tq.GraphError, match="unknown collect policy"):
        tq.farm(double, 2, collect="random")
    with pytest.raises(tq.GraphError, match="pairs with emit='scatter'"):
        tq.farm(double, 2, collect="gather")
    with pytest.raises(tq.GraphError, match="cannot be combined"):
        tq.farm(double, 2, emit="broadcast", key=lambda x: x)
    with pytest.raises(tq.GraphError, match="needs both an emitter and a collector"):
        tq.farm(double, 2, ordered=True, collector=False)
    with pytest.raises(tq.GraphError, match="farms and pipelines cannot be combined"):
        tq.comb(tq.farm(double, 2), double)
    with pytest.raises(tq.GraphError, match="is not a block or a callable"):
        tq.check(src >> 42)  # type: ignore[operator]


def test_raw_node_may_have_no_inputs() -> None:
    @tq.raw
    def gen(ctx: tq.Context) -> None:
        ctx.send(1)

    g = tq.check(gen >> tq.to_list())
    assert g.node("gen").kind == "raw"


def test_draw_and_explain() -> None:
    @tq.node
    def double(x: int) -> int:
        return x * 2

    g = tq.from_iterable([1]) >> tq.farm(double, 2, ordered=True) >> tq.to_list()
    d = tq.draw(g)
    assert d.startswith("flowchart LR")
    assert 'subgraph n_double["farm double (2 workers)"]' in d
    assert "n_from_iterable --> n_double_emitter" in d
    e = tq.explain(g)
    assert "double.emitter: ctx, emit=round_robin" in e
    assert "double.collector: ctx, collect=ordered" in e
    assert "double.0: map, tagged" in e
    assert "window double.window" in e
    assert "from_iterable -> double.emitter  [1-1]" in e


def test_check_returns_graph_and_accepts_graph() -> None:
    g = tq.check(tq.from_iterable([1]) >> tq.to_list())
    assert isinstance(g, tq.Graph)
    assert tq.check(g) is g
