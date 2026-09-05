"""``check`` and ``run``: the two entry points that take a block and do something with it."""

from __future__ import annotations

from typing import Any

from .errors import TolquaneError
from .graph import Graph, build
from .runtime import Report, execute


def check(block: Any) -> Graph:
    """Expand and validate a block without running it. Raises ``GraphError`` with a fix."""
    if isinstance(block, Graph):
        return block
    return build(block)


def run(
    block: Any,
    *,
    runtime: str = "threads",
    capacity: int | None = 1024,
    deadlock_timeout: float | None = 0.3,
) -> Report:
    """Run a block to completion and return a ``Report``.

    ``runtime`` is ``"threads"`` (default) or ``"sync"`` (deterministic, one node at a
    time, exact deadlock detection). ``capacity`` bounds every edge that does not set
    its own; ``None`` means unbounded. ``deadlock_timeout`` is how long the thread
    runtime tolerates every node waiting before raising ``DeadlockError``.
    """
    if capacity is not None and capacity < 1:
        raise TolquaneError("capacity must be at least 1, or None for unbounded")
    graph = check(block)
    return execute(graph, runtime=runtime, capacity=capacity, deadlock_timeout=deadlock_timeout)
