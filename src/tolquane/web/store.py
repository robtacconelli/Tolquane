"""SQLite storage for Tolquane Web: runs, schedules and settings.

One database file, ``~/.tolquane/web.db`` by default, holds the history of runs, the
schedules the scheduler fires and every setting that is not a secret. The file is opened
once and shared by every thread of the server behind a lock, in WAL mode so a reader
never waits for a writer.

API keys never come here. ``set_setting`` refuses any key whose name ends in ``_key`` or
``_secret``: those belong in the Tolquane Web settings file, which is written with
owner-only permissions, or in the environment.

Users live here too, from 1.3: a name, a role and a scrypt hash of a password, with the
sessions and API tokens made from them. A password is never stored and a token is never
stored: what the ``sessions`` table holds is the SHA-256 of a token, so a stolen database
is not a set of keys to the server.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, NamedTuple

LOG_LIMIT = 64 * 1024
"""How much of a run's log is kept, in bytes: the tail, so the end of a failure survives."""

RUN_STATUSES = ("running", "done", "failed", "cancelled", "deadlock")

SECRET_SUFFIXES = ("_key", "_secret")

LOCAL_USER = "local"
"""The name a run or a schedule carries when nobody signed in: local mode, and every row
written before there were users."""

ROLES = ("admin", "member")

SESSION_KINDS = ("session", "api")

SESSION_DAYS = 30
"""How long a browser session lives without being used. Every use slides it forward."""

MIN_PASSWORD = 8
"""The contract's one password rule. Length is the only thing worth insisting on."""

NAME_PATTERN = re.compile(r"^[a-z0-9_.-]{2,32}$")
"""What a user may be called: lower case, no spaces, nothing a URL has to escape."""

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_SALT_BYTES = 16
SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2
"""``hashlib.scrypt`` needs ``128 * n * r`` bytes; ask for twice that, because OpenSSL's
own default (32 MB) is too near the 16 MB these parameters want to be relied on."""

_SCHEDULE_FIELDS = (
    "flow",
    "cron",
    "sample",
    "runtime",
    "enabled",
    "last_run",
    "last_status",
    "next_run",
    "user",
)

_USER_FIELDS = ("role", "disabled", "must_change_password", "password")


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
    user: str = LOCAL_USER

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
    user: str = LOCAL_USER

    def to_dict(self) -> dict[str, Any]:
        """The schedule as JSON-ready data, exactly the shape the server returns."""
        return asdict(self)


@dataclass(frozen=True)
class User:
    """Somebody who may sign in. ``password_hash`` never leaves this module's callers."""

    id: int
    name: str
    role: str
    created: str
    disabled: bool
    must_change_password: bool
    password_hash: str = ""
    last_seen: str | None = None
    """The newest ``last_seen`` of any of this user's sessions, filled in by every read."""

    def to_dict(self) -> dict[str, Any]:
        """The user as the API returns them: everything but the hash."""
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "created": self.created,
            "disabled": self.disabled,
            "must_change_password": self.must_change_password,
            "last_seen": self.last_seen,
        }


@dataclass(frozen=True)
class Session:
    """One way in: a browser session that slides, or an API token that does not expire."""

    id: int
    user_id: int
    kind: str
    label: str
    created: str
    expires: str | None
    last_seen: str | None

    def to_dict(self) -> dict[str, Any]:
        """What ``GET /api/auth/tokens`` shows: never the token, which is not stored."""
        return {
            "id": self.id,
            "label": self.label,
            "created": self.created,
            "last_seen": self.last_seen,
        }


@dataclass(frozen=True)
class Identity:
    """What a token resolved to: the session it named and the user it belongs to."""

    session: Session
    user: User


class NewToken(NamedTuple):
    """A token as it is issued: the plain text once, and the row that will outlive it."""

    token: str
    session: Session


# ------------------------------------------------------------------------- passwords


def check_name(name: str) -> str:
    """The name as it will be stored, or ``ValueError`` saying what a name may be."""
    cleaned = (name or "").strip().lower()
    if not NAME_PATTERN.match(cleaned):
        raise ValueError(
            f"{name!r} is not a user name: two to thirty-two characters of "
            "lower-case letters, digits, '_', '.' or '-'"
        )
    return cleaned


def check_password(password: str) -> str:
    """``ValueError`` unless the password is long enough. The one rule of the contract."""
    if len(password or "") < MIN_PASSWORD:
        raise ValueError(f"a password needs at least {MIN_PASSWORD} characters")
    return password


