"""The distributed runtime: one graph, cut into groups that talk over TCP.

A deploy file names groups, gives each an endpoint and says which nodes it runs. Every
host runs the same flow with ``tq.run(graph, deploy=..., group=...)``; the graph itself
never changes. Inside a group the nodes run exactly as on the threads or processes
runtime. An edge whose ends live in two groups becomes a pair of raw proxy nodes: a
``NetOut`` on the sending side, which takes the sender's items from its inbox and
writes them to a TCP connection, and a ``NetIn`` on the receiving side, which reads
them and feeds the receiver's inbox.

The protocol keeps the liveness rules across the wire. Frames are length-prefixed and
typed; control (hello, welcome, challenge, ack, end of stream, error) never travels as
data. Items go in batches numbered by their position in the stream; the receiver
acknowledges after it has handed a batch to the local node, and only then does the
sender give the producer's credits back, so ``capacity`` and ``on_demand`` mean the
same thing across hosts as inside one. A dropped connection is reconnected with the
receiver saying which position it expects next, so nothing is lost or duplicated
within a run. A group that fails tells its peers why, and they fail with ``PeerFailed``;
a peer that cannot be reached within the budget fails with ``PeerLost``. An optional
shared secret authenticates every connection with an HMAC challenge.
"""

from __future__ import annotations

import contextlib
import fnmatch
import hashlib
import hmac
import os
import pickle
import queue
import socket
import struct
import threading
import time
import tomllib
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ._sentinels import EOS, LOOP_DONE
from .channel import Batch
from .errors import Cancelled, GraphError, RunFailure
from .graph import EdgeSpec, Graph, NodeSpec

if TYPE_CHECKING:
    from .runner import Context

PROTOCOL = 5
HELLO, WELCOME, CHALLENGE, RESPONSE, DATA, ACK, END, ERROR = range(1, 9)
_HEADER = struct.Struct(">IB")
_SOCKET_TIMEOUT = 0.5


class PeerFailed(RunFailure):
    """Another group reported a failure; this group stops too."""


class PeerLost(RunFailure):
    """Another group could not be reached, or stayed unreachable, within the budget."""


# --------------------------------------------------------------------------- deployment


@dataclass(frozen=True)
class Group:
    name: str
    host: str
    port: int
    patterns: tuple[str, ...]
    ssh: str | None = None  # where ``tolquane launch`` starts this group; default: host
    python: str | None = None
    workdir: str | None = None

    @property
    def endpoint(self) -> str:
        return f"{self.host}:{self.port}"


@dataclass(frozen=True)
class Deployment:
    groups: dict[str, Group]
    secret: str | None = None
    connect_timeout: float = 60.0
    reconnect_timeout: float = 30.0
    python: str | None = None
    workdir: str | None = None

    def group(self, name: str) -> Group:
        if name not in self.groups:
            raise GraphError(
                f"unknown group {name!r}; the deploy file defines {sorted(self.groups)}"
            )
        return self.groups[name]


def _optional_str(table: dict[str, Any], key: str, where: str) -> str | None:
    value = table.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise GraphError(f"{where}: {key} must be a non-empty string, got {value!r}")
    return value


def load_deployment(source: str | Path | dict[str, Any]) -> Deployment:
    """Read a deploy file (TOML) or an equivalent dict.

    ```toml
    [groups.G1]
    endpoint = "10.0.0.1:7000"
    nodes = ["numbers", "double"]          # node names, farm names, or glob patterns
    [groups.G2]
    endpoint = "10.0.0.2:7000"
    nodes = ["show"]
    ssh = "me@10.0.0.2"                    # optional; where `tolquane launch` starts it
    [options]
    secret = "change-me"                   # optional; HMAC handshake on every connection
    connect_timeout = 60                   # seconds to wait for a peer to come up
    reconnect_timeout = 30                 # seconds to tolerate a dropped connection
    python = "python3"                     # optional; interpreter `tolquane launch` uses
    workdir = "/srv/flow"                  # optional; directory it starts each group in
    ```

    ``ssh``, ``python`` and ``workdir`` may also be given per group.
    """
    if isinstance(source, dict):
        data = source
    else:
        path = Path(source)
        if not path.exists():
            raise GraphError(f"deploy file {path} does not exist")
        data = tomllib.loads(path.read_text())
    raw_groups = data.get("groups")
    if not isinstance(raw_groups, dict) or not raw_groups:
        raise GraphError("the deploy file needs a [groups.<name>] table per group")
    groups: dict[str, Group] = {}
    for name, g in raw_groups.items():
        endpoint = str(g.get("endpoint", ""))
        host, _, port = endpoint.rpartition(":")
        if not host or not port.isdigit():
            raise GraphError(f'group {name!r} needs endpoint = "host:port", got {endpoint!r}')
        nodes = g.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            raise GraphError(f"group {name!r} needs nodes = [...] naming what it runs")
        groups[name] = Group(
            name,
            host,
            int(port),
            tuple(str(n) for n in nodes),
            ssh=_optional_str(g, "ssh", name),
            python=_optional_str(g, "python", name),
            workdir=_optional_str(g, "workdir", name),
        )
    options = data.get("options", {})
    return Deployment(
        groups,
        secret=options.get("secret"),
        connect_timeout=float(options.get("connect_timeout", 60.0)),
        reconnect_timeout=float(options.get("reconnect_timeout", 30.0)),
        python=_optional_str(options, "python", "options"),
        workdir=_optional_str(options, "workdir", "options"),
    )


