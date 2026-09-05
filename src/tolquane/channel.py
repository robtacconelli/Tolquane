"""Channels: the inbox every node waits on, the outbox it sends from, and the edges.

Locking discipline: an outbox lock may be held while an inbox lock is taken (a producer
pushing a flushed batch), never the other way round. Producers wait on the outbox
``space`` condition for credits, consumers wait on the inbox ``not_empty`` condition,
and every wait goes through the scheduler so cancellation and deadlock detection see it.

Credits count items, not entries: a batch of k items takes k credits when it is pushed
and gives them back one by one as the consumer delivers the items to user code.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ._sentinels import END, EOS, LOOP_DONE
from .errors import ChannelClosed, TolquaneError

if TYPE_CHECKING:
    from .graph import LoopSpec
    from .runtime import NodeInstance, RunContext

FLUSH_AFTER = 0.001
"""Seconds a partial batch may wait before it is sent anyway."""


@dataclass(frozen=True, slots=True)
class Tagged:
    """An item on its way from a tagging emitter to a worker."""

    seq: int
    part: int
    nparts: int
    item: Any


@dataclass(frozen=True, slots=True)
class TaggedOut:
    """A worker output (or END marker) on its way to an ordered or gather collector."""

    seq: int
    part: int
    nparts: int
    sub: int
    item: Any


class Batch:
    """Several items travelling as one queue entry."""

    __slots__ = ("items",)

    def __init__(self, items: list[Any]) -> None:
        self.items = items


class Window:
    """Bounds the number of tagged items in flight between an emitter and its collector."""

    def __init__(self, limit: int, rc: RunContext) -> None:
        self.limit = limit
        self.rc = rc
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.in_flight = 0
        rc.register_cond(self.cond)

    def acquire(self, inst: NodeInstance) -> None:
        if inst.outbox.has_pending:
            # Never wait with items still batched: the collector needs them to release.
            inst.outbox.flush()
        with self.lock:
            self.rc.scheduler.wait(
                inst,
                self.cond,
                lambda: self.in_flight < self.limit,
                "window",
                f"waiting for the collector to release items (window {self.limit})",
            )
            self.in_flight += 1

    def release(self) -> None:
        with self.lock:
            self.in_flight -= 1
            self.cond.notify_all()


class Loop:
    """Termination bookkeeping for one feedback loop.

    ``tokens`` counts items inside the loop: an item entering from outside, or sent on
    an edge inside the loop, adds one; a node finishing with an item removes one. When
    every external input has ended and no token is left, the loop's heads are told to
    treat their feedback inputs as ended.
    """

    def __init__(self, spec: LoopSpec, rc: RunContext) -> None:
        self.name = spec.name
        self.rc = rc
        self.lock = threading.Lock()
        self.tokens = 0
        self.external_remaining = 0
        self.closed = False
        self.heads: list[NodeInstance] = []

    def enter(self) -> None:
        with self.lock:
            self.tokens += 1

    def sent(self, n: int = 1) -> None:
        with self.lock:
            self.tokens += n

    def done(self) -> None:
        with self.lock:
            self.tokens -= 1
            close = self._should_close()
        if close:
            self._close()

    def external_ended(self) -> None:
        with self.lock:
            self.external_remaining -= 1
            close = self._should_close()
        if close:
            self._close()

    def _should_close(self) -> bool:
        if self.closed or self.external_remaining > 0 or self.tokens > 0:
            return False
        self.closed = True
        return True

    def _close(self) -> None:
        for head in self.heads:
            head.inbox.push_control(LOOP_DONE)

    def describe(self) -> str:
        return (
            f"loop {self.name}: {self.tokens} item(s) in flight, "
            f"{self.external_remaining} external input(s) still open"
        )


class Edge:
    """One channel from an outbox to an inbox."""

    __slots__ = (
        "batch",
        "capacity",
        "closed",
        "credits",
        "dst",
        "entry_loop",
        "feedback",
        "high_water",
        "inbox",
        "last_flush",
        "loop",
        "out_index",
        "outbox",
        "pending",
        "queued",
        "src",
        "src_index",
    )

    def __init__(
        self,
        src: NodeInstance,
        dst: NodeInstance,
        capacity: int | None,
        *,
        batch: int = 1,
        feedback: bool = False,
    ) -> None:
        self.src = src
        self.dst = dst
        self.capacity = capacity
        self.credits = capacity if capacity is not None else 0
        self.batch = max(1, batch if capacity is None else min(batch, capacity))
        self.feedback = feedback
        self.closed = False
        self.queued = 0
        self.high_water = 0
        self.pending: list[Any] = []
        self.last_flush = time.monotonic()
        self.loop: Loop | None = None
        self.entry_loop: Loop | None = None
        self.inbox = dst.inbox
        self.outbox = src.outbox
        self.src_index = len(dst.inbox.edges_in)
        dst.inbox.edges_in.append(self)
        if feedback:
            self.out_index = len(src.outbox.feedback_edges)
            src.outbox.feedback_edges.append(self)
        else:
            self.out_index = len(src.outbox.edges)
            src.outbox.edges.append(self)

    def refill(self, n: int = 1) -> None:
        if self.capacity is None:
            return
        with self.outbox.lock:
            self.credits += n
            self.outbox.space.notify_all()

    def wake_producer(self) -> None:
        with self.outbox.lock:
            self.outbox.space.notify_all()


class Inbox:
    """The single queue a node waits on. All input edges deliver into it."""

    def __init__(self, inst: NodeInstance, rc: RunContext) -> None:
        self.inst = inst
        self.rc = rc
        self.lock = threading.Lock()
        self.not_empty = threading.Condition(self.lock)
        self.q: deque[tuple[int, Any]] = deque()
        self.edges_in: list[Edge] = []
        self.done = False
        self.progress = 0
        rc.register_cond(self.not_empty)

    def push(self, edge: Edge, entry: Any, n: int = 1) -> bool:
        with self.lock:
            if self.done:
                return False
            self.q.append((edge.src_index, entry))
            edge.queued += n
            if edge.queued > edge.high_water:
                edge.high_water = edge.queued
            self.progress += 1
            self.not_empty.notify()
        return True

    def push_control(self, control: Any) -> None:
        with self.lock:
            if self.done:
                return
            self.q.append((-1, control))
            self.progress += 1
            self.not_empty.notify()

    def pop(self) -> tuple[int, Any]:
        """Take the next entry. Flushes this node's pending output before waiting."""
        outbox = self.inst.outbox
        while True:
            with self.lock:
                if self.q or not outbox.has_pending:
                    self.rc.scheduler.wait(
                        self.inst, self.not_empty, self._has_item, "input", "waiting for input"
                    )
                    src, entry = self.q.popleft()
                    if src >= 0:
                        self.edges_in[src].queued -= (
                            len(entry.items) if isinstance(entry, Batch) else 1
                        )
                    self.progress += 1
                    return src, entry
            outbox.flush()

    def _has_item(self) -> bool:
        return len(self.q) > 0

    def release(self, src: int, n: int = 1) -> None:
        """Give ``n`` credits back to the producer of ``src``: its items were consumed."""
        self.edges_in[src].refill(n)

    def mark_done(self) -> None:
        with self.lock:
            self.done = True
            self.q.clear()
        for e in self.edges_in:
            e.wake_producer()

    def describe_sources(self) -> str:
        return ", ".join(e.src.spec.name for e in self.edges_in)


