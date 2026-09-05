"""Node execution: the ``Context`` handed to user code and the loop that drives a node."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING, Any

from ._sentinels import SKIP
from .channel import Tagged
from .errors import Cancelled, TolquaneError
from .graph import NodeSpec, _positional_arity

if TYPE_CHECKING:
    from .runtime import NodeInstance, RunContext


class Context:
    """What a node can do while it runs: send items, see where they came from, stop."""

    def __init__(
        self,
        inst: NodeInstance,
        rc: RunContext,
        *,
        sender: Callable[[Any], None] | None = None,
        outer: Context | None = None,
    ) -> None:
        self._inst = inst
        self._rc = rc
        self._sender = sender
        self._outer = outer
        self._stopped = False
        self._token_pending = False
        self.name: str = inst.spec.name
        self.index: int = inst.spec.index
        self.source: int | None = None
        if sender is None:
            # One call fewer per item: the outbox handles ``to=`` itself.
            self.send = inst.outbox.send  # type: ignore[method-assign]

    @property
    def n_inputs(self) -> int:
        return len(self._inst.inbox.edges_in)

    @property
    def n_outputs(self) -> int:
        return len(self._inst.outbox.edges)

    @property
    def stopped(self) -> bool:
        if self._outer is not None:
            return self._outer.stopped
        return self._stopped

    @property
    def cancelled(self) -> bool:
        """True once the run is being cancelled; long-running raw nodes should return."""
        return self._rc.cancelled

    @property
    def is_feedback(self) -> bool:
        """True when the current item arrived on a feedback edge."""
        src = self.source
        return src is not None and self._inst.inbox.edges_in[src].feedback

    def send(self, item: Any, *, to: int | None = None) -> None:
        """Send ``item`` downstream: round robin by default, or to output ``to``."""
        if self._sender is not None:
            self._sender(item)
        elif to is None:
            self._inst.outbox.send(item)
        else:
            self._inst.outbox.send_to(to, item)

    def broadcast(self, item: Any) -> None:
        """Send the same object to every output. Receivers must treat it as read-only."""
        if self._sender is not None:
            self._sender(item)
        else:
            self._inst.outbox.broadcast(item)

    def feedback(self, item: Any, *, to: int | None = None) -> None:
        """Send ``item`` back to the start of the enclosing ``tq.feedback`` block."""
        if self._outer is not None:
            self._outer.feedback(item, to=to)
        else:
            self._inst.outbox.feedback(item, to)

    def flush(self) -> None:
        """Send any batched output now. Raw nodes that block outside Tolquane (a socket,
        a queue) should call this before blocking, so downstream is not kept waiting."""
        self._inst.outbox.flush()

    def stop(self) -> None:
        """Finish this node after the current item. Its outputs are closed normally."""
        if self._outer is not None:
            self._outer.stop()
        self._stopped = True

    def recv(self, source: int | None = None) -> tuple[int, Any] | None:
        """Raw nodes: next ``(source, item)``, or ``None`` once every input has ended."""
        strat = self._inst.strategy
        if strat is None:
            raise TolquaneError(f"node {self.name!r} has no inputs to receive from")
        if source is not None and not strat.supports_selective:
            raise TolquaneError(
                f"node {self.name!r} uses collect={self._inst.spec.collect!r}; "
                "recv(source=...) needs the default first_come delivery"
            )
        self._finish_token()
        r = strat.next(source)
        if r is not None:
            self.source = r[0]
            self._inst.stats.items_in += 1
            if self._inst.loop is not None:
                self._token_pending = True
        return r

    def inputs(self) -> Iterator[tuple[int, Any]]:
        """Raw nodes: iterate ``(source, item)`` pairs until every input has ended."""
        while not self.stopped:
            r = self.recv()
            if r is None:
                return
            yield r

    def _finish_token(self) -> None:
        if self._token_pending:
            self._token_pending = False
            assert self._inst.loop is not None
            self._inst.loop.done()


class _Prepared:
    __slots__ = ("fn", "on_end", "on_start")

    def __init__(self, fn: Any, on_start: Any, on_end: Any) -> None:
        self.fn = fn
        self.on_start = on_start
        self.on_end = on_end


def _prepare(spec: NodeSpec) -> _Prepared:
    obj = spec.target() if spec.factory else spec.target
    on_start = None
    on_end = None
    if not callable(getattr(obj, "__func__", None)) and not isinstance(obj, type(_prepare)):
        on_start = getattr(obj, "on_start", None)
        on_end = getattr(obj, "on_end", None)
    return _Prepared(obj, on_start, on_end)


def _call_hook(hook: Any, ctx: Context) -> None:
    if hook is None:
        return
    arity = _positional_arity(hook)
    if arity == 0:
        hook()
    else:
        hook(ctx)


def _process(spec: NodeSpec, fn: Any, item: Any, ctx: Context) -> None:
    kind = spec.kind
    if kind == "map":
        r = fn(item)
        if spec.is_sink:
            return
        if r is not SKIP:
            ctx.send(r)
    elif kind == "flat":
        for y in fn(item):
            if ctx.stopped:
                break
            ctx.send(y)
    elif kind == "ctx":
        r = fn(item, ctx)
        if spec.generator:
            for y in r:
                if ctx.stopped:
                    break
                ctx.send(y)
        elif r is not None and not spec.is_sink:
            raise TolquaneError(
                f"node {spec.name!r} takes (item, ctx) so it must send with ctx.send(); "
                f"it returned a {type(r).__name__} instead"
            )
    else:  # pragma: no cover - other kinds never reach here
        raise TolquaneError(f"cannot process items in a {kind} node")


def _run_source(spec: NodeSpec, fn: Any, ctx: Context) -> None:
    items = fn()
    if items is None:
        raise TolquaneError(
            f"source {spec.name!r} returned None; a source yields items or returns an iterable"
        )
    send = ctx.send
    for item in items:
        if ctx._stopped:
            break
        send(item)


def _run_items(inst: NodeInstance, spec: NodeSpec, fn: Any, ctx: Context) -> None:
    strat = inst.strategy
    if strat is None:
        return  # no inputs: the node's on_start hook did all the producing
    outbox = inst.outbox
    loop = inst.loop
    tagging = spec.tagged and spec.role == "worker"
    fast = loop is None and not tagging
    plain_map = spec.kind == "map" and not spec.is_sink
    plain_sink = spec.kind == "map" and spec.is_sink
    stats = inst.stats
    while not ctx.stopped:
        if fast:
            taken = strat.take_batch()
            if taken is not None:
                src, items = taken
                ctx.source = src
                stats.items_in += len(items)
                if plain_map:
                    send = ctx.send
                    for item in items:
                        r = fn(item)
                        if r is not SKIP:
                            send(r)
                        if ctx._stopped:
                            break
                elif plain_sink:
                    for item in items:
                        fn(item)
                        if ctx._stopped:
                            break
                else:
                    for item in items:
                        if ctx._stopped:
                            break
                        _process(spec, fn, item, ctx)
                continue
        r = strat.next()
        if r is None:
            break
        src, item = r
        ctx.source = src
        stats.items_in += 1
        if tagging and isinstance(item, Tagged):
            outbox.begin_item(item)
            _process(spec, fn, item.item, ctx)
            outbox.end_item()
        else:
            _process(spec, fn, item, ctx)
        if loop is not None:
            loop.done()


def _run_comb(inst: NodeInstance, rc: RunContext, ctx: Context) -> None:
    specs: tuple[NodeSpec, ...] = inst.spec.target
    prepared = [_prepare(s) for s in specs]
    # Build the chain back to front: each context sends into the next node's processing.
    contexts: list[Context] = [ctx]
    for i in range(len(specs) - 2, -1, -1):
        nxt_spec, nxt_fn, nxt_ctx = specs[i + 1], prepared[i + 1].fn, contexts[0]

        def sender(y: Any, s: NodeSpec = nxt_spec, f: Any = nxt_fn, c: Context = nxt_ctx) -> None:
            _process(s, f, y, c)

        contexts.insert(0, Context(inst, rc, sender=sender, outer=ctx))
    for p, c in zip(prepared, contexts, strict=True):
        _call_hook(p.on_start, c)
    strat = inst.strategy
    loop = inst.loop
    first_spec, first_fn, first_ctx = specs[0], prepared[0].fn, contexts[0]
    while strat is not None and not ctx.stopped:
        r = strat.next()
        if r is None:
            break
        src, item = r
        for c in contexts:
            c.source = src
        inst.stats.items_in += 1
        _process(first_spec, first_fn, item, first_ctx)
        if loop is not None:
            loop.done()
    for p, c in zip(prepared, contexts, strict=True):
        _call_hook(p.on_end, c)


def run_node(inst: NodeInstance, rc: RunContext) -> None:
    """Thread body for one node. Closes outputs and reports completion whatever happens."""
    spec = inst.spec
    ctx = Context(inst, rc)
    try:
        rc.scheduler.node_started(inst)
        if spec.kind == "comb":
            _run_comb(inst, rc, ctx)
        else:
            prepared = _prepare(spec)
            _call_hook(prepared.on_start, ctx)
            if spec.kind == "source":
                _run_source(spec, prepared.fn, ctx)
            elif spec.kind == "raw":
                prepared.fn(ctx)
            else:
                _run_items(inst, spec, prepared.fn, ctx)
            _call_hook(prepared.on_end, ctx)
    except Cancelled:
        pass
    except BaseException as exc:
        rc.fail(inst, exc)
    finally:
        try:
            ctx._finish_token()
            inst.outbox.close_all()
        except Cancelled:
            pass
        except BaseException as exc:
            rc.fail(inst, exc)
        inst.inbox.mark_done()
        rc.node_done(inst)
