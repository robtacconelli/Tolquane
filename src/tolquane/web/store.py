"""SQLite storage for Tolquane Web: runs, schedules and settings.

One database file, ``~/.tolquane/web.db`` by default, holds the history of runs, the
schedules the scheduler fires and every setting that is not a secret. The file is opened
once and shared by every thread of the server behind a lock, in WAL mode so a reader
never waits for a writer.

API keys never come here. ``set_setting`` refuses any key whose name ends in ``_key`` or
``_secret``: those belong in the Tolquane Web settings file, which is written with
owner-only permissions, or in the environment.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LOG_LIMIT = 64 * 1024
"""How much of a run's log is kept, in bytes: the tail, so the end of a failure survives."""

RUN_STATUSES = ("running", "done", "failed", "cancelled", "deadlock")

SECRET_SUFFIXES = ("_key", "_secret")

_SCHEDULE_FIELDS = (
    "flow",
    "cron",
    "sample",
    "runtime",
    "enabled",
    "last_run",
    "last_status",
    "next_run",
)


def utc_now() -> str:
    """The current instant as the UTC ISO 8601 string every timestamp column holds."""
    return datetime.now(UTC).isoformat(timespec="microseconds")


def _as_iso(value: Any) -> str | None:
    """Accept a timestamp as ``None``, an ISO string, or an aware datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("timestamps must be timezone-aware datetimes or ISO strings")
        return value.astimezone(UTC).isoformat(timespec="microseconds")
    if isinstance(value, str):
        return value
    raise ValueError(f"expected a datetime, an ISO string or None, got {type(value).__name__}")


def _trim_log(text: str) -> str:
    """Keep the last :data:`LOG_LIMIT` bytes. A character cut in half at the front is
    dropped rather than shown as a replacement mark."""
    data = text.encode("utf-8", "replace")
    if len(data) <= LOG_LIMIT:
        return text
    return data[-LOG_LIMIT:].decode("utf-8", "ignore")


@dataclass(frozen=True)
class Run:
    """One execution of a flow, from the moment it was started to whatever ended it."""

    id: int
    flow: str
    runtime: str
    sample: str | None
    trigger: str
    started: str
    ended: str | None
    status: str
    report: dict[str, Any] | None
    log: str
    trace_path: str | None
    error: str | None

    def to_dict(self) -> dict[str, Any]:
        """The run as JSON-ready data, exactly the shape the server returns."""
        return asdict(self)


@dataclass(frozen=True)
class Schedule:
    """A flow to run on a cron expression, with the last result and the next time."""

    id: int
    flow: str
    cron: str
    sample: str | None
    runtime: str
    enabled: bool
    created: str
    last_run: int | None
    last_status: str | None
    next_run: str | None

    def to_dict(self) -> dict[str, Any]:
        """The schedule as JSON-ready data, exactly the shape the server returns."""
        return asdict(self)


def _migration_1(conn: sqlite3.Connection) -> None:
    """The first schema: runs, schedules, settings."""
    # One statement per execute: executescript would commit the migration's transaction.
    for statement in (
        """CREATE TABLE runs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            flow       TEXT    NOT NULL,
            runtime    TEXT    NOT NULL,
            sample     TEXT,
            "trigger"  TEXT    NOT NULL,
            started    TEXT    NOT NULL,
            ended      TEXT,
            status     TEXT    NOT NULL,
            report     TEXT,
            log        TEXT    NOT NULL DEFAULT '',
            trace_path TEXT,
            error      TEXT
        )""",
        "CREATE INDEX runs_flow ON runs (flow, id DESC)",
        """CREATE TABLE schedules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            flow        TEXT    NOT NULL,
            cron        TEXT    NOT NULL,
            sample      TEXT,
            runtime     TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created     TEXT    NOT NULL,
            last_run    INTEGER,
            last_status TEXT,
            next_run    TEXT
        )""",
        "CREATE INDEX schedules_flow ON schedules (flow)",
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ):
        conn.execute(statement)


_MIGRATIONS: list[Callable[[sqlite3.Connection], None]] = [_migration_1]
"""Steps from one schema version to the next. Migration ``i`` takes version ``i`` to
``i + 1``, so adding a column is appending a function that runs ``ALTER TABLE``; never
edit a step that has shipped."""


def schema_version() -> int:
    """The version a database is brought to when it is opened."""
    return len(_MIGRATIONS)


def migrate(conn: sqlite3.Connection) -> int:
    """Bring ``conn`` up to :func:`schema_version` and return it.

    An empty file is version 0, and so is a file that has only the ``schema_version``
    table: both run every step. The whole upgrade is one transaction, because SQLite
    can roll back schema changes.
    """
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT version FROM schema_version").fetchone()
    version = int(row[0]) if row is not None else 0
    target = schema_version()
    if version > target:
        raise ValueError(
            f"database is schema version {version}, newer than this Tolquane ({target}); "
            "upgrade Tolquane or point it at another file"
        )
    conn.execute("BEGIN IMMEDIATE")
    try:
        for step in _MIGRATIONS[version:]:
            step(conn)
        if row is None:
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (target,))
        elif version != target:
            conn.execute("UPDATE schema_version SET version = ?", (target,))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return target


class Store:
    """The Tolquane Web database: runs, schedules and settings.

    One connection is shared by every caller and guarded by a re-entrant lock, so any
    thread may use the same ``Store``; SQLite itself is in WAL mode with a busy timeout,
    which is what a second process (a stray ``tolquane web``) needs to not fail outright.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        if self.path != ":memory:":
            parent = Path(self.path).expanduser().resolve().parent
            parent.mkdir(parents=True, exist_ok=True)
            self.path = str(Path(self.path).expanduser())
        self._lock = threading.RLock()
        # isolation_level=None: every statement commits on its own, and the multi-step
        # migration says BEGIN itself. The lock, not sqlite3, serialises our writers.
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self.version = migrate(self._conn)

    def close(self) -> None:
        """Close the connection. The store is unusable afterwards."""
        with self._lock:
            self._conn.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # Runs ---------------------------------------------------------------

    def add_run(
        self,
        flow: str,
        runtime: str,
        sample: str | None = None,
        trigger: str = "manual",
    ) -> Run:
        """Record a run that has just started. ``trigger`` is ``"manual"``, ``"api"`` or
        ``"schedule:<id>"``."""
        started = utc_now()
        with self._lock:
            cur = self._conn.execute(
                'INSERT INTO runs (flow, runtime, sample, "trigger", started, status, log)'
                " VALUES (?, ?, ?, ?, ?, 'running', '')",
                (flow, runtime, sample, trigger, started),
            )
            run_id = int(cur.lastrowid or 0)
            return self._require_run(run_id)

    def finish_run(
        self,
        run_id: int,
        status: str,
        report: dict[str, Any] | None = None,
        log: str = "",
        trace_path: str | None = None,
        error: str | None = None,
    ) -> Run:
        """Close a run: its status, the report as data, the tail of its log, where the
        trace file is and what went wrong. Returns the run as stored."""
        if status not in RUN_STATUSES:
            raise ValueError(f"unknown run status {status!r}; use one of {', '.join(RUN_STATUSES)}")
        with self._lock:
            if self.get_run(run_id) is None:
                raise ValueError(f"no run {run_id}")
            self._conn.execute(
                "UPDATE runs SET ended = ?, status = ?, report = ?, log = ?, trace_path = ?,"
                " error = ? WHERE id = ?",
                (
                    utc_now(),
                    status,
                    json.dumps(report) if report is not None else None,
                    _trim_log(log),
                    trace_path,
                    error,
                    run_id,
                ),
            )
            return self._require_run(run_id)

    def get_run(self, run_id: int) -> Run | None:
        """The run with this id, or ``None``."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return _run_of(row) if row is not None else None

    def list_runs(self, flow: str | None = None, limit: int = 50) -> list[Run]:
        """Runs, newest first, of one flow or of all of them."""
        sql = "SELECT * FROM runs"
        args: list[Any] = []
        if flow is not None:
            sql += " WHERE flow = ?"
            args.append(flow)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [_run_of(row) for row in rows]

    def _require_run(self, run_id: int) -> Run:
        run = self.get_run(run_id)
        if run is None:  # pragma: no cover - the row was just written under the lock
            raise ValueError(f"no run {run_id}")
        return run

    # Schedules ----------------------------------------------------------

    def add_schedule(
        self,
        flow: str,
        cron: str,
        sample: str | None = None,
        runtime: str = "threads",
        enabled: bool = True,
    ) -> Schedule:
        """Add a schedule. ``next_run`` starts empty; the scheduler fills it in on its
        next pass, which is also what recomputes it when the cron changes."""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO schedules (flow, cron, sample, runtime, enabled, created)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (flow, cron, sample, runtime, int(enabled), utc_now()),
            )
            return self._require_schedule(int(cur.lastrowid or 0))

    def update_schedule(self, schedule_id: int, **fields: Any) -> Schedule:
        """Change any of ``flow, cron, sample, runtime, enabled, last_run, last_status,
        next_run``. A new ``cron`` clears ``next_run`` unless one is given, so the old
        time cannot outlive the expression that produced it."""
        unknown = set(fields) - set(_SCHEDULE_FIELDS)
        if unknown:
            raise ValueError(
                f"unknown schedule field(s) {', '.join(sorted(unknown))}; "
                f"settable fields are {', '.join(_SCHEDULE_FIELDS)}"
            )
        if not fields:
            raise ValueError("update_schedule needs at least one field")
        if "cron" in fields and "next_run" not in fields:
            fields["next_run"] = None
        values = [_schedule_value(name, fields[name]) for name in fields]
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._lock:
            if self.get_schedule(schedule_id) is None:
                raise ValueError(f"no schedule {schedule_id}")
            self._conn.execute(
                f"UPDATE schedules SET {assignments} WHERE id = ?", [*values, schedule_id]
            )
            return self._require_schedule(schedule_id)

    def delete_schedule(self, schedule_id: int) -> None:
        """Remove a schedule. Deleting one that is not there is not an error."""
        with self._lock:
            self._conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))

    def get_schedule(self, schedule_id: int) -> Schedule | None:
        """The schedule with this id, or ``None``."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM schedules WHERE id = ?", (schedule_id,)
            ).fetchone()
        return _schedule_of(row) if row is not None else None

    def list_schedules(self, flow: str | None = None) -> list[Schedule]:
        """Schedules in the order they were added, of one flow or of all of them."""
        sql = "SELECT * FROM schedules"
        args: list[Any] = []
        if flow is not None:
            sql += " WHERE flow = ?"
            args.append(flow)
        sql += " ORDER BY id"
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [_schedule_of(row) for row in rows]

    def _require_schedule(self, schedule_id: int) -> Schedule:
        schedule = self.get_schedule(schedule_id)
        if schedule is None:  # pragma: no cover - the row was just written under the lock
            raise ValueError(f"no schedule {schedule_id}")
        return schedule

    # Settings -----------------------------------------------------------

    def get_setting(self, key: str, default: Any = None) -> Any:
        """The value stored under ``key``, decoded from JSON, or ``default``."""
        with self._lock:
            row = self._conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        return json.loads(str(row["value"]))

    def set_setting(self, key: str, value: Any) -> None:
        """Store a JSON value. Secrets are refused: see the module docstring."""
        check_setting_key(key)
        with self._lock:
            self._conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    def delete_setting(self, key: str) -> None:
        """Forget a setting, so its default applies again."""
        with self._lock:
            self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))

    def settings(self) -> dict[str, Any]:
        """Every setting, decoded."""
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM settings ORDER BY key").fetchall()
        return {str(row["key"]): json.loads(str(row["value"])) for row in rows}


