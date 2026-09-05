"""``session()``: keep a graph running and push items in, pull results out."""

from __future__ import annotations

import queue
import threading
from collections.abc import Iterator
from typing import Any

from .errors import GraphError, TolquaneError
from .graph import Graph, NodeSpec, connect, expand, validate
from .runtime import Report, execute

_CLOSE = object()
_END = object()


class SessionClosed(TolquaneError):
    """``get()`` was called after the graph finished and every result was read."""


class Session:
    """A running graph you feed with ``put`` and read with ``get`` or iteration.

    Use it as a context manager; leaving the block closes the input, waits for the
    graph to drain and re-raises any failure.
    """

    def __init__(
        self,
        block: Any,
        *,
        runtime: str = "threads",
        capacity: int | None = 1024,
        batch: int = 32,
        deadlock_timeout: float | None = 0.3,
    ) -> None:
        if runtime != "threads":
            raise GraphError("session() runs on the threads runtime only")
        inner = block if isinstance(block, Graph) else expand(block)
        if not inner.inlets:
            raise GraphError("session() needs a block with inputs; it starts with a source")
        self._in: queue.Queue[Any] = queue.Queue()
        self._out: queue.Queue[Any] = queue.Queue()
        self._closed = False
        self._error: BaseException | None = None
        self.report: Report | None = None
        self.has_output = bool(inner.outlets)
        g = Graph(
            nodes=list(inner.nodes),
            edges=list(inner.edges),
            windows=dict(inner.windows),
            loops=list(inner.loops),
        )
        g.nodes.insert(0, NodeSpec("session.in", "raw", self._feed))
        g.edges.extend(connect(["session.in"], inner.inlets, batch=1))
        if self.has_output:
            g.nodes.append(NodeSpec("session.out", "map", self._out.put, is_sink=True))
            g.edges.extend(connect(inner.outlets, ["session.out"], batch=1))
        validate(g)
        self._graph = g
        self._runtime = runtime
        self._capacity = capacity
        self._batch = batch
        self._deadlock_timeout = deadlock_timeout
        self._thread = threading.Thread(target=self._run, name="tolquane:session", daemon=True)

    def _feed(self, ctx: Any) -> None:
        while True:
            try:
                item = self._in.get(timeout=0.05)
            except queue.Empty:
                if ctx.cancelled:
                    return
                continue
            if item is _CLOSE:
                return
            ctx.send(item)
            ctx.flush()

    def _run(self) -> None:
        try:
            self.report = execute(
                self._graph,
                runtime=self._runtime,
                capacity=self._capacity,
                batch=self._batch,
                deadlock_timeout=self._deadlock_timeout,
            )
        except BaseException as exc:
            self._error = exc
        finally:
            self._out.put(_END)

    def __enter__(self) -> Session:
        self._thread.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()
        self._thread.join()
        if self._error is not None and exc is None:
            raise self._error

    def put(self, item: Any) -> None:
        """Send one item into the graph."""
        if self._closed:
            raise SessionClosed("the session input is closed")
        self._in.put(item)

    def close(self) -> None:
        """End the input stream; the graph drains and finishes."""
        if not self._closed:
            self._closed = True
            self._in.put(_CLOSE)

    def get(self, timeout: float | None = None) -> Any:
        """Next result. Blocks up to ``timeout``; raises ``SessionClosed`` when done."""
        if not self.has_output:
            raise SessionClosed("this graph ends in a sink, so there is nothing to get")
        item = self._out.get(timeout=timeout)
        if item is _END:
            self._out.put(_END)
            if self._error is not None:
                raise self._error
            raise SessionClosed("the graph has finished and every result was read")
        return item

    def __iter__(self) -> Iterator[Any]:
        while True:
            try:
                yield self.get()
            except SessionClosed:
                return
