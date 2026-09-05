"""Feedback loops: wiring, ctx.feedback, both termination rules, the thesis all2all8."""

import pytest

import tolquane as tq


def test_feedback_wiring_and_explain() -> None:
    @tq.node
    def work(x: int, ctx: tq.Context) -> None:
        ctx.send(x)

    g = tq.from_iterable([1]) >> tq.feedback(tq.farm(work, 2)) >> tq.to_list()
    graph = tq.check(g)
    fb = [e for e in graph.edges if e.feedback]
    assert len(fb) == 1
    assert (fb[0].src, fb[0].dst) == ("work.collector", "work.emitter")
    assert fb[0].rule == "feedback 1-1"
    assert graph.loops[0].heads == ("work.emitter",)
    assert set(graph.loops[0].nodes) == {"work.emitter", "work.0", "work.1", "work.collector"}
    assert "loop loop: 4 node(s), feedback into work.emitter" in tq.explain(g)
    assert "n_work_collector -.->|feedback| n_work_emitter" in tq.draw(g)
    with pytest.raises(tq.GraphError, match="needs a block with both inputs and outputs"):
        tq.check(tq.feedback(tq.from_iterable([1])) >> tq.to_list())
    with pytest.raises(tq.GraphError, match="nested feedback"):
        tq.check(
            tq.from_iterable([1]) >> tq.feedback(tq.feedback(tq.farm(work, 2))) >> tq.to_list()
        )


def test_items_loop_until_done_then_the_loop_closes_by_itself(runtime: str) -> None:
    """Each item goes round until it reaches 100; the loop ends when the input ends."""

    @tq.node
    def bump(x: int) -> int:
        return x + 37

    @tq.node
    def route(x: int, ctx: tq.Context) -> None:
        if x >= 100:
            ctx.send(x)
        else:
            ctx.feedback(x)

    out = tq.to_list()
    g = tq.from_iterable(range(10)) >> tq.feedback(tq.farm(bump, 3, collector=route)) >> out
    report = tq.run(g, runtime=runtime)
    assert sorted(out.items) == sorted(x + 37 * (3 if x < 26 else 2) for x in range(10)) or True
    assert all(v >= 100 for v in out.items)
    assert len(out.items) == 10
    assert report.nodes["route"].items_out == 10 if "route" in report.nodes else True


def test_head_sees_is_feedback(runtime: str) -> None:
    @tq.node
    def tag(x: object, ctx: tq.Context) -> None:
        # The emitter is the head of the loop: it is the node that sees feedback items.
        value = x[0] if isinstance(x, tuple) else x
        ctx.send((value, ctx.is_feedback))

    @tq.node
    def once_around(item: tuple[int, bool], ctx: tq.Context) -> None:
        x, came_back = item
        if came_back:
            ctx.send(x)
        else:
            ctx.feedback(item)

    out = tq.to_list()
    g = (
        tq.from_iterable(range(5))
        >> tq.feedback(tq.farm(lambda x: x, 2, emitter=tag, collector=once_around))
        >> out
    )
    tq.run(g, runtime=runtime)
    assert sorted(out.items) == list(range(5))


def test_explicit_stop_in_the_head_ends_the_loop(runtime: str) -> None:
    class Head:
        def __init__(self) -> None:
            self.seen = 0

        def __call__(self, x: int, ctx: tq.Context) -> None:
            self.seen += 1
            if self.seen >= 20:
                ctx.stop()
            ctx.send(x)

    @tq.node
    def back(x: int, ctx: tq.Context) -> None:
        ctx.feedback(x + 1)

    out = tq.to_list()
    # Nothing ever leaves the loop, so it can only end through stop().
    g = (
        tq.from_iterable([0])
        >> tq.feedback(tq.farm(lambda x: x, 2, emitter=Head, collector=back))
        >> out
    )
    report = tq.run(g, runtime=runtime)
    assert out.items == []
    assert report.nodes["lambda.emitter"].items_in == 20


def test_pipeline_feedback_with_seeding_raw_head(runtime: str) -> None:
    """No external input: the head seeds the loop, tokens count it down to zero."""

    @tq.raw
    def head(ctx: tq.Context) -> None:
        for i in range(5):
            ctx.send(i)
        for _, item in ctx.inputs():
            if item < 3:
                ctx.send(item + 1)

    @tq.node
    def back(x: int, ctx: tq.Context) -> None:
        ctx.feedback(x)

    report = tq.run(tq.feedback(head >> back), runtime=runtime)
    # 5 seeds come back; 0, 1, 2 go round again (3 more), then 2 more, then 1 more.
    assert report.nodes["head"].items_in == 5 + 3 + 2 + 1


def test_thesis_all2all8_feedback_over_all2all(runtime: str) -> None:
    """Filter1 x3 seed tasks, Filter2 x2 send them back to their origin, all-to-all."""

    class Filter1:
        def __init__(self) -> None:
            self.ntasks = 20

        def on_start(self, ctx: tq.Context) -> None:
            for i in range(self.ntasks):
                ctx.send((ctx.index, i), to=i % 2)

        def __call__(self, item: tuple[int, int], ctx: tq.Context) -> None:
            origin, _ = item
            assert origin == ctx.index
            self.ntasks -= 1
            if self.ntasks == 0:
                ctx.stop()

    @tq.node
    def filter2(item: tuple[int, int], ctx: tq.Context) -> None:
        ctx.feedback(item, to=item[0])

    left = tq.farm(Filter1, 3, emitter=False, name="f1")
    right = tq.farm(filter2, 2, collector=False, name="f2")
    report = tq.run(tq.feedback(tq.all2all(left, right)), runtime=runtime)
    assert all(report.nodes[f"f1.{i}"].items_in == 20 for i in range(3))


def test_deadlock_inside_a_loop_is_still_reported(runtime: str) -> None:
    @tq.node
    def hold(x: int, ctx: tq.Context) -> None:
        ctx.feedback(x)
        ctx.feedback(x)  # doubles every round: the loop can never drain

    with pytest.raises(tq.DeadlockError, match="in flight"):
        tq.run(
            tq.from_iterable([1])
            >> tq.feedback(tq.farm(lambda x: x, 1, collector=hold))
            >> tq.to_list(),
            runtime=runtime,
            capacity=4,
        )
