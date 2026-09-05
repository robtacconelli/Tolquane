"""Async nodes: coroutine functions run on an event loop inside the threads runtime.

``async def fetch(url)`` is a node like any other. On its own it is a pool of one; in
``tq.farm(fetch, workers=200)`` it is one pool node running up to 200 coroutines at a
time on a single thread, which is what network-bound stages want: many sockets waiting
at once without many threads. An async generator is a flat map; an async generator
with no parameters is a source.

The node's own thread feeds the loop and drains it: it takes items from its inbox
while a slot is free, and the loop thread posts every finished result back into that
same inbox, so the node waits in one place for either. That keeps the node a single
thread as far as the schedulers and the deadlock detector are concerned; the
coroutines in flight are reported as work outside the channels. Backpressure is the
number of coroutines in flight (``workers``) on the way in and the outbox credits on
the way out.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
from typing import TYPE_CHECKING, Any

from ._sentinels import SKIP
from .errors import TolquaneError
from .graph import _positional_arity

if TYPE_CHECKING:
    from .runner import Context
    from .runtime import NodeInstance, RunContext

_END = object()


class _Result:
    """What the loop thread posts to the node's inbox when a coroutine finishes."""

    __slots__ = ("payload", "sem", "seq")

    def __init__(self, seq: int, payload: Any, sem: asyncio.Semaphore | None = None) -> None:
        self.seq = seq
        self.payload = payload  # outputs to send, or the exception raised
        self.sem = sem  # a source's permit to give back once the item is sent


class _Pool:
    def __init__(self, inst: NodeInstance, rc: RunContext, ctx: Context, fn: Any) -> None:
        self.inst = inst
        self.rc = rc
        self.ctx = ctx
        self.fn = fn
        self.spec = inst.spec
        self.workers = max(1, self.spec.concurrency)
        self.loop = asyncio.new_event_loop()

    # ---------------------------------------------------------------- loop thread

    def start(self) -> None:
        threading.Thread(
            target=self._run_loop, name=f"tolquane:{self.spec.name}:loop", daemon=True
        ).start()

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        finally:
            pending = asyncio.all_tasks(self.loop)
            for task in pending:
                task.cancel()
            if pending:
                self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self.loop.close()

    def _post(self, result: _Result, *, finished: bool = True) -> None:
        self.inst.inbox.push_control(result)
        self.rc.scheduler.event(self.inst, -1 if finished else 0)

    async def _work(self, seq: int, item: Any) -> None:
        try:
            if self.spec.kind == "flat":
                outputs = [y async for y in self.fn(item)]
            else:
                r = await self.fn(item)
                outputs = [] if r is SKIP or self.spec.is_sink else [r]
            self._post(_Result(seq, outputs))
        except BaseException as exc:
            self._post(_Result(seq, exc))

    async def _source(self) -> None:
        # The generator may run ahead of the node by one outbox worth of items; while it
        # is parked on the semaphore the node has nothing in flight, which is what the
        # deadlock detector needs to know. The node counted it in flight before starting it.
        sem = asyncio.Semaphore(self.inst.outbox_capacity())
        seq = 0
        try:
            agen = self.fn()
            if inspect.isawaitable(agen):
                agen = await agen
            if hasattr(agen, "__aiter__"):
                async for item in agen:
                    await self._permit(sem)
                    self._post(_Result(seq, [item], sem), finished=False)
                    seq += 1
            else:
                for item in agen:
                    await self._permit(sem)
                    self._post(_Result(seq, [item], sem), finished=False)
                    seq += 1
        except BaseException as exc:
            self._post(_Result(seq, exc))
        else:
            self._post(_Result(seq, _END))

    async def _permit(self, sem: asyncio.Semaphore) -> None:
        if not sem.locked():
            await sem.acquire()
            return
        self.rc.scheduler.event(self.inst, -1)  # parked: nothing runs until the node sends
        await sem.acquire()
        self.rc.scheduler.event(self.inst, +1)

    # ---------------------------------------------------------------- node thread

    def call(self, hook: Any) -> None:
        """Run a hook on the loop when it is a coroutine function, else right here."""
        if hook is None:
            return
        arity = _positional_arity(hook)
        args = () if arity == 0 else (self.ctx,)
        if inspect.iscoroutinefunction(hook):
            asyncio.run_coroutine_threadsafe(hook(*args), self.loop).result()
        else:
            hook(*args)

    def run(self) -> None:
        if self.spec.kind == "source":
            self._run_source()
        else:
            self._run_items()

    def _run_source(self) -> None:
        self.rc.scheduler.event(self.inst, +1)
        asyncio.run_coroutine_threadsafe(self._source(), self.loop)
        inbox = self.inst.inbox
        while True:
            _, entry = inbox.pop()
            payload = entry.payload
            if payload is _END:
                return
            if isinstance(payload, BaseException):
                raise payload
            self._emit(payload)
            if entry.sem is not None:
                self.loop.call_soon_threadsafe(entry.sem.release)

    def _run_items(self) -> None:
        inst = self.inst
        strat = inst.strategy
        ctx = self.ctx
        ended = strat is None  # no inputs: on_start did all the producing
        in_flight = 0  # submitted and not yet taken back: coroutines running or results posted
        seq = 0
        pending: dict[int, list[Any]] = {}  # ordered=True: results waiting their turn
        expect = 0
        while True:
            if strat is not None and not ended and in_flight < self.workers and not ctx.stopped:
                r = strat.next()  # the next item, or the next finished result
            elif in_flight > 0:
                assert strat is not None
                r = strat.next(source=-1)  # every slot is taken: results only
            else:
                return
            if r is None:
                ended = True
                continue
            src, entry = r
            if src >= 0:
                inst.stats.items_in += 1
                in_flight += 1
                self.rc.scheduler.event(inst, +1)
                self.loop.call_soon_threadsafe(self._submit, seq, entry)
                seq += 1
                continue
            in_flight -= 1
            payload = entry.payload
            if isinstance(payload, BaseException):
                raise payload
            if self.spec.ordered:
                pending[entry.seq] = payload
                while expect in pending:
                    self._emit(pending.pop(expect))
                    expect += 1
            else:
                self._emit(payload)

    def _submit(self, seq: int, item: Any) -> None:
        self.loop.create_task(self._work(seq, item))

    def _emit(self, outputs: list[Any]) -> None:
        send = self.ctx.send
        for y in outputs:
            send(y)
        if self.inst.loop is not None:
            self.inst.loop.done()


def run_async_node(inst: NodeInstance, rc: RunContext, ctx: Context, prepared: Any) -> None:
    """Node body for coroutine functions, async generators and async classes."""
    if inst.spec.kind == "ctx":  # refused at build time already; a backstop
        raise TolquaneError(
            f"async node {inst.spec.name!r} takes (item, ctx); coroutines take the item "
            "only and return (or yield) what to send"
        )
    pool = _Pool(inst, rc, ctx, prepared.fn)
    pool.start()
    try:
        pool.call(prepared.on_start)
        pool.run()
        if not rc.cancelled:
            pool.call(prepared.on_end)
    finally:
        inst.in_flight = 0
        pool.stop()
