"""``tq.optimize``: fewer nodes, same results."""

from __future__ import annotations

import pytest

import tolquane as tq
from tolquane.graph import expand


@tq.node
def parse(x: int) -> int:
    return x * 2


@tq.node
def work(x: int) -> int:
    return x + 1


@tq.node
def post(x: int) -> int:
    return x - 1


@tq.node
def again(x: int) -> int:
    return x * 3


def _flow(out: tq.ListSink) -> tq.Block:
    return (
        tq.from_iterable(range(100))
        >> parse
        >> tq.farm(work, 4)
        >> post
        >> tq.farm(again, 2)
        >> out
    )


def _nodes(block: tq.Block) -> int:
    return len(expand(block).nodes)


@pytest.mark.parametrize("runtime", ["threads", "sync"])
def test_pipeline_rewrites_keep_results(runtime: str) -> None:
    plain, opt = tq.to_list(), tq.to_list()
    notes: list[str] = []
    block = tq.optimize(_flow(opt), notes=notes)
    tq.run(_flow(plain), runtime=runtime)
    tq.run(block, runtime=runtime)
    assert sorted(opt.items) == sorted(plain.items)
    assert _nodes(_flow(plain)) == 14
    assert _nodes(block) == 10
    assert any(line.startswith("fuse_emitter: node 'parse'") for line in notes)
    assert sum(line.startswith("remove_collector") for line in notes) == 2
    assert notes[-1] == "optimize: 14 nodes -> 10 nodes"
    assert "post" not in tq.explain(block).split("edges:")[0]  # post became again's emitter


def test_ordered_farm_keeps_its_collector_and_fuses_the_next_stage() -> None:
    out = tq.to_list()
    notes: list[str] = []
    block = tq.optimize(
        tq.from_iterable(range(20)) >> tq.farm(work, 3, ordered=True) >> post >> out, notes=notes
    )
    tq.run(block)
    assert out.items == list(range(20))
    assert notes[0].startswith("fuse_collector: node 'post'")
    names = [n.name for n in expand(block).nodes]
    assert "work.collector" in names
    assert "post" not in names


def test_farm_of_farms_becomes_one_farm() -> None:
    out = tq.to_list()
    notes: list[str] = []
    block = tq.optimize(
        tq.from_iterable(range(20)) >> tq.farm(tq.farm(work, 2), 3) >> out, notes=notes
    )
    tq.run(block)
    assert sorted(out.items) == [i + 1 for i in range(20)]
    assert notes[0] == "merge_farms: farm 'work' of 3 farms becomes one farm of 6 workers"
    assert _nodes(block) == 9  # source, emitter, 6 workers, sink: the collector went


def test_all2all_is_opt_in() -> None:
    flow = tq.from_iterable(range(20)) >> tq.farm(work, 2) >> tq.farm(again, 2) >> tq.to_list()
    assert not any(isinstance(b, tq.AllToAll) for b in tq.optimize(flow).blocks)  # type: ignore[attr-defined]
    out = tq.to_list()
    block = tq.optimize(
        tq.from_iterable(range(20)) >> tq.farm(work, 2) >> tq.farm(again, 2) >> out, all2all=True
    )
    assert any(isinstance(b, tq.AllToAll) for b in block.blocks)  # type: ignore[attr-defined]
    tq.run(block)
    assert sorted(out.items) == [3 * (i + 1) for i in range(20)]


def test_loops_keep_their_ends_wired() -> None:
    @tq.node
    def route(x: int, ctx: tq.Context) -> None:
        if x > 100:
            ctx.send(x)
        else:
            ctx.feedback(x)

    out = tq.to_list()
    block = tq.optimize(
        tq.from_iterable([1, 2, 3]) >> tq.feedback(parse >> tq.farm(work, 2) >> route) >> out
    )
    tq.run(block)
    assert sorted(out.items) == [127, 127, 191]
    # A farm that ends a loop keeps its collector: the feedback edges start there.
    out = tq.to_list()
    block = tq.optimize(
        tq.from_iterable([1, 2, 3]) >> tq.feedback(tq.farm(work, 2, collector=route)) >> out
    )
    g = expand(block)
    assert any(n.name == "work.collector" for n in g.nodes)


def test_untouchable_stages() -> None:
    import asyncio

    async def fetch(x: int) -> int:
        await asyncio.sleep(0)
        return x

    @tq.raw
    def manual(ctx: tq.Context) -> None:
        for _, item in ctx.inputs():
            ctx.send(item)

    flow = tq.from_iterable(range(5)) >> manual >> tq.farm(fetch, 4) >> tq.to_list()
    notes: list[str] = []
    block = tq.optimize(flow, notes=notes)
    assert notes == ["optimize: 4 nodes -> 4 nodes"]
    out = tq.to_list()
    tq.run(tq.optimize(tq.from_iterable(range(5)) >> manual >> tq.farm(fetch, 4) >> out))
    assert sorted(out.items) == list(range(5))
    assert block is not None


def test_rules_can_be_switched_off() -> None:
    out = tq.to_list()
    block = tq.optimize(_flow(out), fuse_emitter=False, remove_collector=False)
    assert _nodes(block) == 14


def test_cli_optimize(capsys: pytest.CaptureFixture[str], tmp_path: object) -> None:
    from pathlib import Path

    from tolquane.cli import main

    flow = Path(str(tmp_path)) / "flow.py"
    flow.write_text(
        "import tolquane as tq\n"
        "@tq.node\ndef a(x): return x\n"
        "@tq.node\ndef b(x): return x\n"
        "def build(source=None):\n"
        "    return tq.from_iterable(source or [1, 2]) >> a >> tq.farm(b, 2) >> tq.to_list()\n"
    )
    assert main(["optimize", str(flow)]) == 0
    text = capsys.readouterr().out
    assert "fuse_emitter: node 'a' becomes the emitter of farm 'b'" in text
    assert "optimize: 7 nodes -> 5 nodes" in text
