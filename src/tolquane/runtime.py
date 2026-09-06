"""Run-time objects: node instances, the shared run context, schedulers, ``execute``."""

from __future__ import annotations

import enum
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .channel import Edge, Inbox, Loop, Outbox, Window
from .errors import (
    Cancelled,
    DeadlockError,
    GraphError,
    NodeError,
    RunCancelled,
    RunFailure,
    TolquaneError,
)
from .graph import DEFAULT_BATCH, DEFAULT_CAPACITY, Graph, NodeSpec
from .policies import Strategy, make_strategy
from .runner import run_node

if TYPE_CHECKING:
    from .processes import RemoteWorker

TICK = 0.05


class State(enum.Enum):
    NEW = "new"
    RUNNING = "running"
    WAITING = "waiting"
    DONE = "done"
    FAILED = "failed"


@dataclass
class NodeStats:
    """Counts and times for one node. Times are seconds over the node's whole life.

    ``busy`` is time not spent blocked on a channel: running user code, or, for a
    coroutine pool, waiting for its coroutines. ``wait_in`` is time blocked for input,
    ``wait_out`` time blocked on a full output or an ordering window. A stage that is
    busy nearly all the time while its neighbours wait on it is the bottleneck: farm it.
    """

    items_in: int = 0
    items_out: int = 0
    dropped: int = 0
    elapsed: float = 0.0
    busy: float = 0.0
    wait_in: float = 0.0
    wait_out: float = 0.0

    @property
    def busy_share(self) -> float:
        """Fraction of the node's own life spent busy, 0 to 1. Compare ``busy`` seconds
        across nodes to find the bottleneck: a node's life ends when its inputs do."""
        return self.busy / self.elapsed if self.elapsed > 0 else 0.0

    def to_dict(self) -> dict[str, Any]:
        """The counts and times as JSON-ready data."""
        return {
            "items_in": self.items_in,
            "items_out": self.items_out,
            "dropped": self.dropped,
            "elapsed": self.elapsed,
            "busy": self.busy,
            "wait_in": self.wait_in,
            "wait_out": self.wait_out,
            "busy_share": self.busy_share,
        }

    def _record_wait(self, reason: str, seconds: float, outside: bool) -> None:
        if outside:
            return  # coroutines or a remote worker were running for this node: that is work
        if reason in ("input", "loop"):
            self.wait_in += seconds
        else:
            self.wait_out += seconds


class NodeInstance:
    """A node being executed: its spec, inbox, outbox, delivery strategy and state."""

    def __init__(self, spec: NodeSpec, order: int, rc: RunContext) -> None:
        self.spec = spec
        self.order = order
        self.state = State.NEW
        self.reason = ""
        self.detail = ""
        self.stats = NodeStats()
        self.inbox = Inbox(self, rc)
        self.outbox = Outbox(self, rc)
        self.strategy: Strategy | None = None
        self.loop: Loop | None = None
        self.remote: RemoteWorker | None = None
        self.ctx_source: int = 0
        self.in_flight: int = 0  # work running outside the channels: coroutines in a pool
        self.flight_lock = threading.Lock()
        self.started_at: float = time.perf_counter()
        self.parked_on: threading.Condition | None = self.inbox.not_empty
        self.predicate: Callable[[], bool] | None = None
        # The sync runtime parks a node on this, never on a channel lock, so handing the
        # baton over can never wait on a lock some other node holds.
        self.baton_cond = threading.Condition()
        rc.register_cond(self.baton_cond)
        self.thread: threading.Thread | None = None

    @property
    def name(self) -> str:
        return self.spec.name

    def outbox_capacity(self) -> int:
        """Items a source may have queued ahead of its slowest output; 64 when unbounded."""
        caps = [e.capacity for e in self.outbox.edges if e.capacity is not None]
        return min(caps) if caps else 64

    @property
    def live(self) -> bool:
        return self.state not in (State.DONE, State.FAILED)

    @property
    def busy_outside(self) -> bool:
        """Work is running for this node where no channel can see it: coroutines on an
        event loop, or items at a remote worker. Their results will arrive by themselves."""
        if self.in_flight > 0:
            return True
        return self.remote is not None and self.remote.in_flight > 0

    @property
    def idle(self) -> bool:
        """Waiting with nothing in hand."""
        return self.state is State.WAITING and not self.busy_outside


