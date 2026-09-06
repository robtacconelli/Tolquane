"""What Tolquane Web is configured with: the process, the user's preferences, the keys.

Three things, kept apart on purpose:

``AppSettings`` is what this process was started with -- the workspace directory, the
address it listens on, the token it demands, where its database and its key file are.
It is fixed for the life of the server.

``WebSettings`` is what the user edits on the settings page. It lives in the SQLite
store, one JSON value per key, with the defaults of ``docs/web-interfaces.md``. The
three keys that also appear in ``AppSettings`` (``workspace``, ``server.host``,
``server.port``) are what the *next* ``tolquane web`` starts with: this server keeps the
ones it was given, and :func:`startup_settings` reads them back when no flag says
otherwise, so saving them on the settings page is not a change that disappears.

``Keys`` is the API keys, which never go near the database. They live in
``~/.tolquane/web.toml`` (or the file ``TOLQUANE_WEB_CONFIG`` names) written with mode
600, and are read from there or from ``ANTHROPIC_API_KEY`` / ``OPENAI_API_KEY``. Only
whether a key is set is ever reported.
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .store import Store

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})
"""Addresses that are this machine only, and so need no token."""

CONFIG_ENV = "TOLQUANE_WEB_CONFIG"

KEY_NAMES = ("anthropic_key", "openai_key")
KEY_ENV = {"anthropic_key": "ANTHROPIC_API_KEY", "openai_key": "OPENAI_API_KEY"}

RUNTIMES = ("threads", "processes", "sync")


def home_dir() -> Path:
    """Where Tolquane keeps the database and the key file: ``~/.tolquane``.

    ``TOLQUANE_HOME`` moves both, which is how a test, or a machine whose home directory
    is not writable, keeps them somewhere else.
    """
    return Path(os.environ.get("TOLQUANE_HOME") or (Path.home() / ".tolquane"))


def default_config_path() -> Path:
    """The key file: ``$TOLQUANE_WEB_CONFIG`` when set, else ``~/.tolquane/web.toml``."""
    named = os.environ.get(CONFIG_ENV)
    return Path(named).expanduser() if named else home_dir() / "web.toml"


def default_db_path() -> Path:
    """The database: ``~/.tolquane/web.db``."""
    return home_dir() / "web.db"


def packaged_static() -> Path:
    """Where the built frontend lands (gitignored in the tree, shipped in the wheel)."""
    return Path(__file__).resolve().parent / "static"


ProviderFactory = Callable[[str, str | None, str | None], Any]
"""``(provider, model, key) -> Provider``: how the chat route makes a model client."""


@dataclass
class AppSettings:
    """One server's own settings, fixed once it is running.

    ``static_dir`` that does not exist means the frontend was not built: the server then
    answers ``/`` with a line of JSON saying so instead of serving a page. ``clock``,
    ``start_scheduler`` and ``provider_factory`` are seams for tests and for embedders;
    the defaults are the real clock, a running scheduler and the real model providers.
    """

    workspace: Path = field(default_factory=Path.cwd)
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    token: str | None = None
    db_path: Path = field(default_factory=default_db_path)
    config_path: Path = field(default_factory=default_config_path)
    static_dir: Path = field(default_factory=packaged_static)
    start_scheduler: bool = True
    scheduler_interval: float = 1.0
    clock: Callable[[], datetime] | None = None
    provider_factory: ProviderFactory | None = None

    def __post_init__(self) -> None:
        self.workspace = Path(self.workspace).expanduser().resolve()
        self.db_path = Path(self.db_path).expanduser()
        self.config_path = Path(self.config_path).expanduser()
        self.static_dir = Path(self.static_dir).expanduser()

    @property
    def local_only(self) -> bool:
        """Is this server reachable from this machine only?"""
        return self.host in LOOPBACK


def startup_settings(
    *,
    workspace: str | Path | None = None,
    host: str | None = None,
    port: int | None = None,
    token: str | None = None,
    db_path: str | Path | None = None,
    config_path: str | Path | None = None,
) -> AppSettings:
    """The settings ``tolquane web`` starts with: the flags, then what was saved, then
    the defaults. The store is opened and closed again here, before the app exists."""
    database = Path(db_path).expanduser() if db_path else default_db_path()
    saved: dict[str, Any] = {}
    with Store(database) as store:
        saved = store.settings()
    return AppSettings(
        workspace=Path(workspace or saved.get("workspace") or Path.cwd()),
        host=host or str(saved.get("server.host") or DEFAULT_HOST),
        port=int(port or saved.get("server.port") or DEFAULT_PORT),
        token=token,
        db_path=database,
        config_path=Path(config_path).expanduser() if config_path else default_config_path(),
    )


# --------------------------------------------------------------------------- the keys


def _toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return repr(value)
    text = str(value)
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _dump_toml(data: Mapping[str, Any]) -> str:
    """Enough TOML to write back what we read: scalars, then one level of tables."""
    lines = [f"{key} = {_toml_value(value)}" for key, value in data.items() if not _is_table(value)]
    for key, value in data.items():
        if _is_table(value):
            lines.append("")
            lines.append(f"[{key}]")
            lines += [f"{k} = {_toml_value(v)}" for k, v in value.items() if not _is_table(v)]
    return "\n".join(lines).strip() + "\n"


def _is_table(value: Any) -> bool:
    return isinstance(value, Mapping)


class Keys:
    """The API keys, in a file only their owner can read.

    Reads answer from the file first and fall back to the environment, so a key exported
    in a shell needs no setting at all. Writes rewrite the whole file with mode 600,
    keeping anything else that was in it.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser()

    def _document(self) -> dict[str, Any]:
        try:
            with self.path.open("rb") as handle:
                return dict(tomllib.load(handle))
        except (OSError, tomllib.TOMLDecodeError):
            return {}

    def stored(self) -> dict[str, str]:
        """The keys the file holds, by short name."""
        section = self._document().get("ai")
        if not isinstance(section, Mapping):
            return {}
        return {
            name: str(section[name])
            for name in KEY_NAMES
            if isinstance(section.get(name), str) and section[name]
        }

    def get(self, name: str) -> str | None:
        """The key called ``anthropic_key`` or ``openai_key``: the file, then the shell."""
        if name not in KEY_ENV:
            raise ValueError(f"unknown key {name!r}; use one of {', '.join(KEY_NAMES)}")
        stored = self.stored().get(name)
        if stored:
            return stored
        return os.environ.get(KEY_ENV[name]) or None

    def has(self, name: str) -> bool:
        return bool(self.get(name))

    def set(self, name: str, value: str | None) -> None:
        """Store a key, or forget it when ``value`` is empty. The file becomes 600."""
        if name not in KEY_ENV:
            raise ValueError(f"unknown key {name!r}; use one of {', '.join(KEY_NAMES)}")
        text = (value or "").strip()
        if any(char in text for char in "\r\n"):
            raise ValueError(f"{name} cannot contain a line break")
        document = self._document()
        section = dict(document.get("ai") or {}) if _is_table(document.get("ai")) else {}
        if text:
            section[name] = text
        else:
            section.pop(name, None)
        document["ai"] = section
        self._write(document)

    def _write(self, document: Mapping[str, Any]) -> None:
        # The directory too: a key file is no secret if the directory it sits in is not.
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body = "# Tolquane Web settings. Keys live here and nowhere else; do not commit.\n"
        handle = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(body + _dump_toml(document))
        os.chmod(self.path, 0o600)  # an existing file kept its old mode through O_CREAT