def check_setting_key(key: str, suffixes: Iterable[str] = SECRET_SUFFIXES) -> None:
    """Raise ``ValueError`` if ``key`` names a secret. Called by ``set_setting``; the
    server calls it too, before it has a store."""
    lowered = key.lower()
    if any(lowered.endswith(suffix) for suffix in suffixes):
        raise ValueError(
            f"refusing to store {key!r}: API keys and secrets never go in the database. "
            "Put them in the Tolquane Web settings file (~/.tolquane/web.toml, owner-only "
            "permissions) or in the environment."
        )


def _schedule_value(name: str, value: Any) -> Any:
    if name == "enabled":
        return int(bool(value))
    if name == "next_run":
        return _as_iso(value)
    if name == "last_run" and value is not None:
        return int(value)
    return value


def _run_of(row: sqlite3.Row) -> Run:
    report = row["report"]
    return Run(
        id=int(row["id"]),
        flow=str(row["flow"]),
        runtime=str(row["runtime"]),
        sample=row["sample"],
        trigger=str(row["trigger"]),
        started=str(row["started"]),
        ended=row["ended"],
        status=str(row["status"]),
        report=json.loads(str(report)) if report is not None else None,
        log=str(row["log"]),
        trace_path=row["trace_path"],
        error=row["error"],
    )


def _schedule_of(row: sqlite3.Row) -> Schedule:
    return Schedule(
        id=int(row["id"]),
        flow=str(row["flow"]),
        cron=str(row["cron"]),
        sample=row["sample"],
        runtime=str(row["runtime"]),
        enabled=bool(row["enabled"]),
        created=str(row["created"]),
        last_run=row["last_run"],
        last_status=row["last_status"],
        next_run=row["next_run"],
    )
