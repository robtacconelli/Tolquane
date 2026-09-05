"""Exceptions raised by Tolquane. Every message names the node and says what to do."""

from __future__ import annotations


class TolquaneError(Exception):
    """Base class for every error raised by Tolquane."""


class GraphError(TolquaneError):
    """The graph is not valid. Raised by ``check()`` and ``run()`` before anything starts."""


class ChannelClosed(TolquaneError):
    """An item was sent on an output that had already been closed."""


class DeadlockError(TolquaneError):
    """Every live node is waiting on another one, so nothing can make progress."""


class NodeError(TolquaneError):
    """User code inside a node raised. The original exception is the ``__cause__``."""

    def __init__(self, node: str, index: int, exc: BaseException) -> None:
        self.node = node
        self.index = index
        self.original = exc
        super().__init__(f"node {node!r} failed: {type(exc).__name__}: {exc}")
        self.__cause__ = exc


class Cancelled(BaseException):
    """Internal control-flow signal: the run was cancelled. Never shown to users."""