# --------------------------------------------------------------------------- the user's


def _one_of(name: str, allowed: tuple[str, ...]) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        if value not in allowed:
            raise ValueError(f"{name} must be one of {', '.join(allowed)}")
        return value

    return check


def _positive_int(name: str, low: int = 1) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, int) or value < low:
            raise ValueError(f"{name} must be a whole number of at least {low}")
        return value

    return check


def _positive_number(name: str, low: float = 0.0) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, int | float) or value < low:
            raise ValueError(f"{name} must be a number of at least {low}")
        return float(value)

    return check


def _text(name: str) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")
        return value.strip()

    return check


def _directory(name: str) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        path = Path(str(value)).expanduser()
        if not path.is_dir():
            raise ValueError(f"{name} must be a directory that exists; {path} is not")
        return str(path.resolve())

    return check


def _port(name: str) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
            raise ValueError(f"{name} must be a port between 1 and 65535")
        return value

    return check


def _model(value: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str):
        raise ValueError("ai.model must be a model id or null")
    return value.strip()


VALIDATORS: dict[str, Callable[[Any], Any]] = {
    "workspace": _directory("workspace"),
    "default_runtime": _one_of("default_runtime", RUNTIMES),
    "default_batch": _positive_int("default_batch"),
    "exec_timeout": _positive_number("exec_timeout", 1.0),
    "max_concurrent_runs": _positive_int("max_concurrent_runs"),
    "max_source_bytes": _positive_int("max_source_bytes", 1024),
    "cancel_grace": _positive_number("cancel_grace"),
    "keep_traces_days": _positive_int("keep_traces_days", 0),
    "theme": _one_of("theme", ("dark", "light", "system")),
    "ai.provider": _text("ai.provider"),
    "ai.model": _model,
    "server.host": _text("server.host"),
    "server.port": _port("server.port"),
}
"""Every setting a client may send, and what it has to be. Anything else is refused, so
a typo is an error the user sees rather than a value nothing reads."""