class Tracer:
    """Collects wait and run intervals per node and writes a Chrome trace file."""

    def __init__(self) -> None:
        self.t0 = time.perf_counter()
        self.events: list[tuple[str, str, float, float]] = []
        self.lock = threading.Lock()

    def record(self, node: str, name: str, start: float, end: float) -> None:
        with self.lock:
            self.events.append((node, name, start, end))

    def write(self, path: str, insts: list[NodeInstance]) -> None:
        import json

        tids = {inst.name: i + 1 for i, inst in enumerate(insts)}
        out: list[dict[str, Any]] = [
            {"name": "thread_name", "ph": "M", "pid": 1, "tid": tid, "args": {"name": name}}
            for name, tid in tids.items()
        ]
        for node, name, start, end in self.events:
            out.append(
                {
                    "name": name,
                    "ph": "X",
                    "pid": 1,
                    "tid": tids.get(node, 0),
                    "ts": round((start - self.t0) * 1e6, 1),
                    "dur": round((end - start) * 1e6, 1),
                }
            )
        with open(path, "w") as f:
            json.dump({"traceEvents": out, "displayTimeUnit": "ms"}, f)


class RunContext:
    """State shared by every node of one run: cancellation, failures, the scheduler."""

    def __init__(
        self,
        *,
        deterministic: bool = False,
        on_failure: Callable[[str], None] | None = None,
        tracer: Tracer | None = None,
    ) -> None:
        self.lock = threading.Lock()
        self.cancelled = False
        self.deterministic = deterministic
        self.on_failure = on_failure
        self.tracer = tracer
        self.failures: list[tuple[NodeInstance, BaseException]] = []
        self.deadlock_message: str | None = None
        self.done_event = threading.Event()
        self._conds: list[threading.Condition] = []
        self.scheduler: Scheduler = ThreadScheduler(self)

    def register_cond(self, cond: threading.Condition) -> None:
        self._conds.append(cond)

    def cancel(self) -> None:
        with self.lock:
            if self.cancelled:
                return
            self.cancelled = True
        for cond in self._conds:
            with cond:
                cond.notify_all()
        self.done_event.set()

    def fail(self, inst: NodeInstance, exc: BaseException) -> None:
        with self.lock:
            first = not self.failures
            self.failures.append((inst, exc))
            inst.state = State.FAILED
        if first and self.on_failure is not None:
            self.on_failure(f"node {inst.name!r} failed: {type(exc).__name__}: {exc}")
        self.cancel()

    def report_deadlock(self, message: str) -> None:
        """Record a deadlock and wake the main thread, which cancels the run.

        Safe to call while holding a channel lock: it takes no other lock itself.
        """
        with self.lock:
            if self.deadlock_message is None:
                self.deadlock_message = message
        self.done_event.set()

    def deadlock(self, message: str) -> None:
        """Record a deadlock and cancel. Only for callers that hold no locks."""
        self.report_deadlock(message)
        self.cancel()

    def node_done(self, inst: NodeInstance) -> None:
        if inst.state is not State.FAILED:
            inst.state = State.DONE
        now = time.perf_counter()
        stats = inst.stats
        stats.elapsed = now - inst.started_at
        stats.busy = max(0.0, stats.elapsed - stats.wait_in - stats.wait_out)
        if self.tracer is not None:
            self.tracer.record(inst.name, "node", inst.started_at, now)
        self.scheduler.node_done(inst)
        self.done_event.set()


