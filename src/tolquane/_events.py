"""The JSON line stream behind ``tolquane run --events``.

One JSON object per line on the real stdout, so a supervisor can follow a run it did
not start itself: what the graph looks like, how it is getting on, what the flow
printed, how it ended. The flow's own ``print`` and ``sys.stderr`` writes become
``stdout`` and ``stderr`` events, which keeps the line stream parseable whatever the
flow does with them; child processes of the processes runtime still write to the
terminal, since only this process's streams are swapped.
"""

from __future__ import annotations

import contextlib
import io
import json
import signal
import sys
import threading
import traceback
from collections.abc import Iterator
from types import FrameType
from typing import TYPE_CHECKING, Any, TextIO

from .graph import DEFAULT_BATCH, DEFAULT_CAPACITY, Graph

if TYPE_CHECKING:
    from .runtime import Progress


class EventStream:
    """Writes events as JSON lines. Every node thread may reach it, so writes take a lock."""

    def __init__(self, out: TextIO) -> None:
        self.out = out
        self.lock = threading.Lock()

    def emit(self, event: str, **fields: Any) -> None:
        # default=str: an item, a report value or an exception message that json does not
        # know must never break the stream the supervisor is reading.
        line = json.dumps({"event": event, **fields}, default=str)
        with self.lock:
            self.out.write(line + "\n")
            self.out.flush()

    def progress(self, snapshot: Progress) -> None:
        self.emit("progress", progress=snapshot.to_dict())

    def error(self, exc: BaseException) -> None:
        self.emit(
            "error",
            type=type(exc).__name__,
            message=str(exc),
            node=getattr(exc, "node", None),
            traceback="".join(traceback.format_exception(exc)),
        )


class LineWriter(io.TextIOBase):
    """Stands in for ``sys.stdout`` or ``sys.stderr`` and emits whole lines as events."""

    def __init__(self, stream: EventStream, kind: str) -> None:
        super().__init__()
        self.stream = stream
        self.kind = kind
        self.lock = threading.Lock()
        self.parts: list[str] = []

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def write(self, s: str, /) -> int:
        with self.lock:
            self.parts.append(s)
            if "\n" not in s:
                return len(s)
            text = "".join(self.parts)
            head, _, tail = text.rpartition("\n")
            self.parts = [tail] if tail else []
        self.stream.emit(self.kind, text=head + "\n")
        return len(s)

    def flush(self) -> None:
        with self.lock:
            if not self.parts:
                return
            text = "".join(self.parts)
            self.parts = []
        self.stream.emit(self.kind, text=text)


@contextlib.contextmanager
def capture_output(stream: EventStream) -> Iterator[None]:
    """Turn this process's ``print`` and ``sys.stderr`` writes into events."""
    out = LineWriter(stream, "stdout")
    err = LineWriter(stream, "stderr")
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        yield
    finally:
        out.flush()
        err.flush()
        sys.stdout, sys.stderr = old_out, old_err


@contextlib.contextmanager
def stop_on_signal(stop: threading.Event) -> Iterator[None]:
    """SIGTERM and SIGINT set ``stop``, so the run cancels the way an error does."""

    def handler(signum: int, frame: FrameType | None) -> None:
        stop.set()

    previous: list[tuple[signal.Signals, Any]] = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        # Only the main thread may install handlers; anywhere else, leave them alone.
        with contextlib.suppress(ValueError, OSError):
            previous.append((sig, signal.signal(sig, handler)))
    try:
        yield
    finally:
        for sig, old in previous:
            with contextlib.suppress(ValueError, OSError):
                signal.signal(sig, old)


def graph_view(graph: Graph) -> dict[str, Any]:
    """The expanded graph as JSON-ready data, for a viewer that draws the run.

    ``capacity`` and ``batch`` are ``null`` where the edge takes the run's value rather
    than one of its own.
    """
    return {
        "nodes": [
            {
                "name": n.name,
                "kind": n.kind,
                "role": n.role,
                "group": n.group,
                "is_sink": n.is_sink,
                "is_async": n.is_async,
                "tagged": n.tagged,
            }
            for n in graph.nodes
        ],
        "edges": [
            {
                "src": e.src,
                "dst": e.dst,
                "rule": e.rule,
                "feedback": e.feedback,
                "capacity": None if e.capacity == DEFAULT_CAPACITY else e.capacity,
                "batch": None if e.batch == DEFAULT_BATCH else e.batch,
            }
            for e in graph.edges
        ],
        "loops": [
            {"name": loop.name, "nodes": list(loop.nodes), "heads": list(loop.heads)}
            for loop in graph.loops
        ],
        "windows": dict(graph.windows),
    }


__all__ = ["EventStream", "LineWriter", "capture_output", "graph_view", "stop_on_signal"]
