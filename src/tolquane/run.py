"""``check`` and ``run``: the two entry points that take a block and do something with it."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .errors import TolquaneError
from .graph import Graph, build, validate
from .runtime import Report, execute


def check(block: Any) -> Graph:
    """Expand and validate a block without running it. Raises ``GraphError`` with a fix."""
    if isinstance(block, Graph):
        validate(block)
        return block
    return build(block)


def run(
    block: Any,
    *,
    runtime: str = "threads",
    capacity: int | None = 1024,
    batch: int = 32,
    deadlock_timeout: float | None = 0.3,
    deploy: str | Path | dict[str, Any] | None = None,
    group: str | None = None,
) -> Report:
    """Run a block to completion and return a ``Report``.

    ``runtime`` is ``"threads"`` (default), ``"processes"`` (every farm worker in its own
    child process, the rest in this one) or ``"sync"`` (deterministic, one node at a
    time, exact deadlock detection). ``capacity`` bounds every edge that does not set
    its own; ``None`` means unbounded. ``batch`` lets a channel carry up to that many
    items per hand-off (a partial batch is sent after one millisecond or when the
    producer has nothing else to do); user code always sees single items. ``batch=1``
    hands over every item on its own.
    ``deadlock_timeout`` is how long the thread runtime tolerates every node waiting
    before raising ``DeadlockError``. With ``deploy`` (a deploy file or dict) and
    ``group``, only this group's nodes run here and edges to other groups go over TCP;
    every group runs the same call with its own name.
    """
    if capacity is not None and capacity < 1:
        raise TolquaneError("capacity must be at least 1, or None for unbounded")
    if batch < 1:
        raise TolquaneError("batch must be at least 1")
    graph = check(block)
    if deploy is not None or group is not None:
        if deploy is None or group is None:
            raise TolquaneError(
                "deploy= and group= go together: which deploy file, and which group is this"
            )
        from .net import run_group

        report: Report = run_group(
            graph,
            deploy,
            group,
            runtime=runtime,
            capacity=capacity,
            batch=batch,
            deadlock_timeout=deadlock_timeout,
        )
        return report
    return execute(
        graph, runtime=runtime, capacity=capacity, batch=batch, deadlock_timeout=deadlock_timeout
    )
