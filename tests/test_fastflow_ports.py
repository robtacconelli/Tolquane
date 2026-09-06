"""Tolquane versions of FastFlow's composition tests (github.com/fastflow/fastflow, tests/).

Each test names the FastFlow program it mirrors. They exercise the corners FastFlow's
suite is about: blocks inside blocks, loops inside farms, heterogeneous worker sets,
and the ends that an optimizer may remove.
"""

from __future__ import annotations

import pytest

import tolquane as tq
from tolquane.graph import expand


@tq.node
def first(x: int) -> int:
    return x + 1


@tq.node
def second(x: int) -> int:
    return x * 2


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_farm_pipe(runtime: str) -> None:
    """test_farm+pipe.cpp: a farm whose workers are two-stage pipelines."""
    out = tq.to_list()
    tq.run(tq.from_iterable(range(100)) >> tq.farm(first >> second, 4) >> out, runtime=runtime)
    assert sorted(out.items) == [2 * (i + 1) for i in range(100)]


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_farm_farm(runtime: str) -> None:
    """test_farm+farm.cpp: a farm of farms, then its normal form."""
    nested = tq.from_iterable(range(60)) >> tq.farm(tq.farm(first, 2), 3) >> (out := tq.to_list())
    tq.run(nested, runtime=runtime)
    assert sorted(out.items) == [i + 1 for i in range(60)]
    normal = tq.optimize(nested)
    assert len(expand(normal).nodes) < len(expand(nested).nodes)


def test_farm_a2a() -> None:
    """test_farm+A2A.cpp: a master-worker farm feeding an all-to-all whose left workers are
    pipelines and whose single right worker collects."""

    @tq.node
    def schedule(x: int, ctx: tq.Context) -> None:
        if x % 2:
            ctx.feedback(x)  # odd numbers go round once more
        else:
            ctx.send(x)

    collected = tq.to_list()
    head = tq.feedback(tq.farm(first, 3, collector=schedule))
    tail = tq.all2all(tq.farm(first >> second, 3), tq.farm(lambda x: x, 1))
    tq.run(tq.from_iterable(range(20)) >> head >> tail >> collected)
    # first adds one; an odd result goes round once more and gets one more.
    after_head = [(i + 1) if (i + 1) % 2 == 0 else (i + 2) for i in range(20)]
    assert sorted(collected.items) == sorted(2 * (v + 1) for v in after_head)


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_multi_masterworker(runtime: str) -> None:
    """test_multi_masterworker.cpp: a farm whose workers are master-worker farms (D&C style)."""

    @tq.node
    def halve(task: tuple[int, int], ctx: tq.Context) -> None:
        # (value, depth): split until depth 0, then emit the leaf
        v, d = task
        if d == 0:
            ctx.send(v)
        else:
            ctx.feedback((v, d - 1))
            ctx.feedback((v, d - 1))

    out = tq.to_list()
    dc = tq.feedback(tq.farm(lambda t: t, 2, collector=halve))  # the collector feeds back
    tq.run(tq.from_iterable([(1, 2), (2, 3)]) >> tq.farm(dc, 2) >> out, runtime=runtime)
    assert sorted(out.items) == [1] * 4 + [2] * 8


def test_pipe_masterworker() -> None:
    """test_pipe+masterworker.cpp: a pipeline stage that is a master-worker farm."""

    @tq.node
    def master(x: int, ctx: tq.Context) -> None:
        if x >= 8:
            ctx.send(x)
        else:
            ctx.feedback(x * 2)

    out = tq.to_list()
    tq.run(
        tq.from_iterable([1, 2, 3])
        >> tq.feedback(tq.farm(first, 2, collector=master))
        >> second
        >> out
    )
    assert sorted(out.items) == [18, 22, 30]


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_torus(runtime: str) -> None:
    """test_torus.cpp: a ring of stages; every token goes round K times."""
    K = 5

    @tq.node
    def stage(tok: tuple[int, int]) -> tuple[int, int]:
        return tok[0], tok[1] + 1

    @tq.node
    def gate(tok: tuple[int, int], ctx: tq.Context) -> None:
        if tok[1] >= 3 * K:
            ctx.send(tok[0])
        else:
            ctx.feedback(tok)

    out = tq.to_list()
    tq.run(
        tq.from_iterable([(i, 0) for i in range(8)])
        >> tq.feedback(stage >> stage >> stage >> gate)
        >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == list(range(8))


def test_misd() -> None:
    """test_MISD.cpp: two kinds of workers; the emitter sends evens to one, odds to the other."""

    @tq.node
    def even_worker(x: int) -> str:
        return f"even:{x}"

    @tq.node
    def odd_worker(x: int) -> str:
        return f"odd:{x}"

    @tq.node
    def by_parity(x: int, ctx: tq.Context) -> None:
        ctx.send(x, to=x % 2)

    out = tq.to_list()
    tq.run(
        tq.from_iterable(range(10)) >> tq.farm([even_worker, odd_worker], emitter=by_parity) >> out
    )
    assert sorted(out.items) == sorted(
        [f"even:{i}" for i in range(0, 10, 2)] + [f"odd:{i}" for i in range(1, 10, 2)]
    )


def test_all_to_all17() -> None:
    """test_all-to-all17.cpp: heterogeneous right workers, a pipeline and a comb."""
    out = tq.to_list()
    right = tq.farm([first >> second, tq.comb(first, second)])
    tq.run(tq.from_iterable(range(20)) >> tq.all2all(tq.farm(first, 2), right) >> out)
    assert sorted(out.items) == sorted(2 * (i + 2) for i in range(20))


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_ofarm(runtime: str) -> None:
    """test_ofarm.cpp: an ordered farm with workers that produce several items each."""

    @tq.node
    def twice(x: int):
        yield x
        yield -x

    out = tq.to_list()
    tq.run(tq.from_iterable(range(30)) >> tq.farm(twice, 4, ordered=True) >> out, runtime=runtime)
    assert out.items == [v for i in range(30) for v in (i, -i)]


def test_optimize_static() -> None:
    """test_optimize.cpp: after optimize_static the number of threads is considerably reduced."""

    @tq.node
    def s1(x: int) -> int:
        return x

    @tq.node
    def s2(x: int) -> int:
        return x

    @tq.node
    def s3(x: int) -> int:
        return x

    def flow(out: tq.ListSink) -> tq.Block:
        return (
            tq.from_iterable(range(50))
            >> s1
            >> tq.farm(first, 3)
            >> s2
            >> tq.farm(second, 3)
            >> s3
            >> out
        )

    a, b = tq.to_list(), tq.to_list()
    opt = tq.optimize(flow(b))
    assert len(expand(flow(a)).nodes) == 15
    assert len(expand(opt).nodes) == 11
    tq.run(flow(a))
    tq.run(opt)
    assert sorted(a.items) == sorted(b.items) == [2 * (i + 1) for i in range(50)]


def test_multi_input_after_collector_removal() -> None:
    """test_multi_input.cpp: a node reading from every worker of a farm without a collector."""

    @tq.node
    def tally(x: int, ctx: tq.Context) -> None:
        ctx.send((ctx.source, x))

    out = tq.to_list()
    tq.run(tq.from_iterable(range(12)) >> tq.farm(first, 3, collector=False) >> tally >> out)
    assert sorted(v for _, v in out.items) == [i + 1 for i in range(12)]
    assert {src for src, _ in out.items} == {0, 1, 2}
