"""Run-time objects: node instances, the shared run context, schedulers, ``execute``."""

from __future__ import annotations

import enum
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .channel import Edge, Inbox, Loop, Outbox, Window
from .errors import Cancelled, DeadlockError, GraphError, NodeError, TolquaneError, WorkerDied
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
    items_in: int = 0
    items_out: int = 0
    dropped: int = 0


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
        self.parked_on: threading.Condition | None = self.inbox.not_empty
        self.predicate: Callable[[], bool] | None = None
        self.thread: threading.Thread | None = None

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def live(self) -> bool:
        return self.state not in (State.DONE, State.FAILED)

    @property
    def idle(self) -> bool:
        """Waiting with nothing in hand: a remote worker with items in flight is busy."""
        if self.state is not State.WAITING:
            return False
        return self.remote is None or self.remote.in_flight <= 0


class RunContext:
    """State shared by every node of one run: cancellation, failures, the scheduler."""

    def __init__(self, *, deterministic: bool = False) -> None:
        self.lock = threading.Lock()
        self.cancelled = False
        self.deterministic = deterministic
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
            self.failures.append((inst, exc))
            inst.state = State.FAILED
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
        self.scheduler.node_done(inst)
        self.done_event.set()


class Scheduler:
    """Hooks every blocking wait goes through. The thread runtime just records state."""

    def __init__(self, rc: RunContext) -> None:
        self.rc = rc

    def node_started(self, inst: NodeInstance) -> None:
        inst.state = State.RUNNING

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
        try:
            while not predicate():
                if self.rc.cancelled:
                    raise Cancelled
                cond.wait()
        finally:
            inst.state = State.RUNNING
            inst.parked_on = None


class BatonScheduler(Scheduler):
    """Deterministic runtime: exactly one node runs at a time and hands over when it blocks."""

    def __init__(self, rc: RunContext, insts: list[NodeInstance]) -> None:
        super().__init__(rc)
        self.insts = insts
        self.holder: NodeInstance | None = insts[0] if insts else None

    def node_started(self, inst: NodeInstance) -> None:
        with inst.inbox.lock:
            self._park(inst, inst.inbox.not_empty)
        inst.state = State.RUNNING

    def _park(self, inst: NodeInstance, cond: threading.Condition) -> None:
        while self.holder is not inst:
            if self.rc.cancelled:
                raise Cancelled
            cond.wait()

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
        self._handoff(inst)
        try:
            self._park(inst, cond)
        finally:
            inst.state = State.RUNNING
            inst.parked_on = None
            inst.predicate = None

    def node_done(self, inst: NodeInstance) -> None:
        self._handoff(inst)

    def _runnable(self, inst: NodeInstance) -> bool:
        if inst.state is State.NEW:
            return True
        if inst.state is State.WAITING:
            return inst.predicate is not None and inst.predicate()
        return False

    def _handoff(self, current: NodeInstance) -> None:
        n = len(self.insts)
        for k in range(1, n + 1):
            cand = self.insts[(current.order + k) % n]
            if self._runnable(cand):
                self.holder = cand
                cond = cand.parked_on
                if cond is not None:
                    with cond:
                        cond.notify_all()
                return
        self.holder = None
        if any(i.live for i in self.insts):
            # We hold the caller's channel lock here, so we must not cancel in place.
            self.rc.report_deadlock(describe_stall(self.insts))


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
class Report:
    """What happened during a run. ``print(report)`` shows a table."""

    runtime: str
    elapsed: float
    nodes: dict[str, NodeStats] = field(default_factory=dict)
    edges: dict[tuple[str, str], int] = field(default_factory=dict)

    def __str__(self) -> str:
        w = max([len(n) for n in self.nodes] + [4])
        lines = [f"run on {self.runtime}: {self.elapsed:.3f}s"]
        lines.append(f"  {'node'.ljust(w)}  {'in':>8}  {'out':>8}  {'dropped':>8}")
        for name, s in self.nodes.items():
            lines.append(f"  {name.ljust(w)}  {s.items_in:>8}  {s.items_out:>8}  {s.dropped:>8}")
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
) -> Report:
    if runtime not in ("threads", "sync", "processes"):
        raise TolquaneError(f"unknown runtime {runtime!r}; use 'threads', 'processes' or 'sync'")
    all_workers_remote = runtime == "processes"
    if all_workers_remote:
        runtime = "threads"
    rc = RunContext(deterministic=runtime == "sync")
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
    try:
        while any(i.live for i in insts):
            rc.done_event.wait(TICK)
            rc.done_event.clear()
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
    except KeyboardInterrupt:
        rc.cancel()
        _join(insts)
        for remote in remotes:
            remote.shutdown()
        raise
    _join(insts)
    for remote in remotes:
        remote.shutdown()
    elapsed = time.perf_counter() - start

    if rc.deadlock_message is not None:
        raise DeadlockError(rc.deadlock_message)
    if rc.failures:
        for _, exc in rc.failures:
            if isinstance(exc, KeyboardInterrupt | SystemExit | WorkerDied):
                raise exc
        errors = [NodeError(i.name, i.spec.index, exc) for i, exc in rc.failures]
        if len(errors) == 1:
            raise errors[0]
        raise ExceptionGroup("several nodes failed", errors)
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


__all__ = ["NodeInstance", "NodeStats", "Report", "RunContext", "State", "execute"]