def assign(graph: Graph, deployment: Deployment) -> dict[str, str]:
    """Map every node to exactly one group by name, farm name or glob pattern."""
    result: dict[str, str] = {}
    for node in graph.nodes:
        matches = [
            g.name
            for g in deployment.groups.values()
            if any(
                p == node.name
                or (node.group is not None and p == node.group)
                or fnmatch.fnmatchcase(node.name, p)
                for p in g.patterns
            )
        ]
        if not matches:
            hint = f" (or its farm {node.group!r})" if node.group else ""
            raise GraphError(
                f"node {node.name!r} is not assigned to any group; add it{hint} to a group's "
                "nodes list"
            )
        if len(set(matches)) > 1:
            raise GraphError(
                f"node {node.name!r} is claimed by several groups: {sorted(set(matches))}"
            )
        result[node.name] = matches[0]
    return result


@dataclass(frozen=True)
class NetEdge:
    id: str
    spec: EdgeSpec
    src_group: str
    dst_group: str


class NetOut:
    """Raw node on the sending side of a cut edge."""

    def __init__(self, state: _State, edge: NetEdge) -> None:
        self.state = state
        self.edge = edge

    def __call__(self, ctx: Context) -> None:
        _Sender(self.state, self.edge, ctx).run()


class NetIn:
    """Raw node on the receiving side of a cut edge."""

    def __init__(self, state: _State, edge: NetEdge) -> None:
        self.state = state
        self.edge = edge

    def __call__(self, ctx: Context) -> None:
        _Receiver(self.state, self.edge, ctx).run()


def partition(
    graph: Graph, deployment: Deployment, group: str, state: _State
) -> tuple[Graph, list[NetEdge]]:
    """This group's share of the graph, with proxy nodes for every edge that leaves or enters it."""
    deployment.group(group)
    assignment = assign(graph, deployment)
    for loop in graph.loops:
        owners = {assignment[n] for n in loop.nodes}
        if len(owners) > 1:
            raise GraphError(
                f"feedback loop {loop.name!r} spans groups {sorted(owners)}; keep a loop "
                "inside one group"
            )
    for node in graph.nodes:
        if node.window and node.role == "emitter":
            collector = node.name.rsplit(".", 1)[0] + ".collector"
            if assignment.get(collector) != assignment[node.name]:
                raise GraphError(
                    f"farm {node.group!r} is ordered or gathers, so its emitter and collector "
                    "must be in the same group (the workers may be anywhere)"
                )
    local_names = {n.name for n in graph.nodes if assignment[n.name] == group}
    nodes: list[NodeSpec] = [n for n in graph.nodes if n.name in local_names]
    edges: list[EdgeSpec] = []
    net_edges: list[NetEdge] = []
    seen: dict[tuple[str, str], int] = {}
    for e in graph.edges:
        k = seen.get((e.src, e.dst), 0)
        seen[(e.src, e.dst)] = k + 1
        sg, dg = assignment[e.src], assignment[e.dst]
        if sg == group and dg == group:
            edges.append(e)
            continue
        if sg != group and dg != group:
            continue
        edge_id = f"{e.src}->{e.dst}#{k}"
        net = NetEdge(edge_id, e, sg, dg)
        net_edges.append(net)
        if sg == group:
            name = f"net.out:{edge_id}"
            nodes.append(NodeSpec(name, "raw", NetOut(state, net)))
            edges.append(EdgeSpec(e.src, name, "net", e.capacity, e.batch, e.feedback))
        else:
            name = f"net.in:{edge_id}"
            nodes.append(NodeSpec(name, "raw", NetIn(state, net)))
            edges.append(EdgeSpec(name, e.dst, "net", e.capacity, e.batch, e.feedback))
    local = Graph(
        nodes=nodes,
        edges=edges,
        windows={
            w: lim
            for w, lim in graph.windows.items()
            if w.rsplit(".", 1)[0] + ".emitter" in local_names
        },
        loops=[lp for lp in graph.loops if set(lp.nodes) <= local_names],
    )
    return local, net_edges


