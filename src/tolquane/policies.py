"""Consumer-side delivery strategies: how a node's inbox hands items to its code."""

from __future__ import annotations

from collections import deque
from typing import TYPE_CHECKING, Any

from ._sentinels import END, EOS, LOOP_DONE
from .channel import Batch, TaggedOut, Window
from .errors import TolquaneError

if TYPE_CHECKING:
    from .channel import Inbox


class Strategy:
    """Delivers ``(source_index, item)`` pairs; ``None`` once every source has ended.

    Credits go back to the producer when an item is delivered to user code, whether it
    arrived alone or in a batch, so held-back items keep applying backpressure. The
    fast path ``take_batch`` delivers a whole batch at once and releases it at once.
    """

    supports_selective = False

    def __init__(self, inbox: Inbox) -> None:
        self.inbox = inbox
        self.remaining = len(inbox.edges_in)
        self.ended: set[int] = set()
        self._batch: list[Any] | None = None
        self._batch_pos = 0
        self._batch_src = -1

    def next(self, source: int | None = None) -> tuple[int, Any] | None:
        raise NotImplementedError

    def take_batch(self) -> tuple[int, list[Any]] | None:
        """Fast path: the rest of the current batch, when nothing is held back."""
        return None

    def _drain_batch(self) -> tuple[int, list[Any]]:
        assert self._batch is not None
        src = self._batch_src
        batch = self._batch
        pos = self._batch_pos
        items = batch if pos == 0 else batch[pos:]
        self._batch = None
        self.inbox.release(src, len(items))
        self._entered_many(src, len(items))
        return src, items

    def _pop(self, watch: int | None = None) -> tuple[int, Any, bool] | None:
        """Next ``(src, item, batched)``, unpacking batches, handling EOS and loop control.

        Returns ``None`` when every source has ended, or as soon as source ``watch``
        ends, so that a selective receive never waits for sources it is not reading.
        """
        while True:
            batch = self._batch
            if batch is not None:
                src = self._batch_src
                pos = self._batch_pos
                item = batch[pos]
                pos += 1
                if pos >= len(batch):
                    self._batch = None
                else:
                    self._batch_pos = pos
                self._entered(src)
                return src, item, True
            if self.remaining <= 0 and watch != -1:
                return None
            src, entry = self.inbox.pop()
            if entry is EOS:
                self.inbox.release(src)
                if src not in self.ended:
                    self.ended.add(src)
                    self.remaining -= 1
                    self.on_source_ended(src)
                    edge = self.inbox.edges_in[src]
                    if edge.entry_loop is not None:
                        edge.entry_loop.external_ended()
                if src == watch:
                    return None
                continue
            if src < 0 and entry is not LOOP_DONE:
                return src, entry, False  # an event the node posted to itself (async pools)
            if entry is LOOP_DONE:
                for i, edge in enumerate(self.inbox.edges_in):
                    if edge.feedback and i not in self.ended:
                        self.ended.add(i)
                        self.remaining -= 1
                        self.on_source_ended(i)
                if watch is not None and watch in self.ended:
                    return None
                continue
            if isinstance(entry, Batch):
                self._batch = entry.items
                self._batch_pos = 0
                self._batch_src = src
                continue
            self._entered(src)
            return src, entry, False

    def _entered(self, src: int) -> None:
        loop = self.inbox.edges_in[src].entry_loop
        if loop is not None:
            loop.enter()

    def _entered_many(self, src: int, n: int) -> None:
        loop = self.inbox.edges_in[src].entry_loop
        if loop is not None:
            for _ in range(n):
                loop.enter()

    def _deliver(self, src: int, item: Any, batched: bool) -> tuple[int, Any]:
        self.inbox.release(src)
        return src, item

    def on_source_ended(self, src: int) -> None:
        pass


class FirstCome(Strategy):
    """Items in arrival order. Also supports waiting for one specific source."""

    supports_selective = True

    def __init__(self, inbox: Inbox) -> None:
        super().__init__(inbox)
        self.buffers: dict[int, deque[tuple[Any, bool]]] = {}
        self._buffered = 0

    def take_batch(self) -> tuple[int, list[Any]] | None:
        if self._buffered or self._batch is None:
            return None
        return self._drain_batch()

    def next(self, source: int | None = None) -> tuple[int, Any] | None:
        if source is None:
            if self._buffered:
                for src, buf in self.buffers.items():
                    if buf:
                        self._buffered -= 1
                        item, batched = buf.popleft()
                        return self._deliver(src, item, batched)
            r = self._pop()
            if r is None:
                return None
            if r[0] < 0:
                return r[0], r[1]
            return self._deliver(*r)
        buf = self.buffers.setdefault(source, deque())
        if buf:
            self._buffered -= 1
            item, batched = buf.popleft()
            return self._deliver(source, item, batched)
        while True:
            if source in self.ended:
                return None
            r = self._pop(watch=source)
            if r is None:
                return None
            src, item, batched = r
            if src < 0:
                return src, item
            if src == source:
                return self._deliver(src, item, batched)
            self.buffers.setdefault(src, deque()).append((item, batched))
            self._buffered += 1


