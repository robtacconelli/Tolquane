"""The processes runtime: farm workers in child processes, everything else in the parent.

A remote worker keeps its place in the parent graph as a proxy: the same inbox, outbox
and edges, but its thread forwards what arrives to a child process over a pipe and a
second thread forwards what comes back. In the child the worker runs as an ordinary
Tolquane node between two small raw nodes, one reading the pipe into the worker's
inbox (input indexes preserved), one writing the worker's outputs back. Nothing in
the core changes for the child: tags, batching, hooks and policies all still apply.

Credits and loop tokens stay exact because the child sends a completion marker after
every item it finishes, in order after that item's outputs. The parent releases the
producer's credit and the loop token only then, so backpressure and on-demand
scheduling mean what they mean on threads: at most ``capacity`` items in flight per
worker, one for ``on_demand``.

Children are always spawned, never forked (rule R14). A child that dies without
saying goodbye is reported as ``WorkerDied``; a child whose parent dies sees its pipe
close and exits.
"""

from __future__ import annotations

import contextlib
import multiprocessing as mp
import pickle
import signal
import threading
import traceback
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from ._sentinels import EOS, LOOP_DONE
from .channel import Batch, Loop
from .errors import Cancelled, TolquaneError, WorkerDied
from .graph import EdgeSpec, Graph, LoopSpec, NodeSpec

if TYPE_CHECKING:
    from multiprocessing.connection import Connection

    from .runtime import NodeInstance, RunContext

PROTOCOL = 5
CHILD_BATCH = 64
"""Items the child's pipe sink groups into one message when the worker keeps producing."""


def dumps(obj: Any) -> bytes:
    return pickle.dumps(obj, protocol=PROTOCOL)


def loads(data: bytes) -> Any:
    return pickle.loads(data)


def dumps_spec(obj: Any, what: str) -> bytes:
    """Pickle a node's code for a child; fall back to cloudpickle for closures and lambdas."""
    try:
        return pickle.dumps(obj, protocol=PROTOCOL)
    except Exception as first:
        try:
            import cloudpickle
        except ImportError:
            raise TolquaneError(
                f"{what} cannot be sent to a process ({type(first).__name__}: {first}); "
                "define it at module level, or pip install cloudpickle for lambdas and "
                "closures"
            ) from first
        try:
            return bytes(cloudpickle.dumps(obj, protocol=PROTOCOL))
        except Exception as second:
            raise TolquaneError(
                f"{what} cannot be sent to a process even with cloudpickle "
                f"({type(second).__name__}: {second}); it may hold a lock, a socket or "
                "an open file"
            ) from second


@dataclass
class ChildPayload:
    spec: NodeSpec
    n_in: int
    n_out: int
    capacity: int | None
    batch: int


class Done:
    """Marker the child sends after each finished item; carries the item's input index."""

    __slots__ = ("src",)

    def __init__(self, src: int) -> None:
        self.src = src


# --------------------------------------------------------------------------- child side


class _ChildSide:
    """The child's end of the pipe. Two threads write to it, so writes take a lock."""

    def __init__(self, conn: Connection) -> None:
        self.conn = conn
        self.lock = threading.Lock()

    def send(self, msg: Any) -> None:
        data = dumps(msg)
        with self.lock:
            self.conn.send_bytes(data)


class PipeSource:
    """Raw node: reads the parent's messages and feeds the worker's inputs."""

    def __init__(self, side: _ChildSide) -> None:
        self.side = side

    def __call__(self, ctx: Any) -> None:
        conn = self.side.conn
        outbox = ctx._inst.outbox
        while True:
            if outbox.has_pending:
                # About to block on the pipe: hand the worker what we already have.
                outbox.flush()
            try:
                msg = loads(conn.recv_bytes())
            except (EOFError, OSError):
                return  # the parent is gone; closing our outputs drains the worker
            kind = msg[0]
            if kind == "batch":
                src, items = msg[1], msg[2]
                for item in items:
                    ctx.send(item, to=src)
            elif kind == "item":
                ctx.send(msg[2], to=msg[1])
            elif kind == "eos":
                outbox.close_one(msg[1])
            elif kind == "close":
                return


