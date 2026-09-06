"""The child processes Tolquane Web starts, and the events they send back.

Nothing a user wrote ever runs inside the server. A run is
``python -m tolquane run flow.py --events ...`` in a child process with the workspace as
its working directory; the supervisor reads its JSON lines on a thread, keeps them in
memory so a browser that connects late still sees the whole run, appends the flow's own
output to the run's log in the store, and writes the report and the final status when
the child ends. A flow that hangs, crashes or eats the machine costs one child process
and nothing else: cancel is ``SIGTERM`` and then ``SIGKILL``, and every child is killed
when the server exits, whichever way it exits.

The one-shot commands (parse, graph, check, explain, draw, optimize) go the same way,
through :func:`run_command`, with a timeout: they import the flow, so they cannot be
allowed to import it here.
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import json
import logging
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .settings import WebSettings
from .store import LOG_LIMIT, Run, Store

log = logging.getLogger(__name__)

WORK_DIR = ".tolquane-web"
"""Where the server keeps what a run needs: samples, traces, the builder's scratch."""

RETENTION = 600.0
"""Seconds a finished run's events stay in memory for a client that arrives late."""

KILL_AFTER_SHUTDOWN = 3.0
"""How long a child gets between the server's SIGTERM and its SIGKILL at exit."""


class SupervisorError(Exception):
    """Something the caller asked for cannot be done; the message says what."""


class TooManyRuns(SupervisorError):
    """The concurrent run limit is reached. The server answers 429."""


class ChildFailed(SupervisorError):
    """A one-shot child command failed; the message is the child's own."""


class ChildTimeout(ChildFailed):
    """A one-shot child command ran past ``exec_timeout``."""


# --------------------------------------------------------------------- one-shot commands


@dataclass(frozen=True)
class ChildResult:
    code: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.code == 0

    @property
    def message(self) -> str:
        """The child's complaint, without the ``error:`` the CLI puts in front of it."""
        text = (self.stderr.strip() or self.stdout.strip()).splitlines()
        for line in reversed(text):
            if line.strip():
                return line.strip().removeprefix("error: ")
        return f"the command failed with exit code {self.code}"