class RoundRobin(Strategy):
    """Take one item from each source in turn, skipping sources that have ended."""

    def __init__(self, inbox: Inbox) -> None:
        super().__init__(inbox)
        self.buffers: dict[int, deque[tuple[Any, bool]]] = {
            i: deque() for i in range(len(inbox.edges_in))
        }
        self.expected = 0

    def _advance(self) -> None:
        n = len(self.buffers)
        for _ in range(n):
            self.expected = (self.expected + 1) % n
            if self.expected not in self.ended or self.buffers[self.expected]:
                return

    def next(self, source: int | None = None) -> tuple[int, Any] | None:
        while True:
            if not self.buffers:
                return None
            buf = self.buffers[self.expected]
            if buf:
                item, batched = buf.popleft()
                src = self.expected
                self._advance()
                return self._deliver(src, item, batched)
            if self.expected in self.ended:
                if self.remaining == 0 and not any(self.buffers.values()):
                    return None
                self._advance()
                continue
            r = self._pop()
            if r is None:
                if any(self.buffers.values()):
                    self._advance()
                    continue
                return None
            src, item, batched = r
            if src == self.expected:
                self._advance()
                return self._deliver(src, item, batched)
            self.buffers[src].append((item, batched))


class _SeqState:
    __slots__ = ("ended", "nparts", "outs")

    def __init__(self, nparts: int) -> None:
        self.nparts = nparts
        self.outs: dict[int, list[tuple[int, Any]]] = {}
        self.ended: set[int] = set()

    @property
    def complete(self) -> bool:
        return len(self.ended) == self.nparts


class Reorder(Strategy):
    """Release tagged outputs in sequence order (``ordered``) or as one list (``gather``)."""

    def __init__(self, inbox: Inbox, window: Window | None, gather: bool) -> None:
        super().__init__(inbox)
        self.window = window
        self.gather = gather
        self.pending: dict[int, _SeqState] = {}
        self.next_seq = 0
        self.ready: deque[tuple[int, Any]] = deque()

    def next(self, source: int | None = None) -> tuple[int, Any] | None:
        while True:
            if self.ready:
                return self.ready.popleft()
            r = self._pop()
            if r is None:
                if self.pending:
                    raise TolquaneError(
                        f"collector {self.inbox.inst.spec.name!r} ended with {len(self.pending)} "
                        "incomplete tagged item(s); a worker closed without finishing them"
                    )
                return None
            src, item, _ = r
            self.inbox.release(src)  # the window bounds memory here, not the edge credit
            if not isinstance(item, TaggedOut):
                return src, item
            self._add(src, item)

    def _add(self, src: int, t: TaggedOut) -> None:
        st = self.pending.get(t.seq)
        if st is None:
            st = self.pending[t.seq] = _SeqState(t.nparts)
        if t.item is END:
            st.ended.add(t.part)
        else:
            st.outs.setdefault(t.part, []).append((t.sub, t.item))
        while self.next_seq in self.pending and self.pending[self.next_seq].complete:
            done = self.pending.pop(self.next_seq)
            self.next_seq += 1
            if self.window is not None:
                self.window.release()
            items = [it for part in sorted(done.outs) for _, it in sorted(done.outs[part])]
            if self.gather:
                merged: list[Any] = []
                for it in items:
                    if isinstance(it, list | tuple):
                        merged.extend(it)
                    else:
                        merged.append(it)
                self.ready.append((src, merged))
            else:
                self.ready.extend((src, it) for it in items)


def make_strategy(inbox: Inbox, collect: str, window: Window | None) -> Strategy:
    if collect == "first_come":
        return FirstCome(inbox)
    if collect == "round_robin":
        return RoundRobin(inbox)
    if collect == "ordered":
        return Reorder(inbox, window, gather=False)
    if collect == "gather":
        return Reorder(inbox, window, gather=True)
    raise TolquaneError(f"unknown collect policy {collect!r}")  # pragma: no cover