class PipeSink:
    """Raw node: groups the worker's outputs and markers and writes them to the parent."""

    def __init__(self, side: _ChildSide) -> None:
        self.side = side

    def __call__(self, ctx: Any) -> None:
        buf: list[tuple[int, Any]] = []
        while True:
            r = ctx.recv()
            if r is None:
                break
            buf.append(r)
            if len(buf) >= CHILD_BATCH or not ctx.input_waiting:
                self.side.send(("outs", buf))
                buf = []
        if buf:
            self.side.send(("outs", buf))


class RemoteLoop(Loop):
    """Stands in for the worker's loop in the child: reports each finished item."""

    def __init__(self, side: _ChildSide, inst_ref: list[Any]) -> None:
        super().__init__(LoopSpec("remote", (), ()), None)  # type: ignore[arg-type]
        self.side = side
        self.inst_ref = inst_ref

    def done(self) -> None:
        inst = self.inst_ref[0]
        src = inst.ctx_source if hasattr(inst, "ctx_source") else 0
        outbox = inst.outbox
        if outbox.edges:
            # In order after this item's outputs: flush them, then queue the marker.
            outbox.flush()
            outbox.put(outbox.edges[0], Done(src), raw=True)
        else:
            self.side.send(("outs", [(0, Done(src))]))

    def describe(self) -> str:
        return "remote worker"


def _child_graph(payload: ChildPayload, side: _ChildSide) -> Graph:
    spec = replace(payload.spec, remote=False)
    nodes = [NodeSpec("in", "raw", PipeSource(side)), spec]
    edges = [EdgeSpec("in", spec.name, "pipe") for _ in range(payload.n_in)]
    if payload.n_out:
        nodes.append(NodeSpec("out", "raw", PipeSink(side)))
        edges.extend(EdgeSpec(spec.name, "out", "pipe") for _ in range(payload.n_out))
    return Graph(nodes=nodes, edges=edges)


def _child_main(conn: Connection, payload_bytes: bytes) -> None:
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the parent decides; we follow the pipe
    side = _ChildSide(conn)
    try:
        payload: ChildPayload = loads(payload_bytes)
        graph = _child_graph(payload, side)
        inst_ref: list[Any] = [None]
        loop = RemoteLoop(side, inst_ref)
        from .runtime import execute

        execute(
            graph,
            runtime="threads",
            capacity=payload.capacity,
            batch=payload.batch,
            deadlock_timeout=None,
            remote_loops={payload.spec.name: (loop, inst_ref)},
        )
    except BaseException as exc:
        try:
            side.send(("error", exc, traceback.format_exc()[-4000:]))
        except Exception:
            side.send(("error", RuntimeError(f"{type(exc).__name__}: {exc}"), ""))
    finally:
        with contextlib.suppress(Exception):
            side.send(("closed",))
        conn.close()


# --------------------------------------------------------------------------- parent side


