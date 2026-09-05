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
        self.name: str = inst.spec.name
        self.index: int = inst.spec.index
        self.source: int | None = None

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
        r = strat.next(source)
        if r is not None:
            self.source = r[0]
            self._inst.stats.items_in += 1
        return r

    def inputs(self) -> Iterator[tuple[int, Any]]:
        """Raw nodes: iterate ``(source, item)`` pairs until every input has ended."""
        while not self.stopped:
            r = self.recv()
            if r is None:
                return
            yield r


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
    for item in items:
        if ctx.stopped:
            break
        ctx.send(item)


def _run_items(inst: NodeInstance, spec: NodeSpec, fn: Any, ctx: Context) -> None:
    strat = inst.strategy
    assert strat is not None
    outbox = inst.outbox
    tagging = spec.tagged and spec.role == "worker"
    while not ctx.stopped:
        r = strat.next()
        if r is None:
            break
        src, item = r
        ctx.source = src
        inst.stats.items_in += 1
        if tagging and isinstance(item, Tagged):
            outbox.begin_item(item)
            _process(spec, fn, item.item, ctx)
            outbox.end_item()
        else:
            _process(spec, fn, item, ctx)


def _run_comb(inst: NodeInstance, rc: RunContext, ctx: Context) -> None:
    spec_a, spec_b = inst.spec.target
    a = _prepare(spec_a)
    b = _prepare(spec_b)
    inner = Context(inst, rc, sender=lambda y: _process(spec_b, b.fn, y, ctx), outer=ctx)
    _call_hook(a.on_start, inner)
    _call_hook(b.on_start, ctx)
    strat = inst.strategy
    assert strat is not None
    while not ctx.stopped:
        r = strat.next()
        if r is None:
            break
        src, item = r
        ctx.source = src
        inner.source = src
        inst.stats.items_in += 1
        _process(spec_a, a.fn, item, inner)
    _call_hook(a.on_end, inner)
    _call_hook(b.on_end, ctx)


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
            inst.outbox.close_all()
        except Cancelled:
            pass
        except BaseException as exc:
            rc.fail(inst, exc)
        inst.inbox.mark_done()
        rc.node_done(inst)