# --------------------------------------------------------------------------- frames


def send_frame(sock: socket.socket, kind: int, obj: Any) -> None:
    payload = pickle.dumps(obj, protocol=PROTOCOL)
    sock.sendall(_HEADER.pack(len(payload), kind) + payload)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < n:
        chunk = sock.recv(n - len(chunks))
        if not chunk:
            raise ConnectionError("the peer closed the connection")
        chunks.extend(chunk)
    return bytes(chunks)


def recv_frame(sock: socket.socket) -> tuple[int, Any]:
    """One frame. Raises ``TimeoutError`` on the socket timeout, ``ConnectionError`` on EOF."""
    header = _recv_exact(sock, _HEADER.size)
    size, kind = _HEADER.unpack(header)
    payload = _recv_exact(sock, size) if size else b""
    return kind, (pickle.loads(payload) if payload else None)


# --------------------------------------------------------------------------- run state


class _State:
    """Shared by every net node of one group run: the listener, the queues, the secret."""

    def __init__(self, deployment: Deployment, group: str) -> None:
        self.deployment = deployment
        self.group = group
        self.inbound: dict[str, queue.Queue[tuple[socket.socket, int]]] = {}
        self.listener: _Listener | None = None
        self.failure: str | None = None
        self.lock = threading.Lock()

    def register_inbound(self, edge_id: str) -> None:
        self.inbound.setdefault(edge_id, queue.Queue())

    def close(self) -> None:
        if self.listener is not None:
            self.listener.stop()


class _Listener:
    """One listening socket per group; hands each incoming connection to its NetIn."""

    def __init__(self, state: _State, host: str, port: int) -> None:
        self.state = state
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.sock.bind((host, port))
        except OSError as exc:
            raise PeerLost(f"group {state.group!r} cannot listen on {host}:{port}: {exc}") from exc
        self.sock.listen(64)
        self.sock.settimeout(_SOCKET_TIMEOUT)
        self.stopped = False
        self.thread = threading.Thread(
            target=self._accept_loop, name=f"tolquane:listen:{state.group}", daemon=True
        )
        self.thread.start()

    def _accept_loop(self) -> None:
        while not self.stopped:
            try:
                conn, _ = self.sock.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            threading.Thread(target=self._handshake, args=(conn,), daemon=True).start()

    def _handshake(self, conn: socket.socket) -> None:
        conn.settimeout(10.0)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        try:
            kind, hello = recv_frame(conn)
            if kind != HELLO or not isinstance(hello, dict):
                raise ConnectionError("expected a hello frame")
            secret = self.state.deployment.secret
            if secret:
                nonce = os.urandom(32)
                send_frame(conn, CHALLENGE, nonce)
                kind, digest = recv_frame(conn)
                expected = hmac.new(secret.encode(), nonce, hashlib.sha256).digest()
                if kind != RESPONSE or not hmac.compare_digest(bytes(digest), expected):
                    send_frame(conn, ERROR, "authentication failed")
                    raise ConnectionError("authentication failed")
            edge_id = str(hello.get("edge"))
            q = self.state.inbound.get(edge_id)
            if q is None:
                send_frame(conn, ERROR, f"group {self.state.group!r} has no input {edge_id!r}")
                raise ConnectionError("unknown edge")
            q.put((conn, int(hello.get("sent", 0))))
        except (OSError, ConnectionError, pickle.UnpicklingError, EOFError):
            conn.close()

    def stop(self) -> None:
        self.stopped = True
        with contextlib.suppress(OSError):
            self.sock.close()
        self.thread.join(2.0)


# --------------------------------------------------------------------------- sender


