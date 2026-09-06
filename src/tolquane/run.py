"""``check`` and ``run``: the two entry points that take a block and do something with it."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .errors import TolquaneError
from .graph import Graph, build, validate
from .runtime import Progress, Report, execute


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
    trace: str | None = None,
    on_progress: Callable[[Progress], None] | None = None,
    progress_interval: float = 0.5,
    tap: int = 0,
    stop: threading.Event | None = None,
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
    every group runs the same call with its own name. ``trace`` writes a Chrome trace
    file (open it in Perfetto or chrome://tracing) with every node's run and every
    wait for input, output or window, to see where time goes.
    ``on_progress`` is called with a ``Progress`` snapshot every ``progress_interval``
    seconds while the run is going and once more when it ends, from the watchdog thread;
    ``tap=N`` adds the last ``N`` items that crossed each edge to it, as text. ``stop``
    is a ``threading.Event``: setting it cancels the run the way an error does, and
    ``run`` then raises ``RunCancelled``.
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
            on_progress=on_progress,
            progress_interval=progress_interval,
            tap=tap,
            stop=stop,
        )
        return report
    return execute(
        graph,
        runtime=runtime,
        capacity=capacity,
        batch=batch,
        deadlock_timeout=deadlock_timeout,
        trace=trace,
        on_progress=on_progress,
        progress_interval=progress_interval,
        tap=tap,
        stop=stop,
    )