class RemoteWorker:
    """The parent's handle on one child: the process, the pipe, the two forwarding loops."""

    def __init__(
        self, inst: NodeInstance, rc: RunContext, capacity: int | None, batch: int
    ) -> None:
        self.inst = inst
        self.rc = rc
        self.in_flight = 0
        self.messages = 0
        self.closed_normally = False
        self._lock = threading.Lock()
        ctx = mp.get_context("spawn")
        self.conn, self._child_conn = ctx.Pipe(duplex=True)
        payload = ChildPayload(
            spec=inst.spec,
            n_in=len(inst.inbox.edges_in),
            n_out=len(inst.outbox.edges),
            capacity=capacity,
            batch=batch,
        )
        self.process = ctx.Process(
            target=_child_main,
            args=(self._child_conn, dumps_spec(payload, f"worker {inst.name!r}")),
            name=f"tolquane:{inst.name}",
            daemon=True,
        )

    def start(self) -> None:
        self.process.start()
        self._child_conn.close()

    # ------------------------------------------------------------- parent -> child

    def _send(self, msg: Any) -> None:
        try:
            self.conn.send_bytes(dumps(msg))
        except (BrokenPipeError, OSError) as exc:
            raise WorkerDied(
                f"worker {self.inst.name!r}: its process is gone (exit code "
                f"{self.process.exitcode})"
            ) from exc

    def send_loop(self) -> None:
        inbox = self.inst.inbox
        remaining = len(inbox.edges_in)
        stats = self.inst.stats
        while remaining > 0:
            src, entry = inbox.pop()
            if entry is EOS:
                inbox.release(src)
                remaining -= 1
                edge = inbox.edges_in[src]
                if edge.entry_loop is not None:
                    edge.entry_loop.external_ended()
                self._send(("eos", src))
                continue
            if entry is LOOP_DONE:
                continue
            if isinstance(entry, Batch):
                items = entry.items
                self._entered(src, len(items))
                stats.items_in += len(items)
                with self._lock:
                    self.in_flight += len(items)
                self._send(("batch", src, items))
            else:
                self._entered(src, 1)
                stats.items_in += 1
                with self._lock:
                    self.in_flight += 1
                self._send(("item", src, entry))
        self._send(("close",))

    def _entered(self, src: int, n: int) -> None:
        loop = self.inst.inbox.edges_in[src].entry_loop
        if loop is not None:
            for _ in range(n):
                loop.enter()

    # ------------------------------------------------------------- child -> parent

    def receive_loop(self) -> None:
        inst = self.inst
        outbox = inst.outbox
        try:
            while True:
                try:
                    msg = loads(self.conn.recv_bytes())
                except (EOFError, OSError):
                    if not self.closed_normally and not self.rc.cancelled:
                        self.rc.fail(
                            inst,
                            WorkerDied(
                                f"worker {inst.name!r}: its process died without finishing "
                                f"(exit code {self.process.exitcode})"
                            ),
                        )
                    return
                self.messages += 1
                kind = msg[0]
                if kind == "outs":
                    for idx, item in msg[1]:
                        if isinstance(item, Done):
                            with self._lock:
                                self.in_flight -= 1
                            inst.inbox.release(item.src)
                            if inst.loop is not None:
                                inst.loop.done()
                        else:
                            outbox.put(outbox.edges[idx], item, raw=True)
                elif kind == "error":
                    exc = msg[1]
                    if isinstance(exc, TolquaneError) and hasattr(exc, "original"):
                        exc = exc.original  # NodeError from the child graph: keep the cause
                    self.rc.fail(inst, exc)
                    return
                elif kind == "closed":
                    self.closed_normally = True
                    return
        except Cancelled:
            return
        except BaseException as exc:
            self.rc.fail(inst, exc)

    # ------------------------------------------------------------- lifecycle

    def shutdown(self) -> None:
        with contextlib.suppress(OSError):
            self.conn.close()
        if self.process.is_alive():
            self.process.join(2.0)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(1.0)
        if self.process.is_alive():
            self.process.kill()
            self.process.join(1.0)


def run_proxy(inst: NodeInstance, rc: RunContext) -> None:
    """Thread body for a remote worker's proxy in the parent."""
    remote = inst.remote
    assert remote is not None
    receiver = threading.Thread(
        target=remote.receive_loop, name=f"tolquane:{inst.name}:recv", daemon=True
    )
    try:
        rc.scheduler.node_started(inst)
        receiver.start()
        remote.send_loop()
        receiver.join()
    except Cancelled:
        pass
    except BaseException as exc:
        rc.fail(inst, exc)
    finally:
        remote.shutdown()
        if receiver.is_alive():
            receiver.join(2.0)
        try:
            inst.outbox.close_all()
        except Cancelled:
            pass
        except BaseException as exc:
            rc.fail(inst, exc)
        inst.inbox.mark_done()
        rc.node_done(inst)