class _Sender:
    def __init__(self, state: _State, edge: NetEdge, ctx: Context) -> None:
        self.state = state
        self.edge = edge
        self.ctx = ctx
        self.inst = ctx._inst
        self.rc = ctx._rc
        self.dst = state.deployment.group(edge.dst_group)
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.rc.register_cond(self.cond)
        self.sent = 0  # items sent so far
        self.acked = 0  # items the peer has handed to its node
        self.unacked: deque[tuple[int, list[Any]]] = deque()
        self.sock: socket.socket | None = None
        self.error: str | None = None
        self.dropped = False
        cap = self.inst.inbox.edges_in[0].capacity
        self.window = cap if cap is not None else 1 << 30
        self.batch = max(1, self.inst.inbox.edges_in[0].batch)

    # ---------------------------------------------------------------- connection

    def _connect(self, budget: float) -> None:
        deadline = time.monotonic() + budget
        delay = 0.05
        while True:
            if self.rc.cancelled:
                raise Cancelled
            if self.error is not None:
                raise PeerFailed(f"group {self.dst.name!r}: {self.error}")
            try:
                sock = socket.create_connection((self.dst.host, self.dst.port), timeout=2.0)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.settimeout(10.0)
                send_frame(
                    sock,
                    HELLO,
                    {"edge": self.edge.id, "group": self.state.group, "sent": self.sent},
                )
                kind, obj = recv_frame(sock)
                if kind == CHALLENGE:
                    secret = self.state.deployment.secret or ""
                    send_frame(
                        sock,
                        RESPONSE,
                        hmac.new(secret.encode(), bytes(obj), hashlib.sha256).digest(),
                    )
                    kind, obj = recv_frame(sock)
                if kind == ERROR:
                    raise PeerLost(f"group {self.dst.name!r} refused {self.edge.id!r}: {obj}")
                if kind != WELCOME:
                    raise ConnectionError(f"unexpected frame {kind} during the handshake")
                expected = int(obj["expected"])
                break
            except PeerLost:
                raise
            except (OSError, ConnectionError, EOFError, pickle.UnpicklingError):
                if time.monotonic() >= deadline:
                    raise PeerLost(
                        f"group {self.dst.name!r} at {self.dst.endpoint} is not reachable for "
                        f"{self.edge.id!r} after {budget:.0f}s"
                    ) from None
                time.sleep(delay)
                delay = min(delay * 2, 1.0)
        sock.settimeout(_SOCKET_TIMEOUT)
        with self.lock:
            self.sock = sock
            self.dropped = False
            # The peer tells us where it is; anything it already has is acknowledged.
            if expected > self.acked:
                self._acknowledge(expected)
        threading.Thread(
            target=self._reader, args=(sock,), daemon=True, name=f"tolquane:net:{self.edge.id}"
        ).start()

    def _reader(self, sock: socket.socket) -> None:
        while True:
            try:
                kind, obj = recv_frame(sock)
            except TimeoutError:
                if self.rc.cancelled or self.sock is not sock:
                    return
                continue
            except (OSError, ConnectionError, EOFError):
                with self.lock:
                    if self.sock is sock:
                        self.dropped = True
                    self.cond.notify_all()
                return
            if kind == ACK:
                with self.lock:
                    self._acknowledge(int(obj))
                    self.cond.notify_all()
            elif kind == ERROR:
                with self.lock:
                    self.error = str(obj)
                    self.cond.notify_all()
                return

    def _acknowledge(self, upto: int) -> None:
        """Lock held. Release the local credits of items the peer has handed over."""
        n = upto - self.acked
        if n <= 0:
            return
        self.acked = upto
        while self.unacked and self.unacked[0][0] + len(self.unacked[0][1]) <= upto:
            self.unacked.popleft()
        self.inst.inbox.release(0, n)
        # Items the peer has not acknowledged are work outside this group's channels:
        # the deadlock watchdog must not count this node as idle while they are out.
        self.rc.scheduler.event(self.inst, -n)

    def _write(self, kind: int, obj: Any) -> None:
        sock = self.sock
        if sock is None:
            raise ConnectionError("not connected")
        payload = pickle.dumps(obj, protocol=PROTOCOL)
        data = _HEADER.pack(len(payload), kind) + payload
        view = memoryview(data)
        while view:
            if self.rc.cancelled:
                raise Cancelled
            try:
                n = sock.send(view)
            except TimeoutError:
                continue
            view = view[n:]

    # ---------------------------------------------------------------- main loop

    def run(self) -> None:
        inbox = self.inst.inbox
        stats = self.inst.stats
        remaining = len(inbox.edges_in)
        pending: list[Any] = []
        try:
            self._connect(self.state.deployment.connect_timeout)
            while remaining > 0:
                src, entry = inbox.pop()
                if entry is EOS:
                    remaining -= 1
                    inbox.release(src)
                    edge = inbox.edges_in[src]
                    if edge.entry_loop is not None:
                        edge.entry_loop.external_ended()
                    continue
                if entry is LOOP_DONE:
                    continue
                items = entry.items if isinstance(entry, Batch) else [entry]
                stats.items_in += len(items)
                pending.extend(items)
                if len(pending) >= self.batch or not self.ctx.input_waiting:
                    self._send_items(pending)
                    pending = []
            if pending:
                self._send_items(pending)
            self._finish()
        except Cancelled:
            self._say_goodbye()
            raise
        finally:
            self._close()

    def _send_items(self, items: list[Any]) -> None:
        while items:
            with self.lock:
                self._wait_for(lambda: self.sent - self.acked < self.window)
                room = self.window - (self.sent - self.acked)
            chunk, items = items[:room], items[room:]
            frame = (self.sent, chunk)
            with self.lock:
                self.unacked.append(frame)
                self.sent += len(chunk)
            self.rc.scheduler.event(self.inst, len(chunk))
            self._transmit(DATA, frame)
            self.inst.stats.items_out += len(chunk)

    def _transmit(self, kind: int, obj: Any) -> None:
        while True:
            try:
                self._write(kind, obj)
                return
            except (OSError, ConnectionError):
                time.sleep(0.05)  # let the reader thread pick up an ERROR frame first
                self._reconnect()

    def _reconnect(self) -> None:
        """Connect again and resend what the peer has not acknowledged; retry on failure."""
        deadline = time.monotonic() + self.state.deployment.reconnect_timeout
        while True:
            with self.lock:
                sock, self.sock = self.sock, None
                self.dropped = False
            if sock is not None:
                with contextlib.suppress(OSError):
                    sock.close()
            self._connect(max(0.5, deadline - time.monotonic()))
            with self.lock:
                resend = list(self.unacked)
            try:
                for first, items in resend:
                    self._write(DATA, (first, items))
                return
            except (OSError, ConnectionError):
                time.sleep(0.05)
                if time.monotonic() >= deadline:
                    raise PeerLost(
                        f"group {self.dst.name!r} keeps dropping {self.edge.id!r}"
                    ) from None

    def _wait_for(self, predicate: Any) -> None:
        """Lock held. Wait for acks, reconnecting if the connection dropped."""
        while not predicate():
            if self.rc.cancelled:
                raise Cancelled
            if self.error is not None:
                raise PeerFailed(f"group {self.dst.name!r}: {self.error}")
            if self.dropped:
                self.lock.release()
                try:
                    self._reconnect()
                finally:
                    self.lock.acquire()
                continue
            self.cond.wait(_SOCKET_TIMEOUT)

    def _finish(self) -> None:
        """Every item is sent: say the stream ended and wait until the peer has it all."""
        self._transmit(END, self.sent)
        with self.lock:
            self._wait_for(lambda: self.acked >= self.sent)

    def _say_goodbye(self) -> None:
        """Tell the peer why we stop; connect briefly if we never managed to."""
        message = self.state.failure
        if not message:
            return
        sock = self.sock
        if sock is not None:
            with contextlib.suppress(OSError):
                send_frame(sock, ERROR, message)
            return
        with contextlib.suppress(OSError, ConnectionError, EOFError, pickle.UnpicklingError):
            sock = socket.create_connection((self.dst.host, self.dst.port), timeout=2.0)
            sock.settimeout(5.0)
            send_frame(sock, HELLO, {"edge": self.edge.id, "group": self.state.group, "sent": 0})
            kind, obj = recv_frame(sock)
            if kind == CHALLENGE:
                secret = self.state.deployment.secret or ""
                digest = hmac.new(secret.encode(), bytes(obj), hashlib.sha256).digest()
                send_frame(sock, RESPONSE, digest)
                kind, obj = recv_frame(sock)
            if kind == WELCOME:
                send_frame(sock, ERROR, message)
            sock.close()

    def _close(self) -> None:
        with self.lock:
            sock, self.sock = self.sock, None
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.close()