class Scheduler:
    """Hooks every blocking wait goes through. The thread runtime just records state."""

    def __init__(self, rc: RunContext) -> None:
        self.rc = rc

    def node_started(self, inst: NodeInstance) -> None:
        inst.state = State.RUNNING
        inst.started_at = time.perf_counter()

    def wait(
        self,
        inst: NodeInstance,
        cond: threading.Condition,
        predicate: Callable[[], bool],
        reason: str,
        detail: str,
    ) -> None:
        raise NotImplementedError

    def node_done(self, inst: NodeInstance) -> None:
        pass

    def event(self, inst: NodeInstance, delta: int = 0) -> None:
        """A thread outside the runtime changed ``inst``'s work in flight by ``delta``
        and may have posted a result to its inbox."""
        if delta:
            with inst.flight_lock:
                inst.in_flight += delta


class ThreadScheduler(Scheduler):
    def wait(
        self,
        inst: NodeInstance,
        cond: threading.Condition,
        predicate: Callable[[], bool],
        reason: str,
        detail: str,
    ) -> None:
        if predicate():
            return
        inst.state = State.WAITING
        inst.reason = reason
        inst.detail = detail
        inst.parked_on = cond
        tracer = self.rc.tracer
        started = time.perf_counter()
        outside = inst.busy_outside
        try:
            while not predicate():
                if self.rc.cancelled:
                    raise Cancelled
                cond.wait()
        finally:
            inst.state = State.RUNNING
            inst.parked_on = None
            now = time.perf_counter()
            inst.stats._record_wait(reason, now - started, outside)
            if tracer is not None:
                tracer.record(inst.name, f"wait {reason}", started, now)


class BatonScheduler(Scheduler):
    """Deterministic runtime: exactly one node runs at a time and hands over when it blocks."""

    def __init__(self, rc: RunContext, insts: list[NodeInstance]) -> None:
        super().__init__(rc)
        self.insts = insts
        self.holder: NodeInstance | None = insts[0] if insts else None
        self.baton = threading.Lock()

    def node_started(self, inst: NodeInstance) -> None:
        self._park(inst, None)
        inst.state = State.RUNNING
        inst.started_at = time.perf_counter()

    def _park(self, inst: NodeInstance, held: threading.Condition | None) -> None:
        """Block until ``inst`` holds the baton. ``held`` is the channel condition whose
        lock the caller holds; it is let go while parked and taken back before returning,
        exactly as ``held.wait()`` would do."""
        if self.holder is inst:
            return
        if held is not None:
            held.release()
        try:
            with inst.baton_cond:
                while self.holder is not inst:
                    if self.rc.cancelled:
                        raise Cancelled
                    inst.baton_cond.wait()
        finally:
            if held is not None:
                held.acquire()

    def wait(
        self,
        inst: NodeInstance,
        cond: threading.Condition,
        predicate: Callable[[], bool],
        reason: str,
        detail: str,
    ) -> None:
        if predicate():
            return
        inst.state = State.WAITING
        inst.reason = reason
        inst.detail = detail
        inst.parked_on = cond
        inst.predicate = predicate
        started = time.perf_counter()
        outside = inst.busy_outside
        self._handoff(inst)
        try:
            self._park(inst, cond)
        finally:
            inst.state = State.RUNNING
            inst.parked_on = None
            inst.predicate = None
            inst.stats._record_wait(reason, time.perf_counter() - started, outside)

    def node_done(self, inst: NodeInstance) -> None:
        self._handoff(inst)

    def _runnable(self, inst: NodeInstance) -> bool:
        if inst.state is State.NEW:
            return True
        if inst.state is State.WAITING:
            return inst.predicate is not None and inst.predicate()
        return False

    def _handoff(self, current: NodeInstance) -> None:
        with self.baton:
            cand = self._pick(current.order + 1, current)
        self._wake(cand)

    def event(self, inst: NodeInstance, delta: int = 0) -> None:
        """Nobody holds the baton while every node waits on work outside the channels;
        the thread that finished such work hands it to whoever can run now, or reports
        the deadlock that the finished work has revealed."""
        cand = None
        with self.baton:
            if delta:
                with inst.flight_lock:
                    inst.in_flight += delta
            if self.holder is None:
                cand = self._pick(inst.order)
        self._wake(cand)

    def _pick(self, start: int, current: NodeInstance | None = None) -> NodeInstance | None:
        """Hand the baton to the first runnable node from ``start`` on (under ``baton``).

        Setting ``holder`` is the handoff; the notify that follows is only a wake-up call
        and happens outside ``baton``. ``current`` is the node giving the baton away: it
        is considered last and, when it can run again, keeps the baton without a wake-up.
        """
        n = len(self.insts)
        for k in range(n):
            cand = self.insts[(start + k) % n]
            if cand is current:
                continue
            if self._runnable(cand):
                self.holder = cand
                return cand
        if current is not None and self._runnable(current):
            self.holder = current
            return None
        self.holder = None
        live = [i for i in self.insts if i.live]
        if live and not self.rc.cancelled and not any(i.busy_outside for i in live):
            # We may hold the caller's channel lock here, so we must not cancel in place.
            # During cancellation nobody is runnable by design: that is not a deadlock.
            self.rc.report_deadlock(describe_stall(self.insts))
        return None

    @staticmethod
    def _wake(cand: NodeInstance | None) -> None:
        if cand is not None:
            with cand.baton_cond:
                cand.baton_cond.notify_all()


