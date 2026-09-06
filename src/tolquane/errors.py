"""Exceptions raised by Tolquane. Every message names the node and says what to do."""

from __future__ import annotations

from typing import Any


class TolquaneError(Exception):
    """Base class for every error raised by Tolquane."""


class GraphError(TolquaneError):
    """The graph is not valid. Raised by ``check()`` and ``run()`` before anything starts."""


class ChannelClosed(TolquaneError):
    """An item was sent on an output that had already been closed."""


class DeadlockError(TolquaneError):
    """Every live node is waiting on another one, so nothing can make progress."""


class RunCancelled(TolquaneError):
    """The run was stopped through its ``stop`` event before it had finished."""


class NodeError(TolquaneError):
    """User code inside a node raised. The original exception is the ``__cause__``."""

    def __init__(self, node: str, index: int, exc: BaseException) -> None:
        self.node = node
        self.index = index
        self.original = exc
        super().__init__(f"node {node!r} failed: {type(exc).__name__}: {exc}")
        self.__cause__ = exc

    def __reduce__(self) -> tuple[Any, ...]:
        return (NodeError, (self.node, self.index, self.original))


class RunFailure(TolquaneError):
    """Failures of the machinery rather than of user code; raised as they are, never
    wrapped in a ``NodeError``."""


class WorkerDied(RunFailure):
    """A worker process ended without finishing its work (crash, kill, out of memory)."""


class Cancelled(BaseException):
    """Internal control-flow signal: the run was cancelled. Never shown to users."""
