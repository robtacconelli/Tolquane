"""Consumer-side delivery strategies: how a node's inbox hands items to its code."""

from __future__ import annotations

from collections import deque
from typing import TYPE_CHECKING, Any

from ._sentinels import END, EOS
from .channel import TaggedOut, Window
from .errors import TolquaneError

if TYPE_CHECKING:
    from .channel import Inbox


class Strategy:
    """Delivers ``(source_index, item)`` pairs; ``None`` once every source has ended."""

    supports_selective = False

    def __init__(self, inbox: Inbox) -> None:
        self.inbox = inbox
        self.remaining = len(inbox.edges_in)
        self.ended: set[int] = set()

    def next(self, source: int | None = None) -> tuple[int, Any] | None:
        raise NotImplementedError

    def _pop(self) -> tuple[int, Any] | None:
        """Pop the next non-EOS entry, or None when every source has ended.

        The entry still holds its producer's credit; call ``self.inbox.release(src)``
        when it is handed to user code, so that buffered items keep applying
        backpressure instead of growing without bound.
        """
        while self.remaining > 0:
            src, item = self.inbox.pop()
            if item is EOS:
                self.inbox.release(src)
                self.remaining -= 1
                self.ended.add(src)
                self.on_source_ended(src)
                continue
            return src, item
        return None

    def _deliver(self, src: int, item: Any) -> tuple[int, Any]:
        self.inbox.release(src)
        return src, item

    def on_source_ended(self, src: int) -> None:
        pass


class FirstCome(Strategy):
    """Items in arrival order. Also supports waiting for one specific source."""

    supports_selective = True

    def __init__(self, inbox: Inbox) -> None:
        super().__init__(inbox)
        self.buffers: dict[int, deque[Any]] = {}

    def next(self, source: int | None = None) -> tuple[int, Any] | None:
        if source is None:
            for src, buf in self.buffers.items():
                if buf:
                    return self._deliver(src, buf.popleft())
            r = self._pop()
            return None if r is None else self._deliver(*r)
        buf = self.buffers.setdefault(source, deque())
        if buf:
            return self._deliver(source, buf.popleft())
        while True:
            if source in self.ended:
                return None
            r = self._pop()
            if r is None:
                return None
            src, item = r
            if src == source:
                return self._deliver(src, item)
            self.buffers.setdefault(src, deque()).append(item)


class RoundRobin(Strategy):
    """Take one item from each source in turn, skipping sources that have ended."""

    def __init__(self, inbox: Inbox) -> None:
        super().__init__(inbox)
        self.buffers: dict[int, deque[Any]] = {i: deque() for i in range(len(inbox.edges_in))}
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
                item = buf.popleft()
                src = self.expected
                self._advance()
                return self._deliver(src, item)
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
            src, item = r
            if src == self.expected:
                self._advance()
                return self._deliver(src, item)
            self.buffers[src].append(item)


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
            src, item = r
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
