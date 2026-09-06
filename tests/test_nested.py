"""Blocks as farm workers: pipelines, farms, feedback loops and all-to-alls, copied per worker."""

from __future__ import annotations

import pytest

import tolquane as tq
from tolquane.graph import expand


@tq.node
def inc(x: int) -> int:
    return x + 1


@tq.node
def dbl(x: int) -> int:
    return x * 2


@tq.node
def step(state: tuple[int, int], ctx: tq.Context) -> None:
    n, x = state
    if x + 1 >= n:
        ctx.send(x + 1)
    else:
        ctx.feedback((n, x + 1))


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_farm_of_pipelines(runtime: str) -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(50)) >> tq.farm(inc >> dbl, 3) >> out, runtime=runtime)
    assert sorted(out.items) == [2 * (i + 1) for i in range(50)]


def test_copies_are_named_by_worker_and_stage() -> None:
    g = expand(tq.from_iterable(range(3)) >> tq.farm(inc >> dbl, 2, name="w") >> tq.to_list())
    names = [n.name for n in g.nodes]
    assert names == [
        "from_iterable",
        "w.emitter",
        "w.0.inc",
        "w.0.dbl",
        "w.1.inc",
        "w.1.dbl",
        "w.collector",
        "to_list",
    ]
    assert all(n.group == "w" and n.role == "worker" for n in g.nodes if ".0." in n.name)
    assert "farm w (2 workers)" in tq.draw(g)


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_farm_of_farms(runtime: str) -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(40)) >> tq.farm(tq.farm(inc, 2), 3) >> out, runtime=runtime)
    assert sorted(out.items) == [i + 1 for i in range(40)]
    g = expand(tq.farm(tq.farm(inc, 2, name="in"), 2, name="out"))
    inner = [n for n in g.nodes if n.name.startswith("out.0.")]
    assert [n.name for n in inner] == [
        "out.0.in.emitter",
        "out.0.in.0",
        "out.0.in.1",
        "out.0.in.collector",
    ]
    assert all(n.group == "out.0.in" for n in inner)  # the inner farm keeps its own group


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_farm_of_feedback_loops(runtime: str) -> None:
    out = tq.to_list()
    tq.run(
        tq.from_iterable([(3, 0), (5, 0), (2, 0), (7, 0), (1, 0)])
        >> tq.farm(tq.feedback(step), 2)
        >> out,
        runtime=runtime,
    )
    assert sorted(out.items) == [1, 2, 3, 5, 7]


def test_farm_of_all2alls() -> None:
    out = tq.to_list()
    worker = tq.all2all(tq.farm(inc, 2), tq.farm(dbl, 2))
    tq.run(tq.from_iterable(range(30)) >> tq.farm(worker, 2) >> out)
    assert sorted(out.items) == [2 * (i + 1) for i in range(30)]


def test_all2all_with_pipeline_workers_and_ends() -> None:
    out = tq.to_list()
    right = tq.farm(inc >> dbl, 2)
    tq.run(tq.from_iterable(range(20)) >> tq.all2all(tq.farm(inc, 2), right, G=inc) >> out)
    assert sorted(out.items) == [2 * (i + 3) for i in range(20)]
    out = tq.to_list()
    left = tq.farm(inc >> inc, 2)
    tq.run(tq.from_iterable(range(20)) >> tq.all2all(left, tq.farm(dbl, 2), R=inc) >> out)
    assert sorted(out.items) == [2 * (i + 3) for i in range(20)]


def test_sink_block_workers_need_no_collector() -> None:
    seen: list[int] = []

    @tq.sink
    def keep(x: int) -> None:
        seen.append(x)

    tq.run(tq.from_iterable(range(6)) >> tq.farm(inc >> keep, 2, collector=False))
    assert sorted(seen) == list(range(1, 7))
    with pytest.raises(tq.GraphError, match="collector=False"):
        tq.check(tq.from_iterable(range(6)) >> tq.farm(inc >> keep, 2))


def test_block_workers_on_demand_and_key() -> None:
    out = tq.to_list()
    tq.run(tq.from_iterable(range(30)) >> tq.farm(inc >> dbl, 3, emit="on_demand") >> out)
    assert sorted(out.items) == [2 * (i + 1) for i in range(30)]
    out = tq.to_list()
    tq.run(tq.from_iterable(range(30)) >> tq.farm(inc >> dbl, 3, key=lambda x: x % 3) >> out)
    assert sorted(out.items) == [2 * (i + 1) for i in range(30)]


def test_refusals() -> None:
    with pytest.raises(tq.GraphError, match="plain nodes"):
        tq.farm(inc >> dbl, 2, ordered=True)
    with pytest.raises(tq.GraphError, match="plain nodes"):
        tq.farm(inc >> dbl, 2, emit="scatter")
    with pytest.raises(tq.GraphError, match="one input"):
        tq.check(
            tq.from_iterable([1]) >> tq.farm(tq.farm(inc, 2, emitter=False), 2) >> tq.to_list()
        )
    with pytest.raises(tq.GraphError, match="one output"):
        tq.check(
            tq.from_iterable([1]) >> tq.farm(tq.farm(inc, 2, collector=False), 2) >> tq.to_list()
        )
    with pytest.raises(tq.GraphError, match="inner farm"):
        tq.farm(inc >> dbl, 2, runtime="processes")
    with pytest.raises(tq.GraphError, match="0 inputs"):
        tq.check(tq.farm(tq.from_iterable([1]) >> inc, 2) >> tq.to_list())


def test_nested_block_inside_feedback() -> None:
    @tq.node
    def route(x: int, ctx: tq.Context) -> None:
        if x >= 50:
            ctx.send(x)
        else:
            ctx.feedback(x)

    out = tq.to_list()
    tq.run(tq.from_iterable([1, 2, 3]) >> tq.feedback(tq.farm(inc >> dbl, 2) >> route) >> out)
    assert sorted(out.items) == [62, 78, 94]


def test_deploy_patterns_match_nested_names() -> None:
    from tolquane.net import assign

    g = expand(tq.from_iterable(range(3)) >> tq.farm(inc >> dbl, 2, name="w") >> tq.to_list())
    deployment = tq.load_deployment(
        {
            "groups": {
                "A": {"endpoint": "h:1", "nodes": ["from_iterable", "w.emitter", "w.collector"]},
                "B": {"endpoint": "h:2", "nodes": ["w.[0-9]*", "to_list"]},
            }
        }
    )
    assignment = assign(g, deployment)
    assert assignment["w.0.inc"] == "B"
    assert assignment["w.1.dbl"] == "B"
    assert assignment["w.emitter"] == "A"