def describe_stall(insts: list[NodeInstance]) -> str:
    lines = ["deadlock: every node is waiting on another one and nothing can make progress"]
    loops: list[Loop] = []
    for i in insts:
        if not i.live:
            continue
        if i.loop is not None and i.loop not in loops:
            loops.append(i.loop)
        if i.reason == "input":
            srcs = i.inbox.describe_sources() or "(no sources)"
            lines.append(f"  {i.name}: waiting for input from {srcs}")
        elif i.state is State.NEW:
            lines.append(f"  {i.name}: not started")
        else:
            lines.append(f"  {i.name}: {i.detail}")
    for loop in loops:
        lines.append("  " + loop.describe())
    lines.append(
        "fix: raise the capacity of the full edge, drain inputs in a different order, "
        "or break the cycle"
    )
    return "\n".join(lines)


@dataclass
class NodeProgress:
    """One node as it is right now: what it is doing and what it has handled so far."""

    state: str
    reason: str
    detail: str
    items_in: int
    items_out: int
    dropped: int
    busy: float
    wait_in: float
    wait_out: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "reason": self.reason,
            "detail": self.detail,
            "items_in": self.items_in,
            "items_out": self.items_out,
            "dropped": self.dropped,
            "busy": self.busy,
            "wait_in": self.wait_in,
            "wait_out": self.wait_out,
        }


@dataclass
class EdgeProgress:
    """One channel as it is right now: how full it is, and what has crossed it."""

    queued: int
    high_water: int
    capacity: int | None
    taps: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "queued": self.queued,
            "high_water": self.high_water,
            "capacity": self.capacity,
            "taps": self.taps,
        }


@dataclass
class Progress:
    """A snapshot of a running graph, handed to ``run(on_progress=...)``.

    Nodes are keyed by name, edges by ``"src->dst"``. ``phase`` is ``"running"`` for
    every snapshot but the last, which says how the run ended: ``"done"``, ``"failed"``,
    ``"cancelled"`` or ``"deadlock"``.
    """

    elapsed: float
    phase: str
    nodes: dict[str, NodeProgress] = field(default_factory=dict)
    edges: dict[str, EdgeProgress] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "elapsed": self.elapsed,
            "phase": self.phase,
            "nodes": {name: n.to_dict() for name, n in self.nodes.items()},
            "edges": {key: e.to_dict() for key, e in self.edges.items()},
        }


def _edge_keys(edges: list[Edge]) -> list[tuple[str, Edge]]:
    """Name every edge ``"src->dst"``, numbering the pairs wired more than once."""
    keys: list[tuple[str, Edge]] = []
    seen: dict[str, int] = {}
    for edge in edges:
        key = f"{edge.src.name}->{edge.dst.name}"
        n = seen.get(key, 0)
        seen[key] = n + 1
        keys.append((key if n == 0 else f"{key}#{n}", edge))
    return keys


