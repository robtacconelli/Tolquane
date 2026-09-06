"""The Tolquane Web server: one FastAPI app over the workspace, the runs and the model.

``create_app(settings)`` builds everything: the store, the run supervisor, the scheduler
and every route of ``docs/web-interfaces.md`` under ``/api``. The built frontend, when
there is one, is served at ``/`` with the fallback a single-page app needs; when there
is none the same address answers with a line of JSON saying how to build it.

Three rules shape the code:

* **User code never runs here.** Parsing, checking, drawing, optimizing and running all
  happen in child processes (``tolquane.web.supervisor``), so a flow that hangs or
  crashes costs a process and not the server.
* **The workspace is a fence.** Every path a client sends is resolved inside it;
  ``..``, an absolute path and a symlink that leads out are all 400.
* **The OpenAPI document is the contract.** The frontend's client is generated from
  ``/api/openapi.json``, so every route carries an ``operation_id`` that reads like a
  method name and a response model that says what comes back.

Who is calling is worked out once, in :class:`Auth`, and what they may do is one table,
:data:`ROUTE_ROLES`. Both are read twice: by :class:`TokenWall`, one layer outside the
routes, where the paths FastAPI adds for itself and the paths that match nothing are
also covered, and by the dependency every route carries. Neither is the only one.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import logging
import re
import shutil
import threading
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import parse_qs

from fastapi import Body, Depends, FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect

import tolquane as tq

from ..errors import TolquaneError
from . import model as flow_model
from .cron import Cron
from .scheduler import Scheduler, local_now
from .settings import AppSettings, WebSettings
from .store import LOCAL_USER, Run, Schedule, Store, User, verify_password
from .supervisor import (
    WORK_DIR,
    ChildFailed,
    ChildTimeout,
    Supervisor,
    TooManyRuns,
    model_command,
    optimize_command,
    tolquane_command,
)

log = logging.getLogger(__name__)

SKIP_DIRS = frozenset({"__pycache__", "node_modules", ".git", ".venv", "venv", WORK_DIR})
"""Directories the flow listing walks past: nothing a person wrote lives in them."""

TEMPLATES: dict[str, str] = {
    "empty": '''"""{name}."""

import tolquane as tq


@tq.source
def items():
    """Yield the items to work on."""
    yield from range(10)


@tq.sink
def show(item):
    """Do something with one result."""
    print(item)


def build(source=None):
    start = items if source is None else tq.from_iterable(source)
    return start >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
''',
    "hello": '''"""{name}: double every number with a farm of four workers."""

import tolquane as tq


@tq.source
def numbers():
    """Yield the numbers 1 to 20."""
    yield from range(1, 21)


@tq.node
def double(x):
    """Double one number."""
    return x * 2


@tq.sink
def show(x):
    """Print one result."""
    print(x)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.farm(double, 4) >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
''',
}


class ApiError(Exception):
    """An answer that is not a success: the status, and the shape the contract asks for."""

    def __init__(self, status: int, kind: str, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.kind = kind
        self.message = message
        self.detail = detail

    def body(self) -> dict[str, Any]:
        return {"error": {"type": self.kind, "message": self.message, "detail": self.detail}}


def not_found(what: str) -> ApiError:
    return ApiError(404, "NotFound", what)


def bad_request(message: str, detail: Any = None) -> ApiError:
    return ApiError(400, "BadRequest", message, detail)


# --------------------------------------------------------------------------- the shapes


class Ok(BaseModel):
    ok: bool = True


class FlowSummary(BaseModel):
    path: str
    name: str
    modified: str
    size: int
    has_layout: bool
    last_run: dict[str, Any] | None = None


class FlowList(BaseModel):
    workspace: str
    flows: list[FlowSummary]


class FlowDetail(BaseModel):
    path: str
    source: str
    modified: str
    model: dict[str, Any] | None = None
    code_only: dict[str, Any] | None = None
    graph: dict[str, Any] | None = None
    layout: dict[str, Any] | None = None


class NewFlow(BaseModel):
    path: str
    template: str | dict[str, Any] = "empty"


class SaveFlow(BaseModel):
    source: str
    modified: str | None = Field(
        default=None, description="the `modified` you were given; a mismatch answers 409"
    )


class RenameFlow(BaseModel):
    path: str


class ParseRequest(BaseModel):
    source: str
    name: str = "flow"


class ParseResult(BaseModel):
    model: dict[str, Any] | None = None
    code_only: dict[str, Any] | None = None
    graph: dict[str, Any] | None = None


class GenerateRequest(BaseModel):
    model: dict[str, Any]


class GenerateResult(BaseModel):
    source: str


class CheckResult(BaseModel):
    ok: bool
    nodes: int
    edges: int


class ExplainResult(BaseModel):
    text: str


class DrawResult(BaseModel):
    mermaid: str


class OptimizeRequest(BaseModel):
    all2all: bool = False


class OptimizeResult(BaseModel):
    source: str | None = Field(
        default=None,
        description="the rewrite has no Python form yet; run with optimize=true instead",
    )
    notes: list[str]
    graph: dict[str, Any] | None = None


class RunModel(BaseModel):
    id: int
    flow: str
    runtime: str
    sample: str | None = None
    trigger: str
    user: str = LOCAL_USER
    started: str
    ended: str | None = None
    status: str
    report: dict[str, Any] | None = None
    log: str = ""
    trace_path: str | None = None
    error: str | None = None
    live: bool = False


class RunList(BaseModel):
    runs: list[RunModel]


class StartRun(BaseModel):
    path: str
    runtime: str | None = None
    sample: str | None = None
    batch: int | None = None
    tap: int = 0
    trace: bool = False
    optimize: bool = False


class ScheduleModel(BaseModel):
    id: int
    flow: str
    cron: str
    sample: str | None = None
    runtime: str
    enabled: bool
    created: str
    user: str = LOCAL_USER
    last_run: int | None = None
    last_status: str | None = None
    next_run: str | None = None
    description: str
    next_five: list[str]


class ScheduleList(BaseModel):
    schedules: list[ScheduleModel]


class NewSchedule(BaseModel):
    flow: str
    cron: str
    sample: str | None = None
    runtime: str | None = None
    enabled: bool = True


class ScheduleChange(BaseModel):
    flow: str | None = None
    cron: str | None = None
    sample: str | None = None
    runtime: str | None = None
    enabled: bool | None = None


class CronPreviewRequest(BaseModel):
    cron: str


class CronPreview(BaseModel):
    description: str
    next_five: list[str]


class AiSettings(BaseModel):
    provider: str
    model: str | None = None
    has_anthropic_key: bool | None = Field(default=None, description="null: not an admin")
    has_openai_key: bool | None = Field(default=None, description="null: not an admin")


class ServerSettings(BaseModel):
    host: str
    port: int
    token_set: bool


class SettingsModel(BaseModel):
    workspace: str
    default_runtime: str
    default_batch: int
    exec_timeout: float
    max_concurrent_runs: int
    max_source_bytes: int
    cancel_grace: float
    keep_traces_days: int
    theme: str
    ai: AiSettings
    server: ServerSettings | None = Field(
        default=None, description="the address and whether a token is set; admins only"
    )


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    path: str | None = None
    messages: list[ChatMessage]
    provider: str | None = None
    model: str | None = None
    sample: str | None = None


class Health(BaseModel):
    ok: bool
    version: str
    workspace: str | None = Field(
        default=None, description="left out when the caller is not signed in"
    )
    runs_live: int
    scheduler: bool


# ------------------------------------------------------------- users and sessions


class LoginRequest(BaseModel):
    name: str
    password: str


class UserModel(BaseModel):
    id: int = Field(description="0 for the implicit local admin and for the server token")
    name: str
    role: str
    created: str = ""
    disabled: bool = False
    must_change_password: bool = False
    last_seen: str | None = None


class LoginResult(BaseModel):
    token: str = Field(description="the session token; it is not shown again")
    user: UserModel


class MeResult(BaseModel):
    user: UserModel | None = None
    mode: str = Field(description="local | users | token")
    can_setup: bool = False


class PasswordChange(BaseModel):
    current: str = ""
    new: str


class TokenModel(BaseModel):
    id: int
    label: str = ""
    created: str
    last_seen: str | None = None


class TokenList(BaseModel):
    tokens: list[TokenModel]


class NewToken(BaseModel):
    label: str = ""


class IssuedToken(BaseModel):
    id: int
    token: str = Field(description="shown once; only its sha256 is kept")
    label: str = ""


class UserList(BaseModel):
    users: list[UserModel]


class NewUser(BaseModel):
    name: str
    password: str
    role: str = "member"


class UserChange(BaseModel):
    role: str | None = None
    disabled: bool | None = None
    password: str | None = None


# --------------------------------------------------------------------------- the app


def create_app(settings: AppSettings) -> FastAPI:
    """The whole server for one workspace. The caller runs it with uvicorn."""
    if not settings.workspace.is_dir():
        raise ValueError(
            f"the workspace {settings.workspace} is not a directory; "
            "make it, or start with --workspace DIR"
        )
    store = Store(settings.db_path, clock=settings.clock)
    web = WebSettings(store, settings)
    auth = Auth(settings, store)

    def finished(run: Run) -> None:
        """A run that a schedule started leaves its status on the schedule."""
        if run.trigger.startswith("schedule:"):
            with contextlib.suppress(ValueError):
                store.update_schedule(int(run.trigger.split(":", 1)[1]), last_status=run.status)

    supervisor = Supervisor(settings.workspace, store, web, on_finish=finished)

    def fire(schedule: Schedule) -> None:
        """The scheduler's callback: start the run and remember it on the schedule."""
        run = supervisor.start(
            schedule.flow,
            runtime=schedule.runtime,
            sample_name=schedule.sample,
            sample_items=_sample_items(settings.workspace, schedule.flow, schedule.sample),
            trigger=f"schedule:{schedule.id}",
        )
        # A scheduled run belongs to whoever made the schedule, not to whoever was
        # signed in when the minute came round.
        store.set_run_user(run.id, schedule.user)
        store.update_schedule(schedule.id, last_run=run.id, last_status="running")

    scheduler = Scheduler(
        store,
        fire,
        clock=settings.clock or local_now,
        interval=settings.scheduler_interval,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Traces and samples of runs nobody will look at again go on the way in, so a
        # workspace that has been worked in for months is not mostly .tolquane-web.
        with contextlib.suppress(OSError):
            swept = supervisor.sweep()
            if swept:
                log.info("removed %s file(s) older than keep_traces_days", swept)
        if settings.start_scheduler:
            scheduler.start()
        try:
            yield
        finally:
            scheduler.stop()
            supervisor.shutdown()
            store.close()

    app = FastAPI(
        title="Tolquane Web",
        version=tq.__version__,
        summary="Create, run, watch and schedule Tolquane flows in a workspace.",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.auth = auth
    app.state.store = store
    app.state.web_settings = web
    app.state.supervisor = supervisor
    app.state.scheduler = scheduler

    _errors(app)
    _routes(app, settings, store, web, supervisor, scheduler, auth)
    _frontend(app, settings)
    # No CORS middleware, on purpose: the page and the API are the same origin, so a
    # site in another tab gets no answer it could read. Added last, so they run first.
    app.add_middleware(BodyLimit, web=web)
    app.add_middleware(TokenWall, token=settings.token, auth=auth)
    hide_tokens_in_logs()
    return app


def _errors(app: FastAPI) -> None:
    """One error shape for every failure, whoever raised it."""

    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, ApiError)
        return JSONResponse(exc.body(), status_code=exc.status)

    @app.exception_handler(TolquaneError)
    async def tolquane_error(request: Request, exc: Exception) -> JSONResponse:
        # GraphError and its kin already say how to fix the flow: pass them through.
        return JSONResponse(ApiError(400, type(exc).__name__, str(exc)).body(), status_code=400)

    @app.exception_handler(RequestValidationError)
    async def invalid(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, RequestValidationError)
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(part) for part in first.get("loc", ())[1:])
        message = str(first.get("msg", "the request body is not what this route takes"))
        detail = json.loads(json.dumps(exc.errors(), default=str))
        body = ApiError(400, "ValidationError", f"{where}: {message}" if where else message, detail)
        return JSONResponse(body.body(), status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, StarletteHTTPException)
        kinds = {401: "Unauthorized", 404: "NotFound", 405: "MethodNotAllowed"}
        kind = kinds.get(exc.status_code, "HTTPError")
        return JSONResponse(
            ApiError(exc.status_code, kind, str(exc.detail)).body(), status_code=exc.status_code
        )