def check_role(role: str) -> str:
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}; use one of {', '.join(ROLES)}")
    return role


def _scrypt(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        maxmem=SCRYPT_MAXMEM,
    )


def hash_password(password: str) -> str:
    """``scrypt$<salt b64>$<hash b64>``, with a salt of this password's own."""
    salt = secrets.token_bytes(SCRYPT_SALT_BYTES)
    digest = _scrypt(password, salt)
    return f"scrypt${_b64(salt)}${_b64(digest)}"


def verify_password(stored: str | None, password: str) -> bool:
    """Is this the password behind that hash?

    A name nobody has, a row without a hash and a wrong password all take the same road:
    one scrypt of the same cost, then one ``hmac.compare_digest``. What the answer costs
    says nothing about which of the three it was.
    """
    salt, expected = _parts(stored)
    digest = _scrypt(password or "", salt)
    return hmac.compare_digest(digest, expected)


def _parts(stored: str | None) -> tuple[bytes, bytes]:
    """The salt and the hash of a stored password, or a decoy that nothing can match."""
    decoy = (b"\x00" * SCRYPT_SALT_BYTES, secrets.token_bytes(32))
    if not stored:
        return decoy
    kind, _, rest = stored.partition("$")
    encoded_salt, _, encoded_hash = rest.partition("$")
    if kind != "scrypt" or not encoded_salt or not encoded_hash:
        return decoy
    try:
        return base64.b64decode(encoded_salt), base64.b64decode(encoded_hash)
    except ValueError:  # pragma: no cover - a hash edited by hand
        return decoy


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def token_hash(token: str) -> str:
    """What the ``sessions`` table holds instead of the token itself."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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


def _migration_2(conn: sqlite3.Connection) -> None:
    """1.3: users, the sessions and API tokens made from them, and who started what."""
    for statement in (
        """CREATE TABLE users (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            name                 TEXT    NOT NULL UNIQUE,
            role                 TEXT    NOT NULL DEFAULT 'member',
            password_hash        TEXT    NOT NULL,
            created              TEXT    NOT NULL,
            disabled             INTEGER NOT NULL DEFAULT 0,
            must_change_password INTEGER NOT NULL DEFAULT 0
        )""",
        """CREATE TABLE sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT    NOT NULL UNIQUE,
            user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            kind       TEXT    NOT NULL DEFAULT 'session',
            label      TEXT    NOT NULL DEFAULT '',
            created    TEXT    NOT NULL,
            expires    TEXT,
            last_seen  TEXT
        )""",
        "CREATE INDEX sessions_user ON sessions (user_id)",
        # Everything that ran before there were users ran as the local owner of the machine.
        f"ALTER TABLE runs ADD COLUMN \"user\" TEXT NOT NULL DEFAULT '{LOCAL_USER}'",
        f"ALTER TABLE schedules ADD COLUMN \"user\" TEXT NOT NULL DEFAULT '{LOCAL_USER}'",
    ):
        conn.execute(statement)


_MIGRATIONS: list[Callable[[sqlite3.Connection], None]] = [_migration_1, _migration_2]
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

    def __init__(self, path: str | Path, *, clock: Callable[[], datetime] | None = None) -> None:
        self.path = str(path)
        # A test that has to watch a session expire needs to move time; nothing else does.
        self._clock = clock
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

    def moment(self) -> datetime:
        """Now, as an aware UTC datetime: the clock this store was given, or the real one."""
        if self._clock is None:
            return datetime.now(UTC)
        value = self._clock()
        return (value if value.tzinfo is not None else value.astimezone()).astimezone(UTC)

    def now(self) -> str:
        """Now, as the UTC ISO string every timestamp column holds."""
        return self.moment().isoformat(timespec="microseconds")

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
        user: str = LOCAL_USER,
    ) -> Run:
        """Record a run that has just started. ``trigger`` is ``"manual"``, ``"api"`` or
        ``"schedule:<id>"``; ``user`` is the name of whoever asked for it."""
        started = self.now()
        with self._lock:
            cur = self._conn.execute(
                'INSERT INTO runs (flow, runtime, sample, "trigger", started, status, log, "user")'
                " VALUES (?, ?, ?, ?, ?, 'running', '', ?)",
                (flow, runtime, sample, trigger, started, user),
            )
            run_id = int(cur.lastrowid or 0)
            return self._require_run(run_id)

    def set_run_user(self, run_id: int, user: str) -> Run:
        """Say who a run belongs to. The supervisor records the run; the server, which is
        the only part that knows who is calling, names the user right afterwards."""
        with self._lock:
            if self.get_run(run_id) is None:
                raise ValueError(f"no run {run_id}")
            self._conn.execute('UPDATE runs SET "user" = ? WHERE id = ?', (user, run_id))
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
                    self.now(),
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
        user: str = LOCAL_USER,
    ) -> Schedule:
        """Add a schedule. ``next_run`` starts empty; the scheduler fills it in on its
        next pass, which is also what recomputes it when the cron changes."""
        with self._lock:
            cur = self._conn.execute(
                'INSERT INTO schedules (flow, cron, sample, runtime, enabled, created, "user")'
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (flow, cron, sample, runtime, int(enabled), self.now(), user),
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
        assignments = ", ".join(f'"{name}" = ?' for name in fields)
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

    # Users ---------------------------------------------------------------

    def add_user(
        self,
        name: str,
        password: str,
        role: str = "member",
        must_change_password: bool = True,
    ) -> User:
        """Make a user. The name is lower-cased and checked, the password hashed here and
        never kept. A name already taken is a ``ValueError`` saying so."""
        cleaned = check_name(name)
        check_password(password)
        check_role(role)
        digest = hash_password(password)
        with self._lock:
            if self.get_user_by_name(cleaned) is not None:
                raise ValueError(f"there is already a user called {cleaned!r}")
            cur = self._conn.execute(
                "INSERT INTO users (name, role, password_hash, created, disabled,"
                " must_change_password) VALUES (?, ?, ?, ?, 0, ?)",
                (cleaned, role, digest, self.now(), int(must_change_password)),
            )
            return self._require_user(int(cur.lastrowid or 0))

    def get_user(self, user_id: int) -> User | None:
        """The user with this id, or ``None``."""
        with self._lock:
            row = self._conn.execute(f"{_USER_SELECT} WHERE id = ?", (user_id,)).fetchone()
        return _user_of(row) if row is not None else None

    def get_user_by_name(self, name: str) -> User | None:
        """The user with this name, or ``None``. The name is matched as it is stored."""
        cleaned = (name or "").strip().lower()
        with self._lock:
            row = self._conn.execute(f"{_USER_SELECT} WHERE name = ?", (cleaned,)).fetchone()
        return _user_of(row) if row is not None else None

    def list_users(self) -> list[User]:
        """Every user, by name."""
        with self._lock:
            rows = self._conn.execute(f"{_USER_SELECT} ORDER BY name").fetchall()
        return [_user_of(row) for row in rows]

    def count_users(self) -> int:
        """How many users there are: what tells local mode from users mode."""
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        return int(row["n"])

    def enabled_admins(self) -> list[User]:
        """The admins who can still sign in. The last of them cannot be taken away."""
        return [user for user in self.list_users() if user.role == "admin" and not user.disabled]

    def update_user(self, user_id: int, **fields: Any) -> User:
        """Change any of ``role, disabled, must_change_password, password``.

        ``password`` is hashed here and stored under ``password_hash``; sessions are left
        alone, so changing your own password does not sign you out of the browser you
        changed it in. Disabling a user is what stops their sessions, at once.
        """
        unknown = set(fields) - set(_USER_FIELDS)
        if unknown:
            raise ValueError(
                f"unknown user field(s) {', '.join(sorted(unknown))}; "
                f"settable fields are {', '.join(_USER_FIELDS)}"
            )
        if not fields:
            raise ValueError("update_user needs at least one field")
        columns: dict[str, Any] = {}
        if "password" in fields:
            password = str(fields.pop("password"))
            check_password(password)
            columns["password_hash"] = hash_password(password)
        if "role" in fields:
            columns["role"] = check_role(str(fields["role"]))
        if "disabled" in fields:
            columns["disabled"] = int(bool(fields["disabled"]))
        if "must_change_password" in fields:
            columns["must_change_password"] = int(bool(fields["must_change_password"]))
        assignments = ", ".join(f"{name} = ?" for name in columns)
        with self._lock:
            if self.get_user(user_id) is None:
                raise ValueError(f"no user {user_id}")
            self._conn.execute(
                f"UPDATE users SET {assignments} WHERE id = ?", [*columns.values(), user_id]
            )
            return self._require_user(user_id)

    def delete_user(self, user_id: int) -> None:
        """Remove a user and, with them, every session and token they had. Deleting one
        who is not there is not an error."""
        with self._lock:
            self._conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            self._conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def _require_user(self, user_id: int) -> User:
        user = self.get_user(user_id)
        if user is None:  # pragma: no cover - the row was just written under the lock
            raise ValueError(f"no user {user_id}")
        return user

    # Sessions and tokens -------------------------------------------------

    def create_session(self, user_id: int, kind: str = "session", label: str = "") -> NewToken:
        """Issue a token for this user and return it in the clear, once.

        Only its SHA-256 is stored, so this is the one moment the token exists anywhere
        but in the caller's hands. A ``session`` expires thirty days after its last use;
        an ``api`` token does not expire, and is forgotten by being deleted.
        """
        if kind not in SESSION_KINDS:
            kinds = ", ".join(SESSION_KINDS)
            raise ValueError(f"unknown session kind {kind!r}; use one of {kinds}")
        token = secrets.token_urlsafe(32)
        moment = self.moment()
        created = moment.isoformat(timespec="microseconds")
        expires = _iso(moment + timedelta(days=SESSION_DAYS)) if kind == "session" else None
        with self._lock:
            if self.get_user(user_id) is None:
                raise ValueError(f"no user {user_id}")
            cur = self._conn.execute(
                "INSERT INTO sessions (token_hash, user_id, kind, label, created, expires,"
                " last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (token_hash(token), user_id, kind, label, created, expires, created),
            )
            session = self.get_session(int(cur.lastrowid or 0))
        assert session is not None  # written under the lock a line ago
        return NewToken(token=token, session=session)

    def resolve_token(self, token: str) -> Identity | None:
        """Who is holding this token, or ``None``.

        ``None`` covers every way a token can fail: unknown, expired, or belonging to a
        user who has been disabled. A session that answers slides its expiry another
        thirty days and records that it was seen; an expired row is deleted on the way.
        """
        if not token:
            return None
        moment = self.moment()
        now = moment.isoformat(timespec="microseconds")
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sessions WHERE token_hash = ?", (token_hash(token),)
            ).fetchone()
            if row is None:
                return None
            session = _session_of(row)
            if _before(now, session.expires):
                self._conn.execute("DELETE FROM sessions WHERE id = ?", (session.id,))
                return None
            user = self.get_user(session.user_id)
            if user is None or user.disabled:
                return None
            expires = (
                _iso(moment + timedelta(days=SESSION_DAYS)) if session.kind == "session" else None
            )
            self._conn.execute(
                "UPDATE sessions SET last_seen = ?, expires = ? WHERE id = ?",
                (now, expires, session.id),
            )
        return Identity(session=replace(session, last_seen=now, expires=expires), user=user)

    def get_session(self, session_id: int) -> Session | None:
        """The session with this id, or ``None``. The token itself is not in it."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        return _session_of(row) if row is not None else None

    def delete_session(self, session_id: int) -> None:
        """Sign one session out, or take one API token back."""
        with self._lock:
            self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def list_api_tokens(self, user_id: int) -> list[Session]:
        """This user's API tokens, oldest first. Browser sessions are not shown here."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM sessions WHERE user_id = ? AND kind = 'api' ORDER BY id",
                (user_id,),
            ).fetchall()
        return [_session_of(row) for row in rows]

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
        user=str(row["user"]),
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
        user=str(row["user"]),
    )


_USER_SELECT = (
    "SELECT users.*, (SELECT MAX(last_seen) FROM sessions WHERE sessions.user_id = users.id)"
    " AS last_seen FROM users"
)
"""Every read of a user answers with when they were last seen, which is the newest of
their sessions: the users table itself holds nothing that a request changes."""


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="microseconds")


def _user_of(row: sqlite3.Row) -> User:
    return User(
        id=int(row["id"]),
        name=str(row["name"]),
        role=str(row["role"]),
        created=str(row["created"]),
        disabled=bool(row["disabled"]),
        must_change_password=bool(row["must_change_password"]),
        password_hash=str(row["password_hash"]),
        last_seen=row["last_seen"],
    )


def _session_of(row: sqlite3.Row) -> Session:
    return Session(
        id=int(row["id"]),
        user_id=int(row["user_id"]),
        kind=str(row["kind"]),
        label=str(row["label"]),
        created=str(row["created"]),
        expires=row["expires"],
        last_seen=row["last_seen"],
    )


def _before(moment: str, deadline: str | None) -> bool:
    """Is ``moment`` past ``deadline``? Both are ISO strings this module wrote."""
    if deadline is None:
        return False
    try:
        return datetime.fromisoformat(deadline) <= datetime.fromisoformat(moment)
    except ValueError:  # pragma: no cover - a timestamp edited by hand
        return True