DEFAULTS: dict[str, Any] = {
    "default_runtime": "threads",
    "default_batch": 32,
    "exec_timeout": 30.0,
    "max_concurrent_runs": 4,
    "max_source_bytes": 2_000_000,
    "cancel_grace": 10.0,
    "keep_traces_days": 7,
    "theme": "dark",
    "ai.provider": "anthropic",
    "ai.model": None,
}


class WebSettings:
    """The settings a user edits, read through the store every time they are asked for.

    Reading on every access is deliberate: the supervisor and the run routes ask for
    ``max_concurrent_runs`` and ``cancel_grace`` while the server runs, and a change on
    the settings page has to take effect without a restart.
    """

    def __init__(self, store: Store, app: AppSettings) -> None:
        self.store = store
        self.app = app
        self.keys = Keys(app.config_path)

    def get(self, key: str) -> Any:
        return self.store.get_setting(key, DEFAULTS.get(key))

    # The values the rest of the server reads --------------------------------

    @property
    def default_runtime(self) -> str:
        return str(self.get("default_runtime"))

    @property
    def default_batch(self) -> int:
        return int(self.get("default_batch"))

    @property
    def exec_timeout(self) -> float:
        return float(self.get("exec_timeout"))

    @property
    def max_concurrent_runs(self) -> int:
        return int(self.get("max_concurrent_runs"))

    @property
    def max_source_bytes(self) -> int:
        """The largest flow the server will write. A paste that big is a mistake."""
        return int(self.get("max_source_bytes"))

    @property
    def cancel_grace(self) -> float:
        return float(self.get("cancel_grace"))

    @property
    def keep_traces_days(self) -> int:
        """How long traces and samples under ``.tolquane-web`` survive a restart."""
        return int(self.get("keep_traces_days"))

    @property
    def ai_provider(self) -> str:
        return str(self.get("ai.provider"))

    @property
    def ai_model(self) -> str | None:
        model = self.get("ai.model")
        return str(model) if model else None

    # The settings page ------------------------------------------------------

    def as_dict(self) -> dict[str, Any]:
        """``GET /api/settings``. Keys are reported as set or not, never echoed."""
        return {
            "workspace": str(self.store.get_setting("workspace") or self.app.workspace),
            "default_runtime": self.default_runtime,
            "default_batch": self.default_batch,
            "exec_timeout": self.exec_timeout,
            "max_concurrent_runs": self.max_concurrent_runs,
            "max_source_bytes": self.max_source_bytes,
            "cancel_grace": self.cancel_grace,
            "keep_traces_days": self.keep_traces_days,
            "theme": str(self.get("theme")),
            "ai": {
                "provider": self.ai_provider,
                "model": self.ai_model,
                "has_anthropic_key": self.keys.has("anthropic_key"),
                "has_openai_key": self.keys.has("openai_key"),
            },
            "server": {
                "host": str(self.store.get_setting("server.host") or self.app.host),
                "port": int(self.store.get_setting("server.port") or self.app.port),
                "token_set": bool(self.app.token),
            },
        }

    def update(self, patch: Mapping[str, Any]) -> None:
        """Apply ``PUT /api/settings``: flat or nested, keys to the file, rest to the
        store. Nothing is written until every value has been checked."""
        flat = _flatten(patch)
        secrets = {name: flat.pop(f"ai.{name}") for name in KEY_NAMES if f"ai.{name}" in flat}
        unknown = sorted(set(flat) - set(VALIDATORS))
        if unknown:
            raise ValueError(
                f"unknown setting(s) {', '.join(unknown)}; the settings are "
                f"{', '.join(sorted(VALIDATORS))}, ai.anthropic_key and ai.openai_key"
            )
        checked = {key: VALIDATORS[key](value) for key, value in flat.items()}
        for name, value in secrets.items():
            if value is not None and not isinstance(value, str):
                raise ValueError(f"ai.{name} must be a string, or null to forget it")
        for key, value in checked.items():
            self.store.set_setting(key, value)
        for name, value in secrets.items():
            self.keys.set(name, None if value is None else str(value))


def _flatten(patch: Mapping[str, Any], prefix: str = "") -> dict[str, Any]:
    """``{"ai": {"model": "x"}}`` and ``{"ai.model": "x"}`` are the same request."""
    out: dict[str, Any] = {}
    for key, value in patch.items():
        name = f"{prefix}{key}"
        if isinstance(value, Mapping):
            out.update(_flatten(value, f"{name}."))
        else:
            out[name] = value
    return out


__all__ = [
    "AppSettings",
    "Keys",
    "WebSettings",
    "default_config_path",
    "default_db_path",
    "packaged_static",
    "startup_settings",
]