UNAUTHORIZED = (
    "this server was started with a token; send it as 'Authorization: Bearer <token>', "
    "or ?token= on the WebSocket and on a download link"
)


def token_ok(expected: str | None, authorization: str | None, query_token: str | None) -> bool:
    """Does this request carry the token? Constant time, so a wrong one says nothing.

    The header is what a client sends; ``?token=`` is there for the WebSocket, for an
    event stream and for a download link, none of which can set a header.
    """
    if not expected:
        return True
    sent = query_token or ""
    if authorization and authorization.lower().startswith("bearer "):
        sent = authorization.split(" ", 1)[1].strip()
    return hmac.compare_digest(sent.encode("utf-8"), expected.encode("utf-8"))


def _guard(auth: Auth) -> Callable[..., None]:
    """The dependency every ``/api`` route carries: the token, then the role table.

    :class:`TokenWall` asks :meth:`Auth.gate` the same question one layer out, for the
    routes FastAPI adds itself (``/api/openapi.json``, ``/api/docs``) and for anything
    added here later without this dependency. Two checks, one answer; neither is the
    only one. It takes nothing but the request, so it adds no parameter to the OpenAPI
    document: the token is a header, or the ``?token=`` a socket has to use instead.
    """

    def check(request: Request) -> None:
        principal, refusal = auth.gate(
            request.method,
            request.url.path,
            request.headers.get("authorization"),
            request.query_params.get("token"),
        )
        request.scope.setdefault("state", {})["principal"] = principal
        if refusal is not None:
            raise refusal

    return check


# ----------------------------------------------------------------------- who is calling

SIGN_IN = (
    "this server has users: sign in for a session token, or send a personal API token as "
    "'Authorization: Bearer <token>' (?token= on a WebSocket, an event stream or a "
    "download link)"
)

PUBLIC = "public"
MEMBER = "member"
ADMIN = "admin"

ROUTE_ROLES: tuple[tuple[str, str, str], ...] = (
    # (method or "*", path or path prefix, the least role that may call it)
    ("GET", "/api/health", PUBLIC),
    ("GET", "/api/auth/me", PUBLIC),
    ("POST", "/api/auth/login", PUBLIC),
    ("POST", "/api/auth/setup", PUBLIC),
    ("*", "/api/users", ADMIN),
)
"""What each route needs, in one place rather than in thirty decorators.

Everything not named here needs :data:`MEMBER`: a signed-in user of either role. The
paths are matched as themselves or as a prefix, so ``/api/users/{id}`` is covered by
``/api/users`` and this table answers for a URL as well as for a route template. The
contract's other half -- a member may read the settings but write only ``theme`` -- is
about fields rather than routes, and lives in the settings routes themselves.
"""


def role_for(method: str, path: str) -> str:
    """The role :data:`ROUTE_ROLES` asks of this request."""
    verb = method.upper()
    for wanted, prefix, role in ROUTE_ROLES:
        matches = path == prefix or path.startswith(prefix + "/")
        if matches and wanted in ("*", verb):
            return role
    return MEMBER


LOCAL_ADMIN = User(
    id=0, name=LOCAL_USER, role=ADMIN, created="", disabled=False, must_change_password=False
)
"""Local mode: no users, loopback only, so whoever is at the keyboard owns the machine."""

TOKEN_ADMIN = User(
    id=0, name="token", role=ADMIN, created="", disabled=False, must_change_password=False
)
"""The ``--token`` value, which is an admin API token in every mode: setup and scripts."""


@dataclass(frozen=True)
class Principal:
    """Who is calling: a user row, the implicit local admin, or the server's own token."""

    user: User
    kind: str
    """``local``, ``token``, ``session`` or ``api``: how they proved it."""
    session_id: int | None = None

    @property
    def name(self) -> str:
        """The name a run or a schedule they start is recorded under."""
        return self.user.name

    @property
    def role(self) -> str:
        return self.user.role

    @property
    def is_admin(self) -> bool:
        return self.user.role == ADMIN

    @property
    def account(self) -> bool:
        """Is this a real user, rather than local mode or the server token?"""
        return self.user.id != 0