def run_command(argv: list[str], cwd: Path, timeout: float) -> ChildResult:
    """Run one command to completion. Raises :class:`ChildTimeout` past ``timeout``."""
    try:
        proc = subprocess.run(
            argv,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise ChildTimeout(
            f"the flow did not answer within {timeout:.0f}s; it may be importing something "
            "slow, or running work at import time"
        ) from exc
    except OSError as exc:  # pragma: no cover - a broken interpreter path
        raise ChildFailed(str(exc)) from exc
    return ChildResult(proc.returncode, proc.stdout, proc.stderr)


def json_command(argv: list[str], cwd: Path, timeout: float) -> Any:
    """Run a command whose stdout is one JSON document, and return it."""
    result = run_command(argv, cwd, timeout)
    if not result.ok:
        raise ChildFailed(result.message)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ChildFailed(f"the command did not answer with JSON: {result.stdout[:200]}") from exc


def model_command(command: str, target: Path, cwd: Path, timeout: float) -> Any:
    """``python -m tolquane.web.model parse|generate|graph``, as data."""
    argv = [sys.executable, "-m", "tolquane.web.model", command, str(target)]
    data = json_command(argv, cwd, timeout)
    if isinstance(data, dict) and "error" in data and len(data) == 1:
        raise ChildFailed(str(data["error"]))
    return data


def tolquane_command(command: str, flow: Path, cwd: Path, timeout: float) -> str:
    """``python -m tolquane check|explain|draw <flow>``, as the text it prints."""
    result = run_command([sys.executable, "-m", "tolquane", command, str(flow)], cwd, timeout)
    if not result.ok:
        raise ChildFailed(result.message)
    return result.stdout


_OPTIMIZE = r"""
import json, sys
import tolquane as tq
from tolquane._events import graph_view
from tolquane.web.model_parse import loaded

path, all2all = sys.argv[1], sys.argv[2] == "1"
notes = []
text = open(path, encoding="utf-8").read()
with loaded(text, "flow", path) as module:
    block = module.build()
    before = len(tq.check(block).nodes)
    graph = tq.check(tq.optimize(block, notes=notes, all2all=all2all))
print(json.dumps({"notes": notes, "graph": graph_view(graph),
                  "nodes": len(graph.nodes), "was": before}))
"""
"""``tq.optimize`` in a child: the notes it writes and the graph it leaves.

There is no command line form for this one -- ``tolquane optimize`` prints prose, and
the canvas needs the expanded graph as data -- so the server runs the three calls it
needs and asks for JSON back.
"""


def optimize_command(flow: Path, cwd: Path, timeout: float, all2all: bool) -> dict[str, Any]:
    """What ``tq.optimize`` makes of a flow: its notes and the graph that comes out."""
    argv = [sys.executable, "-c", _OPTIMIZE, str(flow), "1" if all2all else "0"]
    data = json_command(argv, cwd, timeout)
    if not isinstance(data, dict):  # pragma: no cover - the child prints one object
        raise ChildFailed("the optimizer did not answer with an object")
    return data


# --------------------------------------------------------------------------- live runs


@dataclass
class _Watcher:
    """One WebSocket, waiting on the loop it was accepted on."""

    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[dict[str, Any] | None]

    def push(self, event: dict[str, Any] | None) -> None:
        # A browser that went away takes its loop with it; the event is simply lost.
        with contextlib.suppress(RuntimeError):
            self.loop.call_soon_threadsafe(self.queue.put_nowait, event)


@dataclass
class LiveRun:
    """A run that is going, or one that ended recently enough to still be replayed."""

    id: int
    flow: str
    proc: subprocess.Popen[str]
    started: float = field(default_factory=time.monotonic)
    events: list[dict[str, Any]] = field(default_factory=list)
    log_parts: list[str] = field(default_factory=list)
    log_size: int = 0
    report: dict[str, Any] | None = None
    status: str | None = None
    error: str | None = None
    trace_path: str | None = None
    sample_file: Path | None = None
    cancelled: bool = False
    finished: bool = False
    ended_at: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    watchers: list[_Watcher] = field(default_factory=list)
    readers: list[threading.Thread] = field(default_factory=list)
    reaper: threading.Thread | None = None
    killer: threading.Timer | None = None

    @property
    def alive(self) -> bool:
        return not self.finished

    def log_text(self) -> str:
        with self.lock:
            return "".join(self.log_parts)

    def subscribe(
        self, loop: asyncio.AbstractEventLoop
    ) -> tuple[list[dict[str, Any]], _Watcher | None]:
        """The events so far and, while the run is going, where the next ones arrive.

        Both under one lock: an event that lands between the copy and the subscription
        would otherwise be the one event a late client never sees.
        """
        with self.lock:
            backlog = list(self.events)
            if self.finished:
                return backlog, None
            watcher = _Watcher(loop, asyncio.Queue())
            self.watchers.append(watcher)
            return backlog, watcher

    def unsubscribe(self, watcher: _Watcher) -> None:
        with self.lock:
            if watcher in self.watchers:
                self.watchers.remove(watcher)


class Supervisor:
    """Owns every child process a run needs, and the events it produced.

    ``on_finish`` is called once per run, from the thread that reaped the child, with
    the stored :class:`~tolquane.web.store.Run`; the server uses it to write a
    schedule's last result.
    """

    def __init__(
        self,
        workspace: Path,
        store: Store,
        settings: WebSettings,
        *,
        on_finish: Callable[[Run], None] | None = None,
    ) -> None:
        self.workspace = Path(workspace)
        self.store = store
        self.settings = settings
        self.on_finish = on_finish
        self.runs: dict[int, LiveRun] = {}
        self.lock = threading.RLock()
        self.closed = False
        atexit.register(self.shutdown)

    # Starting -----------------------------------------------------------

    def live_count(self) -> int:
        with self.lock:
            return sum(1 for live in self.runs.values() if live.alive)

    def get(self, run_id: int) -> LiveRun | None:
        with self.lock:
            return self.runs.get(run_id)

    def start(
        self,
        flow: str,
        *,
        runtime: str,
        sample_name: str | None = None,
        sample_items: list[Any] | None = None,
        batch: int | None = None,
        tap: int = 0,
        trace: bool = False,
        optimize: bool = False,
        trigger: str = "manual",
    ) -> Run:
        """Start a run of ``flow`` (a path relative to the workspace) and record it."""
        if self.closed:  # pragma: no cover - only after shutdown
            raise SupervisorError("the server is shutting down")
        self._purge()
        limit = self.settings.max_concurrent_runs
        if self.live_count() >= limit:
            raise TooManyRuns(
                f"{limit} runs are already going, which is max_concurrent_runs; "
                "wait for one to end, cancel one, or raise the limit in settings"
            )
        run = self.store.add_run(flow, runtime, sample_name, trigger)
        sample_file = self._write_sample(run.id, sample_items)
        trace_file = self._trace_path(run.id) if trace else None
        argv = self._argv(flow, runtime, tap, sample_file, batch, trace_file, optimize)
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(self.workspace),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:  # pragma: no cover - a broken interpreter path
            self.store.finish_run(run.id, "failed", None, "", None, str(exc))
            raise SupervisorError(f"could not start the run: {exc}") from exc
        live = LiveRun(run.id, flow, proc, sample_file=sample_file)
        live.trace_path = str(trace_file) if trace_file else None
        with self.lock:
            self.runs[run.id] = live
        for name, stream, kind in (
            ("stdout", proc.stdout, "stdout"),
            ("stderr", proc.stderr, "stderr"),
        ):
            thread = threading.Thread(
                target=self._read,
                args=(live, stream, kind),
                name=f"tolquane-run-{run.id}-{name}",
                daemon=True,
            )
            live.readers.append(thread)
            thread.start()
        live.reaper = threading.Thread(
            target=self._reap, args=(live,), name=f"tolquane-run-{run.id}", daemon=True
        )
        live.reaper.start()
        return run

    def _argv(
        self,
        flow: str,
        runtime: str,
        tap: int,
        sample_file: Path | None,
        batch: int | None,
        trace_file: Path | None,
        optimize: bool,
    ) -> list[str]:
        argv = [
            sys.executable,
            "-m",
            "tolquane",
            "run",
            flow,
            "--events",
            "--progress-interval",
            "0.5",
            "--tap",
            str(max(0, tap)),
        ]
        if sample_file is not None:
            argv += ["--sample", self._relative(sample_file)]
        if runtime:
            argv += ["--runtime", runtime]
        if batch is not None:
            argv += ["--batch", str(batch)]
        if trace_file is not None:
            argv += ["--trace", self._relative(trace_file)]
        if optimize:
            argv.append("--optimize")
        return argv

    def _relative(self, path: Path) -> str:
        return path.relative_to(self.workspace).as_posix()

    def _work_dir(self, *parts: str) -> Path:
        directory = self.workspace.joinpath(WORK_DIR, *parts)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _write_sample(self, run_id: int, items: list[Any] | None) -> Path | None:
        if items is None:
            return None
        path = self._work_dir("samples") / f"run-{run_id}.json"
        path.write_text(json.dumps(items), encoding="utf-8")
        return path

    def _trace_path(self, run_id: int) -> Path:
        return self._work_dir("traces") / f"run-{run_id}.json"

    # Reading ------------------------------------------------------------

    def _read(self, live: LiveRun, stream: Any, kind: str) -> None:
        """One thread per pipe. A line that is not JSON is output, not a broken event:
        a grandchild of the processes runtime writes to the same pipe."""
        try:
            for line in stream:
                text = line.rstrip("\n")
                if not text:
                    continue
                event: dict[str, Any] | None = None
                if kind == "stdout" and text.startswith("{"):
                    try:
                        parsed = json.loads(text)
                    except json.JSONDecodeError:
                        parsed = None
                    if isinstance(parsed, dict) and "event" in parsed:
                        event = parsed
                if event is None:
                    event = {"event": kind, "text": line}
                self._record(live, event)
        except (ValueError, OSError):  # the pipe closed under us
            pass
        finally:
            with contextlib.suppress(OSError, ValueError):
                stream.close()

    def _record(self, live: LiveRun, event: dict[str, Any]) -> None:
        kind = str(event.get("event", ""))
        watchers: list[_Watcher]
        with live.lock:
            live.events.append(event)
            if kind in ("stdout", "stderr"):
                self._append_log(live, str(event.get("text", "")))
            elif kind == "error":
                message = f"{event.get('type', 'Error')}: {event.get('message', '')}"
                live.error = live.error or message
                self._append_log(live, message + "\n")
            elif kind == "deadlock":
                live.error = live.error or str(event.get("message", "deadlock"))
                self._append_log(live, str(event.get("message", "")) + "\n")
            elif kind == "report":
                report = event.get("report")
                live.report = report if isinstance(report, dict) else None
            elif kind == "done":
                live.status = str(event.get("status", "done"))
            watchers = list(live.watchers)
        for watcher in watchers:
            watcher.push(event)

    @staticmethod
    def _append_log(live: LiveRun, text: str) -> None:
        """Keep the tail: the end of a failure is what a person needs to read."""
        if not text:
            return
        live.log_parts.append(text)
        live.log_size += len(text)
        while live.log_size > LOG_LIMIT and len(live.log_parts) > 1:
            live.log_size -= len(live.log_parts.pop(0))

    # Ending -------------------------------------------------------------

    def _reap(self, live: LiveRun) -> None:
        code = live.proc.wait()
        # The pipes are read on their own threads: wait for them, or the last lines the
        # child wrote would be recorded after the run was declared finished.
        for reader in live.readers:
            reader.join(timeout=5.0)
        if live.killer is not None:
            live.killer.cancel()
        status = live.status or "done"
        if live.status is None:
            status = "cancelled" if live.cancelled else ("done" if code == 0 else "failed")
            live.status = status
            # A child that died without saying so still owes the client a last event.
            self._record(
                live,
                {"event": "done", "status": status, "elapsed": time.monotonic() - live.started},
            )
        error = live.error
        if error is None and status == "failed":
            error = f"the run exited with code {code}"
        trace = live.trace_path if live.trace_path and Path(live.trace_path).exists() else None
        try:
            stored = self.store.finish_run(
                live.id, status, live.report, live.log_text(), trace, error
            )
        except Exception:  # pragma: no cover - the store is gone, the server is stopping
            log.exception("could not record the end of run %s", live.id)
            stored = None
        if live.sample_file is not None:
            live.sample_file.unlink(missing_ok=True)
        watchers: list[_Watcher]
        with live.lock:
            live.finished = True
            live.ended_at = time.monotonic()
            watchers = list(live.watchers)
            live.watchers.clear()
        for watcher in watchers:
            watcher.push(None)
        if stored is not None and self.on_finish is not None:
            try:
                self.on_finish(stored)
            except Exception:  # a callback must not take the reaper down
                log.exception("the finish callback for run %s failed", live.id)

    def cancel(self, run_id: int) -> bool:
        """Ask a run to stop: ``SIGTERM`` now, ``SIGKILL`` after ``cancel_grace``."""
        live = self.get(run_id)
        if live is None or live.finished:
            return False
        live.cancelled = True
        grace = self.settings.cancel_grace
        with contextlib.suppress(OSError, ValueError):
            live.proc.terminate()
        live.killer = threading.Timer(grace, self._kill, args=(live,))
        live.killer.daemon = True
        live.killer.start()
        return True

    @staticmethod
    def _kill(live: LiveRun) -> None:
        if live.proc.poll() is None:
            log.warning("run %s ignored SIGTERM; killing it", live.id)
            with contextlib.suppress(OSError, ValueError):
                live.proc.kill()

    def _purge(self) -> None:
        now = time.monotonic()
        with self.lock:
            for run_id, live in list(self.runs.items()):
                if live.ended_at is not None and now - live.ended_at > RETENTION:
                    del self.runs[run_id]

    def shutdown(self) -> None:
        """Kill every child. Registered with ``atexit`` as well as the app's lifespan."""
        with self.lock:
            if self.closed:
                return
            self.closed = True
            alive = [live for live in self.runs.values() if not live.finished]
        for live in alive:
            # A run the server stopped on its way out was cancelled, not failed, even
            # when the child died before it could say so itself.
            live.cancelled = True
            with contextlib.suppress(OSError, ValueError):
                live.proc.terminate()
        deadline = time.monotonic() + KILL_AFTER_SHUTDOWN
        for live in alive:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                live.proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(OSError, ValueError):
                    live.proc.kill()
        # Let each reaper write its run's last state; the caller closes the store next.
        for live in alive:
            if live.reaper is not None:
                live.reaper.join(timeout=KILL_AFTER_SHUTDOWN)


__all__ = [
    "ChildFailed",
    "ChildResult",
    "ChildTimeout",
    "LiveRun",
    "Supervisor",
    "SupervisorError",
    "TooManyRuns",
    "json_command",
    "model_command",
    "optimize_command",
    "run_command",
    "tolquane_command",
]