def _read_taps(taps: deque[str]) -> list[str]:
    """Copy an edge's tap ring without locking it.

    A node appending while the copy is being taken makes ``deque`` refuse to be iterated
    (on a free-threaded interpreter, where the two really do overlap). The snapshot tries
    again rather than taking the edge's lock, and gives the tap up after a few tries: a
    progress display must never get in the way of the run it is watching.
    """
    for _ in range(4):
        try:
            return list(taps)
        except RuntimeError:
            continue
    return []


def _snapshot(
    insts: list[NodeInstance], keys: list[tuple[str, Edge]], start: float, phase: str
) -> Progress:
    """Read every counter as it stands, without taking a channel lock.

    A number read while its node is changing it is at most one item out of date, which
    is what a progress display wants; taking the locks would put the watchdog in the way
    of the run it is only watching.
    """
    now = time.perf_counter()
    p = Progress(elapsed=now - start, phase=phase)
    for inst in insts:
        stats = inst.stats
        state = inst.state
        if state is State.NEW:
            busy = 0.0
        elif state is State.DONE or state is State.FAILED:
            busy = stats.busy  # settled when the node finished
        else:
            busy = max(0.0, (now - inst.started_at) - stats.wait_in - stats.wait_out)
        waiting = state is State.WAITING
        p.nodes[inst.name] = NodeProgress(
            state=state.value,
            reason=inst.reason if waiting else "",
            detail=inst.detail if waiting else "",
            items_in=stats.items_in,
            items_out=stats.items_out,
            dropped=stats.dropped,
            busy=busy,
            wait_in=stats.wait_in,
            wait_out=stats.wait_out,
        )
    for key, edge in keys:
        taps = edge.taps
        p.edges[key] = EdgeProgress(
            queued=edge.queued,
            high_water=edge.high_water,
            capacity=edge.capacity,
            taps=_read_taps(taps) if taps is not None else [],
        )
    return p


@dataclass
class Report:
    """What happened during a run. ``print(report)`` shows a table."""

    runtime: str
    elapsed: float
    nodes: dict[str, NodeStats] = field(default_factory=dict)
    edges: dict[tuple[str, str], int] = field(default_factory=dict)

    def busiest(self, n: int = 3) -> list[str]:
        """Node names with the most busy seconds, most busy first: the bottleneck first."""
        ranked = sorted(self.nodes.items(), key=lambda kv: kv[1].busy, reverse=True)
        return [name for name, _ in ranked[:n]]

    def to_dict(self) -> dict[str, Any]:
        """The report as JSON-ready data. Edges are keyed ``"src->dst"``."""
        return {
            "runtime": self.runtime,
            "elapsed": self.elapsed,
            "nodes": {name: stats.to_dict() for name, stats in self.nodes.items()},
            "edges": {f"{src}->{dst}": hw for (src, dst), hw in self.edges.items()},
            "busiest": self.busiest(3),
        }

    def __str__(self) -> str:
        w = max([len(n) for n in self.nodes] + [4])
        lines = [f"run on {self.runtime}: {self.elapsed:.3f}s"]
        lines.append(
            f"  {'node'.ljust(w)}  {'in':>8}  {'out':>8}  {'dropped':>8}"
            f"  {'busy':>8}  {'busy%':>6}  {'wait-in':>7}  {'wait-out':>8}"
        )
        for name, s in self.nodes.items():
            pct = (
                f"{100 * s.busy_share:5.1f}%"
                f"  {100 * s.wait_in / s.elapsed:6.1f}%  {100 * s.wait_out / s.elapsed:7.1f}%"
                if s.elapsed > 0
                else f"{'':>6}  {'':>7}  {'':>8}"
            )
            lines.append(
                f"  {name.ljust(w)}  {s.items_in:>8}  {s.items_out:>8}  {s.dropped:>8}"
                f"  {s.busy:7.3f}s  {pct}"
            )
        if self.edges:
            lines.append("  edge high-water marks:")
            for (src, dst), hw in self.edges.items():
                lines.append(f"    {src} -> {dst}: {hw}")
        return "\n".join(lines)