class Auth:
    """The one place that answers "who is this?" and "may they?".

    The mode is read from the store on every question, because it changes the moment the
    first user is created: a server that started in local mode is in users mode from
    then on, without a restart.
    """

    def __init__(self, settings: AppSettings, store: Store) -> None:
        self.settings = settings
        self.store = store

    def mode(self) -> str:
        """``users`` once anybody exists, ``token`` with ``--token`` and nobody, else ``local``."""
        if self.store.count_users():
            return "users"
        return "token" if self.settings.token else "local"

    def principal(self, authorization: str | None, query_token: str | None) -> Principal | None:
        """Resolve the bearer token, or ``None`` when there is no way in.

        A session token, an API token and the ``--token`` value are all bearer tokens
        here. In local mode there is nobody to be, so everyone is the local admin, and a
        token left over in a browser from another day does not lock the user out.
        """
        sent = bearer(authorization, query_token)
        if self.settings.token and sent and token_ok(self.settings.token, None, sent):
            return Principal(user=TOKEN_ADMIN, kind="token")
        if sent:
            identity = self.store.resolve_token(sent)
            if identity is not None:
                return Principal(
                    user=identity.user, kind=identity.session.kind, session_id=identity.session.id
                )
        if self.mode() == "local":
            return Principal(user=LOCAL_ADMIN, kind="local")
        return None

    def gate(
        self, method: str, path: str, authorization: str | None, query_token: str | None
    ) -> tuple[Principal | None, ApiError | None]:
        """Who is calling and what, if anything, refuses them. The whole decision, once.

        With ``--token``, nothing under ``/api`` passes without that token or a session,
        which is what the server did before there were users. The exception is the public
        routes once there are users to sign in as: a login page that needed the token to
        offer a login box would be a lock with two keys.
        """
        principal = self.principal(authorization, query_token)
        role = role_for(method, path)
        open_door = role == PUBLIC and self.mode() == "users"
        if (
            self.settings.token
            and principal is None
            and not open_door
            and not token_ok(self.settings.token, authorization, query_token)
        ):
            return None, ApiError(401, "Unauthorized", UNAUTHORIZED)
        if role == PUBLIC:
            return principal, None
        if principal is None:
            error = UNAUTHORIZED if self.settings.token else SIGN_IN
            return None, ApiError(401, "Unauthorized", error)
        if role == ADMIN and not principal.is_admin:
            return principal, ApiError(
                403,
                "Forbidden",
                f"{method.upper()} {path} is for administrators, and {principal.name} is a "
                f"{principal.role}; ask an administrator to do it or to change your role",
            )
        return principal, None


def bearer(authorization: str | None, query_token: str | None) -> str:
    """The token this request carries: the header, else ``?token=``, else nothing."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return query_token or ""


def _principal(auth: Auth, request: Request) -> Principal | None:
    """Who is calling, resolved once per request: :class:`TokenWall` leaves it here."""
    state = request.scope.setdefault("state", {})
    if "principal" not in state:
        state["principal"] = auth.principal(
            request.headers.get("authorization"), request.query_params.get("token")
        )
    found = state["principal"]
    return found if isinstance(found, Principal) else None


def _caller(auth: Auth) -> Callable[..., Principal]:
    """A dependency for the routes that need to know who is asking."""

    def caller(request: Request) -> Principal:
        principal = _principal(auth, request)
        if principal is None:  # pragma: no cover - the gate on the route answered first
            raise ApiError(401, "Unauthorized", UNAUTHORIZED if auth.settings.token else SIGN_IN)
        return principal

    return caller


def _maybe_caller(auth: Auth) -> Callable[..., Principal | None]:
    """The same, for the public routes: signed in, or not, and both are answers."""

    def caller(request: Request) -> Principal | None:
        return _principal(auth, request)

    return caller


class TokenWall:
    """Every request under ``/api``, HTTP and WebSocket alike, is placed or stopped.

    A guard on each route can be forgotten, and the routes FastAPI adds for its own
    schema and documentation never had one. This is the layer that does not care which
    route the path belongs to. The static files are served without a token: they are the
    page that asks the user for it.

    It does two things. With ``--token``, nothing under ``/api`` passes without either
    that token or a session of a user, exactly as before there were users. Then, when
    there is an :class:`Auth`, it works out who is calling, leaves them in the request's
    state for the routes to read, and applies the role table to the path.
    """

    def __init__(self, app: ASGIApp, token: str | None = None, auth: Auth | None = None) -> None:
        self.app = app
        self.token = token
        self.auth = auth

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket") and _is_api(scope):
            authorization, query = _header(scope, b"authorization"), _query_token(scope)
            if self.auth is None:
                if self.token and not token_ok(self.token, authorization, query):
                    error = ApiError(401, "Unauthorized", UNAUTHORIZED)
                    await self._refuse(scope, receive, send, error)
                    return
            else:
                principal, refusal = self.auth.gate(
                    str(scope.get("method") or "GET"), str(scope["path"]), authorization, query
                )
                scope.setdefault("state", {})["principal"] = principal
                if refusal is not None:
                    await self._refuse(scope, receive, send, refusal)
                    return
        await self.app(scope, receive, send)

    async def _refuse(self, scope: Scope, receive: Receive, send: Send, error: ApiError) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await JSONResponse(error.body(), status_code=error.status)(scope, receive, send)


class BodyLimit:
    """A request body bigger than ``max_source_bytes`` is refused before it is read.

    A flow is a file a person wrote; two megabytes of it is already far past anything
    the canvas can draw. Without a limit, one enormous ``PUT`` is a way to make the
    server hold as much memory as the client cares to send.
    """

    def __init__(self, app: ASGIApp, web: WebSettings | None = None) -> None:
        self.app = app
        self.web = web

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        declared = (
            _header(scope, b"content-length")
            if scope["type"] == "http" and self.web is not None and _is_api(scope)
            else None
        )
        # The setting is read from the store, so only a request that carries a body asks.
        if declared and declared.isdigit():
            size, limit = int(declared), self.web.max_source_bytes  # type: ignore[union-attr]
            if size > limit:
                error = ApiError(413, "TooLarge", too_large(size, limit))
                await JSONResponse(error.body(), status_code=413)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def too_large(size: int, limit: int) -> str:
    return (
        f"that is {size} bytes and the limit is {limit}: raise max_source_bytes in "
        "settings if a flow really is this big"
    )


def _check_size(source: str, limit: int) -> None:
    """The same limit for a body that arrived without a length to check it by."""
    size = len(source.encode("utf-8"))
    if size > limit:
        raise ApiError(413, "TooLarge", too_large(size, limit))


def _is_api(scope: Scope) -> bool:
    path = str(scope.get("path", ""))
    return path == "/api" or path.startswith("/api/")


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", ()):
        if bytes(key).lower() == name:
            return bytes(value).decode("latin-1")
    return None


def _query_token(scope: Scope) -> str | None:
    query = scope.get("query_string", b"").decode("latin-1")
    values = parse_qs(query).get("token") if query else None
    return values[0] if values else None


class TokenFilter(logging.Filter):
    """Keeps the token out of the log.

    A WebSocket and a download link carry ``?token=`` in the URL, and an access log
    writes the URL. Nobody needs to read a secret out of a terminal or a log file.
    """

    PATTERN = re.compile(r"(token=)[^&\s\"']+")

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(self._clean(arg) for arg in record.args)
        record.msg = self._clean(record.msg)
        return True

    def _clean(self, value: Any) -> Any:
        if isinstance(value, str) and "token=" in value:
            return self.PATTERN.sub(r"\1<hidden>", value)
        return value


def hide_tokens_in_logs() -> None:
    """Put :class:`TokenFilter` on the loggers that write request lines."""
    for name in ("uvicorn.access", "uvicorn.error", __name__):
        logger = logging.getLogger(name)
        if not any(isinstance(existing, TokenFilter) for existing in logger.filters):
            logger.addFilter(TokenFilter())


# --------------------------------------------------------------------------- paths


def safe_path(workspace: Path, given: str, *, suffix: str | None = ".py") -> Path:
    """Where ``given`` is in the workspace, or 400 saying why it is not allowed.

    Rejects an absolute path, a Windows drive or share, ``..`` and anything that resolves
    outside the workspace, which is what catches a symlink pointing away. Every route
    that reads, writes, renames or deletes goes through here, targets included: a name
    the server is about to create is checked the same way as one it is about to read.
    """
    text = (given or "").strip().replace("\\", "/")
    if not text:
        raise bad_request("a flow path is needed, relative to the workspace")
    if text.startswith("/") or (len(text) > 1 and text[1] == ":"):
        raise bad_request(
            f"{given!r} is an absolute path; a flow is named relative to the workspace"
        )
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise bad_request(f"{given!r} leaves the workspace; '..' is not allowed in a flow path")
    if not parts:
        raise bad_request("a flow path is needed, relative to the workspace")
    if suffix and not parts[-1].endswith(suffix):
        raise bad_request(f"{given!r} is not a {suffix} file")
    candidate = workspace.joinpath(*parts)
    if not inside(workspace, candidate):
        raise bad_request(f"{given!r} leads outside the workspace {workspace.resolve()}")
    return candidate


def inside(workspace: Path, candidate: Path) -> bool:
    """Does ``candidate`` land in the workspace once every symlink is followed?

    ``resolve`` follows the links of the parts that exist and leaves the rest alone, so
    this answers for a file that is not there yet as well as for one that is.
    """
    resolved = candidate.resolve()
    root = workspace.resolve()
    return resolved == root or root in resolved.parents


def layout_target(workspace: Path, flow: Path) -> Path:
    """The sidecar of a flow, checked the way the flow itself was.

    The name is derived, never given, so the only way out of the workspace is a sidecar
    that is itself a symlink pointing away. Writing through one would put a person's
    canvas positions somewhere they did not ask for; refuse instead.
    """
    sidecar = flow_model.layout_path(flow)
    if not inside(workspace, sidecar):
        raise bad_request(
            f"the layout file for {relative(workspace, flow)} leads outside the workspace; "
            "it is a symlink pointing away, and Tolquane Web will not write through it"
        )
    return sidecar


def relative(workspace: Path, path: Path) -> str:
    return path.resolve().relative_to(workspace.resolve()).as_posix()


def modified_of(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat()


def _sample_items(workspace: Path, flow: str, name: str | None) -> list[Any] | None:
    """The items of a sample saved in the flow's layout sidecar, by name."""
    if not name:
        return None
    file = safe_path(workspace, flow)
    layout = flow_model.read_layout(layout_target(workspace, file))
    if layout is not None:
        for sample in layout.samples:
            if sample.name == name:
                return list(sample.items)
    raise bad_request(f"the flow has no sample called {name!r}; samples live in its layout sidecar")


