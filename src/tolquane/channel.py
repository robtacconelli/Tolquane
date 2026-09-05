"""Channels: the inbox every node waits on, the outbox it sends from, and the edges.

Locking discipline: a thread never holds an inbox lock and an outbox lock at the same
time. Producers wait on the outbox ``space`` condition for a credit, then append under
the inbox lock. Consumers pop under the inbox lock, then hand the credit back under the
outbox lock. Every wait goes through the scheduler so that cancellation and deadlock
detection see it.
"""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ._sentinels import END, EOS
from .errors import ChannelClosed, TolquaneError

if TYPE_CHECKING:
    from .runtime import NodeInstance, RunContext


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


class Edge:
    """One channel from an outbox to an inbox."""

    __slots__ = (
        "capacity",
        "closed",
        "credits",
        "dst",
        "high_water",
        "inbox",
        "out_index",
        "outbox",
        "queued",
        "src",
        "src_index",
    )

    def __init__(self, src: NodeInstance, dst: NodeInstance, capacity: int | None) -> None:
        self.src = src
        self.dst = dst
        self.capacity = capacity
        self.credits = capacity if capacity is not None else 0
        self.closed = False
        self.queued = 0
        self.high_water = 0
        self.inbox = dst.inbox
        self.outbox = src.outbox
        self.src_index = len(dst.inbox.edges_in)
        self.out_index = len(src.outbox.edges)
        dst.inbox.edges_in.append(self)
        src.outbox.edges.append(self)

    def refill(self) -> None:
        if self.capacity is None:
            return
        with self.outbox.lock:
            self.credits += 1
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

    def push(self, edge: Edge, item: Any) -> bool:
        with self.lock:
            if self.done:
                return False
            self.q.append((edge.src_index, item))
            edge.queued += 1
            if edge.queued > edge.high_water:
                edge.high_water = edge.queued
            self.progress += 1
            self.not_empty.notify()
        return True

    def pop(self) -> tuple[int, Any]:
        """Take the next entry. The producer's credit comes back only on ``release``."""
        with self.lock:
            self.rc.scheduler.wait(
                self.inst, self.not_empty, self._has_item, "input", "waiting for input"
            )
            src, item = self.q.popleft()
            self.edges_in[src].queued -= 1
            self.progress += 1
        return src, item

    def release(self, src: int) -> None:
        """Give one credit back to the producer of ``src``: its item has been consumed."""
        self.edges_in[src].refill()

    def _has_item(self) -> bool:
        return len(self.q) > 0

    def mark_done(self) -> None:
        with self.lock:
            self.done = True
            self.q.clear()
        for e in self.edges_in:
            e.wake_producer()

    def describe_sources(self) -> str:
        return ", ".join(e.src.spec.name for e in self.edges_in)


class Outbox:
    """Where a node sends from. Applies the node's distribution policy and tagging."""

    def __init__(self, inst: NodeInstance, rc: RunContext) -> None:
        self.inst = inst
        self.rc = rc
        self.lock = threading.Lock()
        self.space = threading.Condition(self.lock)
        self.edges: list[Edge] = []
        self.rr = 0
        self.seq = 0
        self.window: Window | None = None
        self.tag: Tagged | None = None
        self.sub = 0
        rc.register_cond(self.space)

    # ----------------------------------------------------------------- low level

    def _acquire_credit(self, edge: Edge) -> None:
        if edge.capacity is None:
            return
        with self.lock:
            self.rc.scheduler.wait(
                self.inst,
                self.space,
                lambda: edge.credits > 0 or edge.inbox.done,
                "output",
                f"sending to {edge.dst.spec.name!r} (queue full, capacity {edge.capacity})",
            )
            if not edge.inbox.done:
                edge.credits -= 1

    def put(self, edge: Edge, item: Any, *, raw: bool = False) -> None:
        if edge.closed:
            raise ChannelClosed(
                f"node {self.inst.spec.name!r} sent an item after closing its output to "
                f"{edge.dst.spec.name!r}"
            )
        if not raw and self.tag is not None:
            item = TaggedOut(self.tag.seq, self.tag.part, self.tag.nparts, self.sub, item)
            self.sub += 1
        self._acquire_credit(edge)
        if edge.inbox.push(edge, item):
            self.inst.stats.items_out += 1
        else:
            self.inst.stats.dropped += 1

    def _put_any(self, item: Any) -> None:
        n = len(self.edges)
        with self.lock:
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
        if chosen.inbox.push(chosen, item):
            self.inst.stats.items_out += 1
        else:
            self.inst.stats.dropped += 1

    # ----------------------------------------------------------------- policies

    def _require_edges(self) -> None:
        if not self.edges:
            raise TolquaneError(
                f"node {self.inst.spec.name!r} has no output to send to; add a stage after it"
            )

    def send(self, item: Any) -> None:
        self._require_edges()
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
        for e in self.edges:
            if e.closed:
                continue
            e.closed = True
            self._acquire_credit(e)
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