def execute(
    graph: Graph,
    *,
    runtime: str = "threads",
    capacity: int | None = 1024,
    batch: int = 1,
    deadlock_timeout: float | None = 0.3,
    remote_loops: dict[str, tuple[Loop, list[Any]]] | None = None,
    on_failure: Callable[[str], None] | None = None,
    trace: str | None = None,
    on_progress: Callable[[Progress], None] | None = None,
    progress_interval: float = 0.5,
    tap: int = 0,
    stop: threading.Event | None = None,
) -> Report:
    if runtime not in ("threads", "sync", "processes"):
        raise TolquaneError(f"unknown runtime {runtime!r}; use 'threads', 'processes' or 'sync'")
    if progress_interval <= 0:
        raise TolquaneError("progress_interval must be greater than zero")
    if tap < 0:
        raise TolquaneError("tap must be 0 (off) or the number of items to keep per edge")
    all_workers_remote = runtime == "processes"
    if all_workers_remote:
        runtime = "threads"
    tracer = Tracer() if trace else None
    rc = RunContext(deterministic=runtime == "sync", on_failure=on_failure, tracer=tracer)
    insts = [NodeInstance(spec, i, rc) for i, spec in enumerate(graph.nodes)]
    by_name = {i.name: i for i in insts}
    windows = {wid: Window(limit, rc) for wid, limit in graph.windows.items()}
    loops = {spec.name: Loop(spec, rc) for spec in graph.loops}
    loop_of: dict[str, Loop] = {}
    for loop_spec in graph.loops:
        loop = loops[loop_spec.name]
        for name in loop_spec.nodes:
            loop_of[name] = loop
        loop.heads = [by_name[h] for h in loop_spec.heads]
    edges: list[Edge] = []
    for e in graph.edges:
        cap = capacity if e.capacity == DEFAULT_CAPACITY else e.capacity
        size = batch if e.batch == DEFAULT_BATCH else e.batch
        edge = Edge(by_name[e.src], by_name[e.dst], cap, batch=size, feedback=e.feedback)
        src_loop = loop_of.get(e.src)
        dst_loop = loop_of.get(e.dst)
        if dst_loop is not None:
            if src_loop is dst_loop:
                edge.loop = dst_loop
            else:
                edge.entry_loop = dst_loop
                dst_loop.external_remaining += 1
        if tap:
            edge.taps = deque(maxlen=tap)
        edges.append(edge)
    for inst in insts:
        spec = inst.spec
        inst.loop = loop_of.get(spec.name)
        if remote_loops and spec.name in remote_loops:
            loop, inst_ref = remote_loops[spec.name]
            inst.loop = loop
            inst_ref[0] = inst
        window = windows.get(spec.window) if spec.window else None
        if window is not None and spec.role == "emitter":
            inst.outbox.window = window
        if inst.inbox.edges_in:
            inst.strategy = make_strategy(
                inst.inbox, spec.collect, window if spec.role == "collector" else None
            )
    remotes = _place_remote_workers(insts, rc, runtime, all_workers_remote, capacity, batch)
    rc.scheduler = ThreadScheduler(rc) if runtime == "threads" else BatonScheduler(rc, insts)

    start = time.perf_counter()
    for inst in insts:
        body: Callable[..., None] = run_node
        if inst.remote is not None:
            from .processes import run_proxy

            body = run_proxy
        t = threading.Thread(
            target=body, args=(inst, rc), name=f"tolquane:{inst.name}", daemon=True
        )
        inst.thread = t
    for remote in remotes:
        remote.start()
    for inst in insts:
        assert inst.thread is not None
        inst.thread.start()

    stall_ticks = 0
    last_progress = -1
    edge_keys = _edge_keys(edges) if on_progress is not None else []
    next_snapshot = start + progress_interval
    # A stop event that is already set cancels the run before it does any work.
    stopped = stop is not None and stop.is_set()
    if stopped:
        rc.cancel()
    try:
        while not stopped and any(i.live for i in insts):
            rc.done_event.wait(TICK)
            rc.done_event.clear()
            if stop is not None and stop.is_set():
                stopped = True
                rc.cancel()
                break
            if on_progress is not None:
                now = time.perf_counter()
                if now >= next_snapshot:
                    next_snapshot = now + progress_interval
                    on_progress(_snapshot(insts, edge_keys, start, "running"))
            if rc.deadlock_message is not None and not rc.cancelled:
                rc.cancel()
            if rc.cancelled:
                break
            if runtime == "threads" and deadlock_timeout is not None:
                live = [i for i in insts if i.live]
                if live and all(i.idle for i in live):
                    progress = sum(i.inbox.progress for i in insts) + sum(
                        r.messages for r in remotes
                    )
                    stall_ticks = stall_ticks + 1 if progress == last_progress else 0
                    last_progress = progress
                    if stall_ticks * TICK >= deadlock_timeout:
                        rc.deadlock(describe_stall(live))
                        break
                else:
                    stall_ticks = 0
                    last_progress = -1
    except BaseException:
        # A Ctrl-C, or an ``on_progress`` callback that raised: unwind the run first,
        # so no thread outlives the call that started it.
        rc.cancel()
        _join(insts)
        for remote in remotes:
            remote.shutdown()
        raise
    _join(insts)
    for remote in remotes:
        remote.shutdown()
    elapsed = time.perf_counter() - start
    if tracer is not None and trace:
        tracer.write(trace, insts)

    # A failure cancels the run, and a cancelled run can look stalled or stopped; the
    # failure is the cause, so it is what gets reported.
    if rc.failures:
        phase = "failed"
    elif stopped:
        phase = "cancelled"
    elif rc.deadlock_message is not None:
        phase = "deadlock"
    else:
        phase = "done"
    if on_progress is not None:
        on_progress(_snapshot(insts, edge_keys, start, phase))
    if rc.failures:
        for _, exc in rc.failures:
            if isinstance(exc, KeyboardInterrupt | SystemExit | RunFailure):
                raise exc
        errors = [NodeError(i.name, i.spec.index, exc) for i, exc in rc.failures]
        if len(errors) == 1:
            raise errors[0]
        raise ExceptionGroup("several nodes failed", errors)
    if phase == "cancelled":
        if rc.on_failure is not None:
            rc.on_failure("the run was stopped")
        raise RunCancelled("the run was stopped before it finished")
    if rc.deadlock_message is not None:
        if rc.on_failure is not None:
            rc.on_failure(rc.deadlock_message.splitlines()[0])
        raise DeadlockError(rc.deadlock_message)
    report = Report(runtime=runtime, elapsed=elapsed)
    for inst in insts:
        report.nodes[inst.name] = inst.stats
    for edge in edges:
        report.edges[(edge.src.name, edge.dst.name)] = edge.high_water
    return report