class Outbox:
    """Where a node sends from. Applies the distribution policy, tagging and batching."""

    def __init__(self, inst: NodeInstance, rc: RunContext) -> None:
        self.inst = inst
        self.rc = rc
        self.lock = threading.Lock()
        self.space = threading.Condition(self.lock)
        self.edges: list[Edge] = []
        self.feedback_edges: list[Edge] = []
        self.rr = 0
        self.fb_rr = 0
        self.seq = 0
        self.window: Window | None = None
        self.tag: Tagged | None = None
        self.sub = 0
        self._pending_count = 0
        spec = inst.spec
        self._plain_rr = spec.distribute == "round_robin" and not (
            spec.tagged and spec.role == "emitter"
        )
        # The sync runtime must not depend on the clock: it flushes when full or waiting.
        self._timed = not rc.deterministic
        rc.register_cond(self.space)

    @property
    def has_pending(self) -> bool:
        return self._pending_count > 0

    def _all_edges(self) -> list[Edge]:
        return self.edges + self.feedback_edges if self.feedback_edges else self.edges

    # ----------------------------------------------------------------- low level

    def _acquire_credit(self, edge: Edge, n: int) -> None:
        if edge.capacity is None:
            return
        with self.lock:
            if edge.credits < n and not edge.inbox.done:
                self._flush_others_locked(edge)
            self.rc.scheduler.wait(
                self.inst,
                self.space,
                lambda: edge.credits >= n or edge.inbox.done,
                "output",
                f"sending to {edge.dst.spec.name!r} (queue full, capacity {edge.capacity})",
            )
            if not edge.inbox.done:
                edge.credits -= n

    def _flush_others_locked(self, current: Edge | None) -> None:
        """Push any other edge's pending batch that already has credits. Lock held."""
        for e in self._all_edges():
            if e is current or not e.pending:
                continue
            n = len(e.pending)
            if e.capacity is not None and e.credits < n and not e.inbox.done:
                continue
            items = e.pending
            e.pending = []
            self._pending_count -= n
            e.last_flush = time.monotonic()
            if e.capacity is not None and not e.inbox.done:
                e.credits -= n
            self._push_entry(e, Batch(items), n)

    def _push_entry(self, edge: Edge, entry: Any, n: int) -> None:
        if edge.inbox.push(edge, entry, n):
            self.inst.stats.items_out += n
        else:
            self.inst.stats.dropped += n

    def put(self, edge: Edge, item: Any, *, raw: bool = False) -> None:
        if edge.closed:
            raise ChannelClosed(
                f"node {self.inst.spec.name!r} sent an item after closing its output to "
                f"{edge.dst.spec.name!r}"
            )
        if not raw and self.tag is not None:
            item = TaggedOut(self.tag.seq, self.tag.part, self.tag.nparts, self.sub, item)
            self.sub += 1
        if edge.loop is not None:
            edge.loop.sent()
        if edge.batch <= 1:
            self._acquire_credit(edge, 1)
            self._push_entry(edge, item, 1)
            return
        pending = edge.pending
        pending.append(item)
        self._pending_count += 1
        if len(pending) >= edge.batch or (
            self._timed and time.monotonic() - edge.last_flush >= FLUSH_AFTER
        ):
            self._flush_edge(edge)

    def _flush_edge(self, edge: Edge) -> None:
        items = edge.pending
        edge.pending = []
        n = len(items)
        self._pending_count -= n
        self._acquire_credit(edge, n)
        edge.last_flush = time.monotonic()
        self._push_entry(edge, Batch(items), n)

    def flush(self) -> None:
        """Send every partial batch now."""
        for e in self._all_edges():
            if e.pending:
                self._flush_edge(e)

    def _put_any(self, item: Any) -> None:
        n = len(self.edges)
        with self.lock:
            if self._pending_count:
                self._flush_others_locked(None)
            self.rc.scheduler.wait(
                self.inst,
                self.space,
                lambda: any(
                    e.credits > 0 or e.inbox.done or e.capacity is None for e in self.edges
                ),
                "output",
                "sending to any worker (all queues full)",
            )
            chosen: Edge | None = None
            for k in range(n):
                e = self.edges[(self.rr + k) % n]
                if e.capacity is None or e.credits > 0 or e.inbox.done:
                    chosen = e
                    self.rr = (self.rr + k + 1) % n
                    break
            assert chosen is not None
            if chosen.capacity is not None and not chosen.inbox.done:
                chosen.credits -= 1
        if chosen.closed:
            raise ChannelClosed(f"node {self.inst.spec.name!r} sent after closing its outputs")
        if chosen.loop is not None:
            chosen.loop.sent()
        self._push_entry(chosen, item, 1)

    # ----------------------------------------------------------------- policies

    def _require_edges(self) -> None:
        if not self.edges:
            raise TolquaneError(
                f"node {self.inst.spec.name!r} has no output to send to; add a stage after it"
            )

    def send(self, item: Any, *, to: int | None = None) -> None:
        if to is not None:
            self.send_to(to, item)
            return
        edges = self.edges
        if not edges:
            self._require_edges()
        if self._plain_rr:
            rr = self.rr
            self.rr = rr + 1 if rr + 1 < len(edges) else 0
            self.put(edges[rr], item)
            return
        spec = self.inst.spec
        if spec.tagged and spec.role == "emitter":
            self._send_tagged(item)
            return
        policy = spec.distribute
        if policy == "round_robin":
            e = self.edges[self.rr]
            self.rr = (self.rr + 1) % len(self.edges)
            self.put(e, item)
        elif policy == "broadcast":
            for e in self.edges:
                self.put(e, item)
        elif policy == "on_demand":
            self._put_any(item)
        elif policy == "key":
            assert spec.key is not None
            self.put(self.edges[hash(spec.key(item)) % len(self.edges)], item)
        elif policy == "scatter":
            for i, part in enumerate(split_sequence(item, len(self.edges), self.inst.spec.name)):
                self.put(self.edges[i], part)
        else:  # pragma: no cover - validated at build time
            raise TolquaneError(f"unknown distribute policy {policy!r}")

    def send_to(self, index: int, item: Any) -> None:
        self._require_edges()
        if not 0 <= index < len(self.edges):
            raise TolquaneError(
                f"node {self.inst.spec.name!r} sent to output {index}, but it has "
                f"{len(self.edges)} output(s) (0..{len(self.edges) - 1})"
            )
        spec = self.inst.spec
        if spec.tagged and spec.role == "emitter":
            self.put(self.edges[index], Tagged(self._next_seq(), 0, 1, item))
        else:
            self.put(self.edges[index], item)

    def broadcast(self, item: Any) -> None:
        self._require_edges()
        spec = self.inst.spec
        if spec.tagged and spec.role == "emitter":
            seq = self._next_seq()
            n = len(self.edges)
            for i, e in enumerate(self.edges):
                self.put(e, Tagged(seq, i, n, item))
            return
        for e in self.edges:
            self.put(e, item)

    def feedback(self, item: Any, to: int | None = None) -> None:
        if not self.feedback_edges:
            raise TolquaneError(
                f"node {self.inst.spec.name!r} has no feedback output; wrap the block in "
                "tq.feedback(...) and send back from its last stage"
            )
        if to is None:
            e = self.feedback_edges[self.fb_rr]
            self.fb_rr = (self.fb_rr + 1) % len(self.feedback_edges)
        elif 0 <= to < len(self.feedback_edges):
            e = self.feedback_edges[to]
        else:
            raise TolquaneError(
                f"node {self.inst.spec.name!r} fed back to {to}, but it has "
                f"{len(self.feedback_edges)} feedback output(s)"
            )
        self.put(e, item)

    # ----------------------------------------------------------------- tagging

    def _next_seq(self) -> int:
        if self.window is not None:
            self.window.acquire(self.inst)
        seq = self.seq
        self.seq += 1
        return seq

    def _send_tagged(self, item: Any) -> None:
        policy = self.inst.spec.distribute
        n = len(self.edges)
        if policy == "scatter":
            parts = split_sequence(item, n, self.inst.spec.name)
            seq = self._next_seq()
            for i, part in enumerate(parts):
                self.put(self.edges[i], Tagged(seq, i, len(parts), part))
        elif policy == "broadcast":
            seq = self._next_seq()
            for i, e in enumerate(self.edges):
                self.put(e, Tagged(seq, i, n, item))
        else:
            tagged = Tagged(self._next_seq(), 0, 1, item)
            if policy == "round_robin":
                e = self.edges[self.rr]
                self.rr = (self.rr + 1) % n
                self.put(e, tagged)
            elif policy == "on_demand":
                self._put_any(tagged)
            else:  # key
                assert self.inst.spec.key is not None
                self.put(self.edges[hash(self.inst.spec.key(item)) % n], tagged)

    def begin_item(self, tag: Tagged) -> None:
        self.tag = tag
        self.sub = 0

    def end_item(self) -> None:
        assert self.tag is not None
        marker = TaggedOut(self.tag.seq, self.tag.part, self.tag.nparts, self.sub, END)
        self.tag = None
        self.sub = 0
        if self.edges:
            e = self.edges[self.rr]
            self.rr = (self.rr + 1) % len(self.edges)
            self.put(e, marker, raw=True)

    # ----------------------------------------------------------------- closing

    def close_all(self) -> None:
        self.flush()
        for e in self._all_edges():
            if e.closed:
                continue
            e.closed = True
            self._acquire_credit(e, 1)
            e.inbox.push(e, EOS)


def split_sequence(item: Any, n: int, node: str) -> list[Any]:
    """Split a sequence into at most n contiguous chunks, as evenly as possible."""
    sliceable = hasattr(item, "__len__") and hasattr(item, "__getitem__")
    if not isinstance(item, Sequence) and not sliceable:
        raise TolquaneError(
            f"emit='scatter' on {node!r} needs a sequence to split, got {type(item).__name__}"
        )
    length = len(item)
    if length == 0:
        return [item[:0]]
    k = min(n, length)
    base, extra = divmod(length, k)
    parts = []
    start = 0
    for i in range(k):
        size = base + (1 if i < extra else 0)
        parts.append(item[start : start + size])
        start += size
    return parts