# --------------------------------------------------------------------------- receiver


class _Receiver:
    def __init__(self, state: _State, edge: NetEdge, ctx: Context) -> None:
        self.state = state
        self.edge = edge
        self.ctx = ctx
        self.rc = ctx._rc
        self.src = state.deployment.group(edge.src_group)
        self.expected = 0
        self.sock: socket.socket | None = None

    def _wait_connection(self, budget: float) -> socket.socket:
        q = self.state.inbound[self.edge.id]
        deadline = time.monotonic() + budget
        while True:
            if self.rc.cancelled:
                raise Cancelled
            try:
                sock, _sent = q.get(timeout=_SOCKET_TIMEOUT)
                return sock
            except queue.Empty:
                if time.monotonic() >= deadline:
                    raise PeerLost(
                        f"group {self.src.name!r} never connected for {self.edge.id!r} within "
                        f"{budget:.0f}s; is it running with the same deploy file?"
                    ) from None

    def run(self) -> None:
        outbox = self.ctx._inst.outbox
        budget = self.state.deployment.connect_timeout
        try:
            while True:
                sock = self._wait_connection(budget)
                self.sock = sock
                sock.settimeout(_SOCKET_TIMEOUT)
                try:
                    send_frame(sock, WELCOME, {"expected": self.expected})
                    if self._serve(sock, outbox):
                        return
                except Cancelled:
                    self._say_goodbye()  # while the socket is still open
                    raise
                except (OSError, ConnectionError, EOFError, pickle.UnpicklingError):
                    pass  # dropped: wait for the sender to come back
                finally:
                    self.sock = None
                    sock.close()
                budget = self.state.deployment.reconnect_timeout
        except Cancelled:
            raise

    def _serve(self, sock: socket.socket, outbox: Any) -> bool:
        """Read frames until the stream ends (True) or the connection drops (False)."""
        stats = self.ctx._inst.stats
        while True:
            if self.rc.cancelled:
                raise Cancelled  # the failed node's inbox drops silently; do not keep acking
            if outbox.has_pending:
                outbox.flush()
            try:
                kind, obj = recv_frame(sock)
            except TimeoutError:
                if self.rc.cancelled:
                    raise Cancelled from None
                continue
            if kind == DATA:
                first, items = obj
                skip = self.expected - first
                if skip < 0:
                    raise ConnectionError(f"missing items before {first} on {self.edge.id!r}")
                for item in items[skip:]:
                    self.ctx.send(item)
                self.expected = max(self.expected, first + len(items))
                stats.items_in += max(0, len(items) - skip)
                send_frame(sock, ACK, self.expected)
            elif kind == END:
                final = int(obj)
                if final <= self.expected:
                    send_frame(sock, ACK, self.expected)
                    return True
                raise ConnectionError(f"end of stream at {final} but only {self.expected} arrived")
            elif kind == ERROR:
                raise PeerFailed(f"group {self.src.name!r}: {obj}")

    def _say_goodbye(self) -> None:
        message = self.state.failure
        if message and self.sock is not None:
            with contextlib.suppress(OSError):
                send_frame(self.sock, ERROR, message)