def _place_remote_workers(
    insts: list[NodeInstance],
    rc: RunContext,
    runtime: str,
    all_workers: bool,
    capacity: int | None,
    batch: int,
) -> list[RemoteWorker]:
    """Decide which nodes run in child processes and prepare their proxies."""
    if runtime == "sync":
        return []  # the debugging runtime keeps everything in one place
    chosen = [i for i in insts if i.spec.role == "worker" and (all_workers or i.spec.remote)]
    if not chosen:
        return []
    from .processes import RemoteWorker

    remotes: list[RemoteWorker] = []
    for inst in chosen:
        if inst.outbox.feedback_edges:
            raise GraphError(
                f"worker {inst.name!r} sends feedback and cannot run in a process yet; keep "
                "that farm on threads or route feedback through the collector"
            )
        for edge in inst.outbox.edges:
            edge.batch = 1  # the child already batches across the pipe
        inst.remote = RemoteWorker(inst, rc, capacity, batch)
        remotes.append(inst.remote)
    return remotes


def _join(insts: list[NodeInstance], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    for inst in insts:
        t = inst.thread
        if t is None:
            continue
        remaining = max(0.0, deadline - time.monotonic())
        t.join(remaining)


__all__ = [
    "EdgeProgress",
    "NodeInstance",
    "NodeProgress",
    "NodeStats",
    "Progress",
    "Report",
    "RunContext",
    "State",
    "execute",
]
