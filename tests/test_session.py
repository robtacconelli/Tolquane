"""session(): a graph kept running, fed and read from the outside."""

import pytest

import tolquane as tq


@tq.node
def double(x: int) -> int:
    return x * 2


def test_put_get_and_iterate() -> None:
    with tq.session(tq.farm(double, 3)) as s:
        for i in range(5):
            s.put(i)
        got = [s.get(timeout=5) for _ in range(5)]
        assert sorted(got) == [0, 2, 4, 6, 8]
        s.put(100)
        s.close()
        assert list(s) == [200]
        with pytest.raises(tq.SessionClosed):
            s.get(timeout=1)
    assert s.report is not None
    assert s.report.nodes["session.in"].items_out == 6


def test_errors_surface_on_exit() -> None:
    @tq.node
    def boom(x: int) -> int:
        raise ValueError("bad item")

    def drive() -> None:
        with tq.session(boom) as s:
            s.put(1)
            s.close()
            s.get(timeout=5)

    with pytest.raises(tq.NodeError, match="bad item"):
        drive()


def test_sink_only_graph_has_no_get() -> None:
    got: list[int] = []

    @tq.sink
    def keep(x: int) -> None:
        got.append(x)

    with tq.session(double >> keep) as s:
        s.put(21)
        with pytest.raises(tq.SessionClosed, match="ends in a sink"):
            s.get()
    assert got == [42]


def test_session_needs_inputs_and_threads() -> None:
    with pytest.raises(tq.GraphError, match="needs a block with inputs"):
        tq.session(tq.from_iterable([1]) >> tq.to_list())
    with pytest.raises(tq.GraphError, match="not sync"):
        tq.session(double, runtime="sync")