# --------------------------------------------------------------------------- entry point


def run_group(
    graph: Graph,
    deploy: str | Path | dict[str, Any] | Deployment,
    group: str,
    *,
    runtime: str = "threads",
    capacity: int | None = 1024,
    batch: int = 32,
    deadlock_timeout: float | None = 0.3,
    on_progress: Callable[[Any], None] | None = None,
    progress_interval: float = 0.5,
    tap: int = 0,
    stop: threading.Event | None = None,
) -> Any:
    """Run this group's share of ``graph``; every other group runs the same call elsewhere."""
    from .runtime import execute

    deployment = deploy if isinstance(deploy, Deployment) else load_deployment(deploy)
    state = _State(deployment, group)
    local, net_edges = partition(graph, deployment, group, state)
    incoming = [e for e in net_edges if e.dst_group == group]
    for e in incoming:
        state.register_inbound(e.id)
    me = deployment.group(group)
    if incoming:
        state.listener = _Listener(state, me.host, me.port)
    try:
        return execute(
            local,
            runtime=runtime,
            capacity=capacity,
            batch=batch,
            deadlock_timeout=deadlock_timeout,
            on_failure=lambda message: setattr(state, "failure", message),
            on_progress=on_progress,
            progress_interval=progress_interval,
            tap=tap,
            stop=stop,
        )
    finally:
        state.close()


__all__ = [
    "Deployment",
    "Group",
    "NetEdge",
    "PeerFailed",
    "PeerLost",
    "assign",
    "load_deployment",
    "partition",
    "run_group",
]