# --------------------------------------------------------------------------- the routes


def _routes(
    app: FastAPI,
    settings: AppSettings,
    store: Store,
    web: WebSettings,
    supervisor: Supervisor,
    scheduler: Scheduler,
    auth: Auth,
) -> None:
    guard = [Depends(_guard(auth))]
    workspace = settings.workspace
    # ``Principal = caller`` rather than an Annotated alias: this module postpones its
    # annotations, and FastAPI resolves them against the module, where a local alias is
    # not to be found.
    caller = Depends(_caller(auth))
    visitor = Depends(_maybe_caller(auth))

    def account(me: Principal) -> User:
        """The user row behind a principal, or 400: local mode and the server token have
        no password to change and no tokens of their own."""
        user = store.get_user(me.user.id) if me.account else None
        if user is None:
            raise bad_request(
                "there is no user account behind this request: local mode and the --token "
                "value are not people. Make a user with 'tolquane web users add NAME'."
            )
        return user

    def made(call: Callable[[], Any]) -> Any:
        """Run a store call whose ``ValueError`` is the user's mistake, not ours."""
        try:
            return call()
        except ValueError as exc:
            raise bad_request(str(exc)) from exc

    def user_or_404(user_id: int) -> User:
        user = store.get_user(user_id)
        if user is None:
            raise not_found(f"no user {user_id}")
        return user

    def keep_an_admin(user: User, role: str, disabled: bool) -> None:
        """Refuse a change that would leave nobody who can sign in and put it back."""
        others = [admin for admin in store.enabled_admins() if admin.id != user.id]
        if not others and not (role == ADMIN and not disabled):
            raise bad_request(
                f"{user.name} is the last administrator who can sign in; make somebody "
                "else an administrator first"
            )

    def scratch() -> Path:
        directory = workspace / WORK_DIR / "tmp"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def parse_of(file: Path) -> dict[str, Any]:
        """The model, the code-only reason and the graph of one file, from children."""
        timeout = web.exec_timeout
        try:
            parsed = model_command("parse", file, workspace, timeout)
        except ChildTimeout as exc:
            raise ApiError(400, "Timeout", str(exc)) from exc
        except ChildFailed as exc:
            return {"model": None, "code_only": {"reason": str(exc)}, "graph": None}
        if not isinstance(parsed, dict):  # pragma: no cover - the child prints one object
            raise ApiError(500, "ParseError", "the parser did not answer with an object")
        if parsed.get("code_only"):
            return {
                "model": None,
                "code_only": {"reason": parsed.get("reason", "")},
                "graph": parsed.get("graph"),
            }
        graph: dict[str, Any] | None
        try:
            graph = model_command("graph", file, workspace, timeout)
        except ChildFailed:
            graph = None
        return {"model": parsed, "code_only": None, "graph": graph}

    def detail(file: Path) -> dict[str, Any]:
        if not file.is_file():
            raise not_found(f"no flow at {relative(workspace, file)}")
        layout = flow_model.read_layout(layout_target(workspace, file))
        return {
            "path": relative(workspace, file),
            "source": file.read_text(encoding="utf-8"),
            "modified": modified_of(file),
            "layout": layout.to_dict() if layout else None,
            **parse_of(file),
        }

    def run_dict(run: Run) -> dict[str, Any]:
        live = supervisor.get(run.id)
        return {**run.to_dict(), "live": bool(live is not None and live.alive)}

    def schedule_dict(schedule: Schedule) -> dict[str, Any]:
        try:
            cron = Cron.parse(schedule.cron)
        except ValueError as exc:  # a row written by hand, or by an older Tolquane
            return {**schedule.to_dict(), "description": f"unreadable: {exc}", "next_five": []}
        return {
            **schedule.to_dict(),
            "description": cron.describe(),
            "next_five": _next_five(cron, settings.clock or local_now),
        }

    # Flows ---------------------------------------------------------------

    @app.get("/api/flows", operation_id="listFlows", response_model=FlowList, dependencies=guard)
    async def list_flows() -> dict[str, Any]:
        """Every ``.py`` file in the workspace, with when it changed and how it last ran."""
        flows = []
        for file in sorted(_walk(workspace)):
            path = relative(workspace, file)
            runs = store.list_runs(flow=path, limit=1)
            last = runs[0] if runs else None
            flows.append(
                {
                    "path": path,
                    "name": file.stem,
                    "modified": modified_of(file),
                    "size": file.stat().st_size,
                    "has_layout": flow_model.layout_path(file).is_file(),
                    "last_run": (
                        {"id": last.id, "status": last.status, "ended": last.ended}
                        if last
                        else None
                    ),
                }
            )
        return {"workspace": str(workspace), "flows": flows}

    @app.post(
        "/api/flows",
        operation_id="createFlow",
        response_model=FlowDetail,
        status_code=201,
        dependencies=guard,
    )
    async def create_flow(body: NewFlow) -> dict[str, Any]:
        """Write a new flow from a template or from a model, and return it parsed."""
        file = safe_path(workspace, body.path)
        if file.exists():
            raise ApiError(409, "Conflict", f"{body.path} already exists")
        if isinstance(body.template, dict):
            source = _generate(body.template.get("model", body.template))
        elif body.template in TEMPLATES:
            source = TEMPLATES[body.template].format(name=file.stem)
        else:
            raise bad_request(
                f"unknown template {body.template!r}; use 'empty', 'hello' or {{'model': ...}}"
            )
        _check_size(source, web.max_source_bytes)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source, encoding="utf-8")
        return detail(file)

    @app.post(
        "/api/flows/parse",
        operation_id="parseFlow",
        response_model=ParseResult,
        dependencies=guard,
    )
    async def parse_flow(body: ParseRequest) -> dict[str, Any]:
        """Read source that is not saved yet: the model, or why it is code-only."""
        _check_size(body.source, web.max_source_bytes)
        scratch_dir = scratch() / uuid.uuid4().hex[:8]
        scratch_dir.mkdir(parents=True, exist_ok=True)
        file = scratch_dir / f"{Path(body.name).stem or 'flow'}.py"
        try:
            file.write_text(body.source, encoding="utf-8")
            return parse_of(file)
        finally:
            shutil.rmtree(scratch_dir, ignore_errors=True)

    @app.post(
        "/api/flows/generate",
        operation_id="generateFlow",
        response_model=GenerateResult,
        dependencies=guard,
    )
    async def generate_flow(body: GenerateRequest) -> dict[str, Any]:
        """The Python for a model. Pure text: nothing is imported or run."""
        return {"source": _generate(body.model)}

    @app.get(
        "/api/flows/{path:path}",
        operation_id="getFlow",
        response_model=FlowDetail,
        dependencies=guard,
    )
    async def get_flow(path: str) -> dict[str, Any]:
        """One flow: its source, its model or why it is code-only, its graph and layout."""
        return detail(safe_path(workspace, path))

    @app.put(
        "/api/flows/{path:path}/layout",
        operation_id="saveLayout",
        response_model=Ok,
        dependencies=guard,
    )
    async def save_layout(path: str, body: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
        """Write the canvas sidecar next to the flow."""
        file = safe_path(workspace, path)
        if not file.is_file():
            raise not_found(f"no flow at {path}")
        sidecar = layout_target(workspace, file)
        try:
            layout = flow_model.Layout.from_dict(body)
        except (TypeError, ValueError, AttributeError) as exc:
            raise bad_request(f"that is not a layout: {exc}") from exc
        flow_model.write_layout(sidecar, layout)
        return {"ok": True}

    @app.post(
        "/api/flows/{path:path}/rename",
        operation_id="renameFlow",
        response_model=FlowDetail,
        dependencies=guard,
    )
    async def rename_flow(path: str, body: RenameFlow) -> dict[str, Any]:
        """Move a flow and its sidecar."""
        file = safe_path(workspace, path)
        target = safe_path(workspace, body.path)
        if not file.is_file():
            raise not_found(f"no flow at {path}")
        if target.exists():
            raise ApiError(409, "Conflict", f"{body.path} already exists")
        sidecar = layout_target(workspace, file)
        moved = layout_target(workspace, target)
        target.parent.mkdir(parents=True, exist_ok=True)
        file.rename(target)
        if sidecar.is_file():
            sidecar.rename(moved)
        return detail(target)

    @app.post(
        "/api/flows/{path:path}/check",
        operation_id="checkFlow",
        response_model=CheckResult,
        dependencies=guard,
    )
    async def check_flow(path: str) -> dict[str, Any]:
        """``tq.check`` in a child process: the counts, or the GraphError as it stands."""
        file = _existing(workspace, path)
        text = _child_text("check", file, workspace, web.exec_timeout)
        nodes, edges = _counts(text)
        return {"ok": True, "nodes": nodes, "edges": edges}

    @app.post(
        "/api/flows/{path:path}/explain",
        operation_id="explainFlow",
        response_model=ExplainResult,
        dependencies=guard,
    )
    async def explain_flow(path: str) -> dict[str, Any]:
        """``tq.explain``: one line per node and edge."""
        file = _existing(workspace, path)
        return {"text": _child_text("explain", file, workspace, web.exec_timeout)}

    @app.post(
        "/api/flows/{path:path}/draw",
        operation_id="drawFlow",
        response_model=DrawResult,
        dependencies=guard,
    )
    async def draw_flow(path: str) -> dict[str, Any]:
        """``tq.draw``: the Mermaid text for the expanded graph."""
        file = _existing(workspace, path)
        return {"mermaid": _child_text("draw", file, workspace, web.exec_timeout)}

    @app.post(
        "/api/flows/{path:path}/optimize",
        operation_id="optimizeFlow",
        response_model=OptimizeResult,
        dependencies=guard,
    )
    async def optimize_flow(path: str, body: OptimizeRequest | None = None) -> dict[str, Any]:
        """What ``tq.optimize`` would cut: its notes and the graph it leaves."""
        file = _existing(workspace, path)
        options = body or OptimizeRequest()
        try:
            result = optimize_command(file, workspace, web.exec_timeout, options.all2all)
        except ChildTimeout as exc:
            raise ApiError(400, "Timeout", str(exc)) from exc
        except ChildFailed as exc:
            raise bad_request(str(exc)) from exc
        notes = [str(note) for note in result.get("notes", [])]
        if notes:
            notes.append(
                "the rewrite happens when the flow runs: start a run with optimize, or "
                "call tq.optimize(build()) in main()"
            )
        return {"source": None, "notes": notes, "graph": result.get("graph")}

    @app.put(
        "/api/flows/{path:path}",
        operation_id="saveFlow",
        response_model=FlowDetail,
        dependencies=guard,
    )
    async def save_flow(path: str, body: SaveFlow) -> dict[str, Any]:
        """Write a flow. A ``modified`` that no longer matches answers 409 with the file."""
        file = safe_path(workspace, path)
        _check_size(body.source, web.max_source_bytes)
        if file.is_file() and body.modified is not None:
            current = modified_of(file)
            if current != body.modified:
                raise ApiError(
                    409,
                    "Conflict",
                    f"{path} changed on disk since you opened it; merge the two versions",
                    {"source": file.read_text(encoding="utf-8"), "modified": current},
                )
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(body.source, encoding="utf-8")
        return detail(file)

    @app.delete(
        "/api/flows/{path:path}",
        operation_id="deleteFlow",
        response_model=Ok,
        dependencies=guard,
    )
    async def delete_flow(path: str) -> dict[str, Any]:
        """Delete a flow and its sidecar."""
        file = _existing(workspace, path)
        sidecar = layout_target(workspace, file)
        file.unlink()
        sidecar.unlink(missing_ok=True)
        return {"ok": True}

    # Runs ----------------------------------------------------------------

    @app.post("/api/runs", operation_id="startRun", response_model=RunModel, dependencies=guard)
    async def start_run(body: StartRun, me: Principal = caller) -> dict[str, Any]:
        """Start a flow in a child process and return the run that was recorded."""
        file = _existing(workspace, body.path)
        path = relative(workspace, file)
        runtime = body.runtime or web.default_runtime
        try:
            run = supervisor.start(
                path,
                runtime=runtime,
                sample_name=body.sample,
                sample_items=_sample_items(workspace, path, body.sample),
                batch=body.batch if body.batch is not None else web.default_batch,
                tap=body.tap,
                trace=body.trace,
                optimize=body.optimize,
                trigger="manual",
            )
        except TooManyRuns as exc:
            raise ApiError(429, "TooManyRuns", str(exc)) from exc
        return run_dict(store.set_run_user(run.id, me.name))

    @app.get("/api/runs", operation_id="listRuns", response_model=RunList, dependencies=guard)
    async def list_runs(flow: str | None = None, limit: int = 50) -> dict[str, Any]:
        """Runs, newest first. The log is left out here; ask for one run, or its log."""
        runs = store.list_runs(flow=flow, limit=max(1, min(limit, 500)))
        return {"runs": [{**run_dict(run), "log": ""} for run in runs]}

    @app.get(
        "/api/runs/{run_id}", operation_id="getRun", response_model=RunModel, dependencies=guard
    )
    async def get_run(run_id: int) -> dict[str, Any]:
        return run_dict(_run(store, run_id))

    @app.post(
        "/api/runs/{run_id}/cancel",
        operation_id="cancelRun",
        response_model=RunModel,
        dependencies=guard,
    )
    async def cancel_run(run_id: int) -> dict[str, Any]:
        """SIGTERM now, SIGKILL after ``cancel_grace``. A run that ended is returned as is."""
        run = _run(store, run_id)
        supervisor.cancel(run_id)
        return run_dict(store.get_run(run_id) or run)

    @app.get(
        "/api/runs/{run_id}/log",
        operation_id="getRunLog",
        response_class=PlainTextResponse,
        dependencies=guard,
    )
    async def get_run_log(run_id: int) -> PlainTextResponse:
        """What the flow printed, live while it runs and from the store afterwards."""
        run = _run(store, run_id)
        live = supervisor.get(run_id)
        text = live.log_text() if live is not None else run.log
        return PlainTextResponse(text)

    @app.get("/api/runs/{run_id}/trace", operation_id="getRunTrace", dependencies=guard)
    async def get_run_trace(run_id: int) -> FileResponse:
        """The Chrome trace file, for a run started with ``trace``."""
        run = _run(store, run_id)
        if not run.trace_path or not Path(run.trace_path).is_file():
            raise not_found(f"run {run_id} has no trace file")
        return FileResponse(
            run.trace_path, media_type="application/json", filename=f"run-{run_id}-trace.json"
        )

    @app.websocket("/api/runs/{run_id}/events")
    async def run_events(websocket: WebSocket, run_id: int) -> None:
        """Every event of a run, in order: what happened so far, then what happens next."""
        principal = auth.principal(
            websocket.headers.get("authorization"), websocket.query_params.get("token")
        )
        if principal is None:  # pragma: no cover - TokenWall refuses the socket one layer out
            # A socket cannot set a header, so ?token= carries the session token as well
            # as the server's own.
            await websocket.close(code=1008, reason="this server needs a token or a session")
            return
        await websocket.accept()
        live = supervisor.get(run_id)
        if live is None:
            run = store.get_run(run_id)
            await websocket.send_json(
                {"event": "done", "status": run.status, "elapsed": 0.0}
                if run is not None
                else {"event": "error", "type": "NotFound", "message": f"no run {run_id}"}
            )
            await websocket.close()
            return
        backlog, watcher = live.subscribe(asyncio.get_running_loop())
        try:
            for event in backlog:
                await websocket.send_json(event)
            while watcher is not None:
                nxt = await watcher.queue.get()
                if nxt is None:  # the run ended: no more events are coming
                    break
                await websocket.send_json(nxt)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            if watcher is not None:
                live.unsubscribe(watcher)
            with contextlib.suppress(RuntimeError):
                await websocket.close()

    # Schedules -----------------------------------------------------------

    @app.get(
        "/api/schedules",
        operation_id="listSchedules",
        response_model=ScheduleList,
        dependencies=guard,
    )
    async def list_schedules(flow: str | None = None) -> dict[str, Any]:
        return {"schedules": [schedule_dict(s) for s in store.list_schedules(flow=flow)]}

    @app.post(
        "/api/schedules",
        operation_id="createSchedule",
        response_model=ScheduleModel,
        status_code=201,
        dependencies=guard,
    )
    async def create_schedule(body: NewSchedule, me: Principal = caller) -> dict[str, Any]:
        """Add a schedule. The cron expression is checked before anything is stored."""
        _existing(workspace, body.flow)
        _cron(body.cron)
        schedule = store.add_schedule(
            relative(workspace, safe_path(workspace, body.flow)),
            body.cron,
            body.sample,
            body.runtime or web.default_runtime,
            body.enabled,
            user=me.name,
        )
        scheduler.reload()
        return schedule_dict(schedule)

    @app.put(
        "/api/schedules/{schedule_id}",
        operation_id="updateSchedule",
        response_model=ScheduleModel,
        dependencies=guard,
    )
    async def update_schedule(schedule_id: int, body: ScheduleChange) -> dict[str, Any]:
        _schedule(store, schedule_id)
        fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
        if not fields:
            raise bad_request("nothing to change; send at least one field")
        if "cron" in fields:
            _cron(str(fields["cron"]))
        if "flow" in fields:
            fields["flow"] = relative(workspace, _existing(workspace, str(fields["flow"])))
        schedule = store.update_schedule(schedule_id, **fields)
        scheduler.reload()
        return schedule_dict(schedule)

    @app.delete(
        "/api/schedules/{schedule_id}",
        operation_id="deleteSchedule",
        response_model=Ok,
        dependencies=guard,
    )
    async def delete_schedule(schedule_id: int) -> dict[str, Any]:
        _schedule(store, schedule_id)
        store.delete_schedule(schedule_id)
        scheduler.reload()
        return {"ok": True}

    @app.post(
        "/api/schedules/preview",
        operation_id="previewSchedule",
        response_model=CronPreview,
        dependencies=guard,
    )
    async def preview_schedule(body: CronPreviewRequest) -> dict[str, Any]:
        """What an expression means, and the next five times it fires."""
        cron = _cron(body.cron)
        return {
            "description": cron.describe(),
            "next_five": _next_five(cron, settings.clock or local_now),
        }

    @app.post(
        "/api/schedules/{schedule_id}/run",
        operation_id="runScheduleNow",
        response_model=RunModel,
        dependencies=guard,
    )
    async def run_schedule_now(schedule_id: int) -> dict[str, Any]:
        """Fire a schedule now, the way the scheduler would."""
        schedule = _schedule(store, schedule_id)
        try:
            fire = scheduler.fire
            fire(schedule)
        except TooManyRuns as exc:
            raise ApiError(429, "TooManyRuns", str(exc)) from exc
        run_id = (store.get_schedule(schedule_id) or schedule).last_run
        run = store.get_run(run_id) if run_id else None
        if run is None:  # pragma: no cover - fire always records a run
            raise ApiError(500, "RunError", "the run was started but not recorded")
        return run_dict(run)

    # Users and sessions --------------------------------------------------

    @app.post(
        "/api/auth/login", operation_id="login", response_model=LoginResult, dependencies=guard
    )
    async def login(body: LoginRequest) -> dict[str, Any]:
        """Sign in. The session token comes back once; it is stored only as a sha256."""
        user = store.get_user_by_name(body.name)
        # The hash is computed whether or not the name exists, so a name that does not
        # is not the fast answer that tells an attacker which names do.
        matched = verify_password(user.password_hash if user is not None else None, body.password)
        if user is None or not matched:
            raise ApiError(401, "Unauthorized", "that name and password do not go together")
        if user.disabled:
            raise ApiError(
                403,
                "Forbidden",
                f"the account {user.name} is disabled; an administrator can enable it again",
            )
        issued = store.create_session(user.id, "session")
        return {"token": issued.token, "user": user.to_dict()}

    @app.post("/api/auth/logout", operation_id="logout", response_model=Ok, dependencies=guard)
    async def logout(me: Principal = caller) -> dict[str, Any]:
        """Forget this session. A token that is not a session has nothing to forget."""
        if me.session_id is not None:
            store.delete_session(me.session_id)
        return {"ok": True}

    @app.get("/api/auth/me", operation_id="whoami", response_model=MeResult, dependencies=guard)
    async def whoami(me: Principal | None = visitor) -> dict[str, Any]:
        """Who the caller is and what kind of server this is: the page's first question."""
        mode = auth.mode()
        return {
            "user": me.user.to_dict() if me is not None else None,
            "mode": mode,
            "can_setup": mode == "token",
        }

    @app.post(
        "/api/auth/setup",
        operation_id="setupFirstAdmin",
        response_model=LoginResult,
        status_code=201,
        dependencies=guard,
    )
    async def setup_first_admin(body: LoginRequest) -> dict[str, Any]:
        """Make the first administrator, from the login page of a ``--token`` server."""
        if store.count_users():
            raise ApiError(
                409,
                "Conflict",
                "this server already has users; sign in, or ask an administrator for an account",
            )
        if not settings.token:
            raise ApiError(
                403,
                "Forbidden",
                "the first user is made with 'tolquane web users add NAME --admin', or "
                "from the login page of a server started with --token",
            )
        user = made(lambda: store.add_user(body.name, body.password, ADMIN, False))
        issued = store.create_session(user.id, "session")
        return {"token": issued.token, "user": user.to_dict()}

    @app.post(
        "/api/auth/password", operation_id="changePassword", response_model=Ok, dependencies=guard
    )
    async def change_password(body: PasswordChange, me: Principal = caller) -> dict[str, Any]:
        """Change your own password. Sessions live on: this is the browser that asked."""
        user = account(me)
        if not verify_password(user.password_hash, body.current):
            raise ApiError(401, "Unauthorized", "that is not your current password")
        made(lambda: store.update_user(user.id, password=body.new, must_change_password=False))
        return {"ok": True}

    @app.get(
        "/api/auth/tokens",
        operation_id="listApiTokens",
        response_model=TokenList,
        dependencies=guard,
    )
    async def list_tokens(me: Principal = caller) -> dict[str, Any]:
        """Your API tokens. The tokens themselves are not kept, so they are not here."""
        return {"tokens": [token.to_dict() for token in store.list_api_tokens(account(me).id)]}

    @app.post(
        "/api/auth/tokens",
        operation_id="createApiToken",
        response_model=IssuedToken,
        status_code=201,
        dependencies=guard,
    )
    async def create_token(body: NewToken, me: Principal = caller) -> dict[str, Any]:
        """Make an API token for scripts. It never expires and is shown this once."""
        user = account(me)
        label = body.label.strip()[:100] or "api token"
        issued = store.create_session(user.id, "api", label)
        return {"id": issued.session.id, "token": issued.token, "label": label}

    @app.delete(
        "/api/auth/tokens/{token_id}",
        operation_id="deleteApiToken",
        response_model=Ok,
        dependencies=guard,
    )
    async def delete_token(token_id: int, me: Principal = caller) -> dict[str, Any]:
        """Take one of your API tokens back. Anything using it stops working at once."""
        user = account(me)
        session = store.get_session(token_id)
        if session is None or session.user_id != user.id or session.kind != "api":
            raise not_found(f"no API token {token_id}")
        store.delete_session(token_id)
        return {"ok": True}

    @app.get("/api/users", operation_id="listUsers", response_model=UserList, dependencies=guard)
    async def list_users() -> dict[str, Any]:
        """Everybody who can sign in, with when each was last seen."""
        return {"users": [user.to_dict() for user in store.list_users()]}

    @app.post(
        "/api/users",
        operation_id="createUser",
        response_model=UserModel,
        status_code=201,
        dependencies=guard,
    )
    async def create_user(body: NewUser) -> dict[str, Any]:
        """Add a user with a password they are asked to change at their first sign-in."""
        user = made(lambda: store.add_user(body.name, body.password, body.role, True))
        return dict(user.to_dict())

    @app.put(
        "/api/users/{user_id}",
        operation_id="updateUser",
        response_model=UserModel,
        dependencies=guard,
    )
    async def update_user(user_id: int, body: UserChange, me: Principal = caller) -> dict[str, Any]:
        """Change a role, disable an account, or set a password the user must change."""
        user = user_or_404(user_id)
        fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
        if not fields:
            raise bad_request("nothing to change; send a role, disabled or a password")
        keep_an_admin(
            user,
            str(fields.get("role", user.role)),
            bool(fields.get("disabled", user.disabled)),
        )
        if "password" in fields:
            fields["must_change_password"] = True
        return dict(made(lambda: store.update_user(user_id, **fields)).to_dict())

    @app.delete(
        "/api/users/{user_id}", operation_id="deleteUser", response_model=Ok, dependencies=guard
    )
    async def delete_user(user_id: int, me: Principal = caller) -> dict[str, Any]:
        """Remove a user, and with them every session and token they had."""
        user = user_or_404(user_id)
        if me.account and me.user.id == user.id:
            raise bad_request(
                "you cannot delete yourself; another administrator can, or disable the account"
            )
        keep_an_admin(user, "member", True)
        store.delete_user(user_id)
        return {"ok": True}

    # Settings ------------------------------------------------------------

    @app.get(
        "/api/settings",
        operation_id="getSettings",
        response_model=SettingsModel,
        dependencies=guard,
    )
    async def get_settings(me: Principal = caller) -> dict[str, Any]:
        """Everything the settings page shows. Keys are reported as set, never echoed.

        A member sees the workspace and the run settings; whether a key is set, and the
        address the server listens on, are an administrator's business.
        """
        return _settings_view(web.as_dict(), me)

    @app.put(
        "/api/settings",
        operation_id="updateSettings",
        response_model=SettingsModel,
        dependencies=guard,
    )
    async def update_settings(
        body: Annotated[dict[str, Any], Body()], me: Principal = caller
    ) -> dict[str, Any]:
        """Change any subset. ``ai.anthropic_key`` and ``ai.openai_key`` go to the key file."""
        if not me.is_admin:
            refused = sorted(_setting_names(body) - {"theme"})
            if refused:
                raise ApiError(
                    403,
                    "Forbidden",
                    f"a member may change the theme and nothing else; {', '.join(refused)} "
                    "is for an administrator",
                )
        try:
            web.update(body)
        except ValueError as exc:
            raise bad_request(str(exc)) from exc
        return _settings_view(web.as_dict(), me)

    # AI ------------------------------------------------------------------

    @app.post("/api/ai/chat", operation_id="aiChat", dependencies=guard)
    async def ai_chat(body: ChatRequest) -> StreamingResponse:
        """The builder, as an event stream: its words, its tool calls, the flow it wrote."""
        stream = _chat_stream(settings, web, workspace, body)
        return StreamingResponse(
            stream,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Health --------------------------------------------------------------

    @app.get(
        "/api/health",
        operation_id="getHealth",
        response_model=Health,
        response_model_exclude_none=True,
        dependencies=guard,
    )
    async def health(me: Principal | None = visitor) -> dict[str, Any]:
        """Is the server up, and what is it working on?

        No login: this is what a monitor and a login page both ask. Where the workspace
        is on disk is not a stranger's business, so it is left out until someone signs in.
        """
        payload: dict[str, Any] = {
            "ok": True,
            "version": tq.__version__,
            "runs_live": supervisor.live_count(),
            "scheduler": scheduler.running,
        }
        if me is not None:
            payload["workspace"] = str(workspace)
        return payload


# --------------------------------------------------------------------------- helpers


def _walk(workspace: Path) -> Iterator[Path]:
    """Every flow file in the workspace, skipping what is not a person's code.

    Hidden directories, ``.tolquane-web`` and the usual machinery are walked past, and
    so is a symlink whose target is outside: the listing only ever names files this
    server would agree to open.
    """
    for file in workspace.rglob("*.py"):
        parts = file.relative_to(workspace).parts
        if any(part in SKIP_DIRS or part.startswith(".") for part in parts[:-1]):
            continue
        if file.is_file() and inside(workspace, file):
            yield file


def _settings_view(data: dict[str, Any], me: Principal) -> dict[str, Any]:
    """The settings as this caller may see them: a member is told nothing about keys."""
    if me.is_admin:
        return data
    view = dict(data)
    view["server"] = None
    view["ai"] = {**dict(view.get("ai") or {}), "has_anthropic_key": None, "has_openai_key": None}
    return view


def _setting_names(patch: Any, prefix: str = "") -> set[str]:
    """The dotted names a settings body would write, however it was nested."""
    if not isinstance(patch, dict):
        return set()
    names: set[str] = set()
    for key, value in patch.items():
        name = f"{prefix}{key}"
        names |= _setting_names(value, f"{name}.") if isinstance(value, dict) else {name}
    return names


def _existing(workspace: Path, path: str) -> Path:
    file = safe_path(workspace, path)
    if not file.is_file():
        raise not_found(f"no flow at {path}")
    return file


def _generate(model: Any) -> str:
    if not isinstance(model, dict):
        raise bad_request("a model object is needed")
    try:
        return flow_model.to_python(flow_model.FlowModel.from_dict(model))
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise bad_request(f"that model cannot be written as Python: {exc}") from exc


def _child_text(command: str, file: Path, workspace: Path, timeout: float) -> str:
    try:
        return tolquane_command(command, file, workspace, timeout).strip()
    except ChildTimeout as exc:
        raise ApiError(400, "Timeout", str(exc)) from exc
    except ChildFailed as exc:
        # A GraphError message already says the fix; give it to the client unchanged.
        raise ApiError(400, "GraphError", str(exc)) from exc


def _counts(text: str) -> tuple[int, int]:
    """``OK: 6 nodes, 6 edges`` from ``tolquane check``."""
    first = text.splitlines()[0] if text else ""
    numbers = [int(word) for word in first.replace(",", " ").split() if word.isdigit()]
    return (numbers[0], numbers[1]) if len(numbers) >= 2 else (0, 0)


def _run(store: Store, run_id: int) -> Run:
    run = store.get_run(run_id)
    if run is None:
        raise not_found(f"no run {run_id}")
    return run


def _schedule(store: Store, schedule_id: int) -> Schedule:
    schedule = store.get_schedule(schedule_id)
    if schedule is None:
        raise not_found(f"no schedule {schedule_id}")
    return schedule


def _cron(expression: str) -> Cron:
    try:
        return Cron.parse(expression)
    except ValueError as exc:
        raise bad_request(str(exc)) from exc


def _next_five(cron: Cron, clock: Callable[[], datetime]) -> list[str]:
    moment = clock()
    if moment.tzinfo is None:
        moment = moment.astimezone()
    times = []
    for _ in range(5):
        try:
            moment = cron.next_after(moment)
        except ValueError:  # an expression that never comes round again
            break
        times.append(moment.isoformat())
    return times


# --------------------------------------------------------------------------- the chat


def _chat_stream(
    settings: AppSettings, web: WebSettings, workspace: Path, body: ChatRequest
) -> AsyncIterator[bytes]:
    """Drive the builder on a thread and hand its events to the client as they come."""

    async def stream() -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        def emit(event: dict[str, Any] | None) -> None:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(events.put_nowait, event)

        worker = threading.Thread(
            target=_chat_worker,
            args=(settings, web, workspace, body, emit),
            name="tolquane-ai-chat",
            daemon=True,
        )
        worker.start()
        while True:
            event = await events.get()
            if event is None:
                break
            yield b"data: " + json.dumps(event).encode("utf-8") + b"\n\n"

    return stream()


def _chat_worker(
    settings: AppSettings,
    web: WebSettings,
    workspace: Path,
    body: ChatRequest,
    emit: Callable[[dict[str, Any] | None], None],
) -> None:
    """One conversation, in its own directory, so the open file is never written over."""
    from ..ai import Builder

    workdir = workspace / WORK_DIR / "ai" / uuid.uuid4().hex[:8]
    try:
        workdir.mkdir(parents=True, exist_ok=True)
        source = ""
        if body.path:
            file = safe_path(workspace, body.path)
            if file.is_file():
                source = file.read_text(encoding="utf-8")
                (workdir / "flow.py").write_text(source, encoding="utf-8")
        sample_path = None
        items = _sample_items(workspace, body.path, body.sample) if body.path else None
        if items is not None:
            sample_path = workdir / "sample.json"
            sample_path.write_text(json.dumps(items), encoding="utf-8")
        provider = _provider(settings, web, body.provider, body.model)

        def on_event(kind: str, payload: Any) -> None:
            if kind == "text":
                emit({"type": "text", "delta": str(payload)})
            elif kind == "call":
                emit(
                    {
                        "type": "tool",
                        "name": payload.name,
                        "status": "started",
                        "summary": _call_summary(payload),
                    }
                )
            elif kind == "result":
                call, outcome = payload
                first = outcome.content.splitlines()[0] if outcome.content else ""
                emit(
                    {
                        "type": "tool",
                        "name": call.name,
                        "status": "done",
                        "summary": first[:200],
                        "error": bool(outcome.is_error),
                    }
                )

        builder = Builder(provider, workdir, sample_path=sample_path, on_event=on_event)
        result = builder.build(_prompt(body, source))
        if result.code:
            emit({"type": "flow", **_written(workdir, workspace, result.code, web.exec_timeout)})
        emit({"type": "done", "usage": result.usage, "ok": result.ok, "summary": result.summary})
    except ApiError as exc:
        emit({"type": "error", "message": exc.message})
    except Exception as exc:
        log.exception("the AI chat failed")
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        emit(None)


def _call_summary(call: Any) -> str:
    if call.name == "write_flow":
        lines = str(call.args.get("code", "")).count("\n") + 1
        return f"{lines} lines"
    return json.dumps(call.args, default=str)[:200]


def _written(workdir: Path, workspace: Path, code: str, timeout: float) -> dict[str, Any]:
    """The flow the builder ended with, parsed the same way an open file is."""
    file = workdir / "flow.py"
    payload: dict[str, Any] = {"source": code, "model": None, "graph": None}
    if not file.is_file():  # pragma: no cover - the builder writes before it reports code
        return payload
    with contextlib.suppress(ChildFailed):
        parsed = model_command("parse", file, workdir, timeout)
        if isinstance(parsed, dict) and not parsed.get("code_only"):
            payload["model"] = parsed
            with contextlib.suppress(ChildFailed):
                payload["graph"] = model_command("graph", file, workdir, timeout)
        elif isinstance(parsed, dict):
            payload["code_only"] = {"reason": parsed.get("reason", "")}
            payload["graph"] = parsed.get("graph")
    return payload


def _prompt(body: ChatRequest, source: str) -> str:
    """The conversation as one request: the flow in front of the user, then their words."""
    parts: list[str] = []
    if source:
        parts.append(
            f"The user has {body.path} open. It is the flow to work on; write_flow saves "
            f"over it in your own directory.\n\n```python\n{source.strip()}\n```"
        )
    if body.sample:
        parts.append(
            f"They picked the sample {body.sample!r}; call run_flow with "
            "use_sample_file=true to try the flow on it."
        )
    history = [m for m in body.messages if m.content.strip()]
    if not history:
        raise bad_request("the chat needs at least one message")
    for message in history[:-1]:
        who = "User" if message.role == "user" else "You"
        parts.append(f"{who} said earlier: {message.content.strip()}")
    parts.append(history[-1].content.strip())
    return "\n\n".join(parts)


def _provider(
    settings: AppSettings, web: WebSettings, provider: str | None, model: str | None
) -> Any:
    """The model client for this request: the one asked for, else the one in settings."""
    name = (provider or web.ai_provider).strip().lower()
    model_id = model or web.ai_model
    key = web.keys.get(f"{name}_key") if name in ("anthropic", "openai") else None
    if settings.provider_factory is not None:
        return settings.provider_factory(name, model_id, key)
    from ..ai.providers import AnthropicProvider, OpenAIProvider

    if name not in ("anthropic", "openai"):
        raise bad_request(f"unknown provider {name!r}; use 'anthropic' or 'openai'")
    if not key:
        env = "ANTHROPIC_API_KEY" if name == "anthropic" else "OPENAI_API_KEY"
        raise bad_request(
            f"no {name} key: save one in settings, or export {env} before starting the server"
        )
    try:
        if name == "anthropic":
            import anthropic

            return AnthropicProvider(
                model_id or AnthropicProvider.DEFAULT_MODEL, client=anthropic.Anthropic(api_key=key)
            )
        import openai

        return OpenAIProvider(
            model_id or OpenAIProvider.DEFAULT_MODEL, client=openai.OpenAI(api_key=key)
        )
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise bad_request(f"{name} needs its package: pip install 'tolquane[ai]'") from exc


# --------------------------------------------------------------------------- the frontend


INLINE_SCRIPT = re.compile(
    rb"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE
)
"""The inline scripts of ``index.html``. Vite leaves one there: the three lines that set
the theme before the first paint. Each is allowed by its hash, not by ``unsafe-inline``."""

SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}


def content_security_policy(index: Path) -> str:
    """What the page may load: its own files, and nothing from anywhere else.

    ``style-src`` allows ``'unsafe-inline'`` because CodeMirror and the canvas write
    their stylesheets into the document as they load; every other source is the app's
    own origin. ``connect-src`` covers the API and the run WebSocket. Scripts are the
    bundle plus the hash of each inline script the built page carries, so a script
    injected into the page by anything else does not run.
    """
    scripts = ["'self'"]
    with contextlib.suppress(OSError):
        for body in INLINE_SCRIPT.findall(index.read_bytes()):
            digest = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
            scripts.append(f"'sha256-{digest}'")
    return "; ".join(
        [
            "default-src 'self'",
            "script-src " + " ".join(scripts),
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self' ws: wss:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


def _frontend(app: FastAPI, settings: AppSettings) -> None:
    """Serve the built app at ``/``, or say how to build it. Registered last, so every
    ``/api`` route is matched before the single-page fallback sees the request."""
    static = settings.static_dir
    index = static / "index.html"
    policy = content_security_policy(index)
    headers = {**SECURITY_HEADERS, "Content-Security-Policy": policy}

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> Response:
        if full_path.startswith("api"):
            raise not_found(f"no route {full_path}")
        if not index.is_file():
            return JSONResponse(
                {
                    "tolquane": tq.__version__,
                    "api": "/api",
                    "message": "the Tolquane Web frontend is not built here; the API works. "
                    "Install the wheel from PyPI, or build it with 'npm ci && npm run "
                    "build' in web/",
                },
                status_code=200 if full_path in ("", "/") else 404,
                headers=headers,
            )
        candidate = (static / full_path).resolve() if full_path else index
        root = static.resolve()
        if candidate.is_file() and (candidate == root or root in candidate.parents):
            return FileResponse(candidate, headers=headers)
        return FileResponse(index, headers=headers)  # any other path is a route in the app


__all__ = [
    "ApiError",
    "Auth",
    "BodyLimit",
    "Principal",
    "TokenFilter",
    "TokenWall",
    "content_security_policy",
    "create_app",
    "inside",
    "layout_target",
    "role_for",
    "safe_path",
    "token_ok",
]
