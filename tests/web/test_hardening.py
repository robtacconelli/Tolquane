"""What the server refuses: the token, the workspace fence, the limits, the headers.

``test_server.py`` covers what every route does when it is asked properly. This file is
the other half: what happens when it is not. Nothing here needs a network or a key, and
the child processes are real, because the point of most of it is what a child inherits.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="the web extra: pip install 'tolquane[web]'")
pytest.importorskip("httpx", reason="the test client needs httpx")

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_server import HELLO, make_settings, wait_for_run, workspace  # noqa: F401

from tolquane.web import supervisor as sup
from tolquane.web.server import (
    ADMIN,
    MEMBER,
    PUBLIC,
    TokenFilter,
    content_security_policy,
    create_app,
    hide_tokens_in_logs,
    role_for,
    token_ok,
)
from tolquane.web.settings import WebSettings, packaged_static
from tolquane.web.store import Store
from tolquane.web.supervisor import LiveRun, Supervisor, child_env, run_command

TOKEN = "s3cr3t-token"

NOISY = '''"""Print more lines than the server keeps events for."""

import tolquane as tq


@tq.source
def numbers():
    """Yield four hundred numbers."""
    yield from range(400)


@tq.sink
def show(x):
    """Print one number."""
    print("line", x, flush=True)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

TELLTALE = '''"""Print whatever the environment says about the keys."""

import os

import tolquane as tq


@tq.source
def one():
    """Yield the one thing this flow is for."""
    yield os.environ.get("ANTHROPIC_API_KEY", "<none>")


@tq.sink
def show(value):
    """Print it."""
    print("key:", value)


def build(source=None):
    start = one if source is None else tq.from_iterable(source)
    return start >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''


@pytest.fixture
def guarded(tmp_path: Path, workspace: Path) -> Iterator[TestClient]:  # noqa: F811
    """A server that was started with ``--token``."""
    with TestClient(create_app(make_settings(tmp_path, workspace, token=TOKEN))) as client:
        yield client


@pytest.fixture
def client(tmp_path: Path, workspace: Path) -> Iterator[TestClient]:  # noqa: F811
    with TestClient(create_app(make_settings(tmp_path, workspace))) as c:
        yield c


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


# ------------------------------------------------------------------------------ the token


def _example(path: str) -> str:
    """One concrete URL for a templated path: the ids do not matter, the 401 does."""
    out = path.replace("{path}", "hello.py")
    while "{" in out:
        start = out.index("{")
        end = out.index("}", start)
        out = out[:start] + "1" + out[end + 1 :]
    return out


def test_every_route_in_the_document_needs_the_token(guarded: TestClient) -> None:
    """The contract is the OpenAPI document, so it is the list to walk."""
    document = guarded.get("/api/openapi.json", headers=auth()).json()
    checked = 0
    for path, methods in document["paths"].items():
        for method in methods:
            answer = guarded.request(method.upper(), _example(path))
            assert answer.status_code == 401, f"{method.upper()} {path} answered without a token"
            assert answer.json()["error"]["type"] == "Unauthorized"
            checked += 1
    assert checked >= 25, "the document lost most of its routes"


def test_the_routes_fastapi_adds_for_itself_need_it_too(guarded: TestClient) -> None:
    """``/api/openapi.json`` and ``/api/docs`` carry no dependency of ours; the wall does."""
    assert guarded.get("/api/openapi.json").status_code == 401
    assert guarded.get("/api/docs").status_code == 401
    assert guarded.get("/api/nothing-here").status_code == 401  # not even a hint of the shape
    assert guarded.get("/api/openapi.json", headers=auth()).status_code == 200
    assert guarded.get("/api/health", params={"token": TOKEN}).status_code == 200


def test_the_websocket_and_the_event_stream_need_it(guarded: TestClient) -> None:
    run = guarded.post("/api/runs", json={"path": "hello.py", "runtime": "sync"}, headers=auth())
    run_id = run.json()["id"]
    for query in ("", "?token=nearly"):
        with (
            pytest.raises(WebSocketDisconnect),
            guarded.websocket_connect(f"/api/runs/{run_id}/events{query}") as socket,
        ):
            socket.receive_json()
    with guarded.websocket_connect(f"/api/runs/{run_id}/events?token={TOKEN}") as socket:
        assert socket.receive_json()["event"] == "start"

    chat = guarded.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert chat.status_code == 401
    assert "text/event-stream" not in chat.headers.get("content-type", "")
    guarded.headers.update(auth())
    wait_for_run(guarded, run_id)


def test_a_token_is_compared_whole_and_in_constant_time(monkeypatch: pytest.MonkeyPatch) -> None:
    from tolquane.web import server as server_module

    calls: list[tuple[bytes, bytes]] = []
    original = server_module.hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        calls.append((a, b))
        return bool(original(a, b))

    monkeypatch.setattr(server_module.hmac, "compare_digest", spy)
    assert token_ok(TOKEN, f"Bearer {TOKEN}", None) is True
    assert token_ok(TOKEN, None, TOKEN) is True
    assert token_ok(TOKEN, "bearer " + TOKEN, None) is True  # the scheme is not case sensitive
    assert token_ok(TOKEN, None, TOKEN[:-1]) is False  # a prefix is not the token
    assert token_ok(TOKEN, None, None) is False
    assert token_ok(TOKEN, "Basic " + TOKEN, None) is False
    assert token_ok(None, None, None) is True  # no token was asked for
    assert calls, "the comparison has to go through hmac.compare_digest"


def test_the_token_never_reaches_the_log() -> None:
    """A socket and a download link carry it in the URL, and access logs write URLs."""
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1", "GET", f"/api/runs/1/trace?token={TOKEN}&x=1", "1.1", 200),
        None,
    )
    assert TokenFilter().filter(record) is True
    line = record.getMessage()
    assert TOKEN not in line
    assert "token=<hidden>" in line
    assert "x=1" in line, "only the token is hidden"


def test_the_filter_is_on_the_logger_that_writes_request_lines() -> None:
    """``create_app`` installs it, once, on the loggers uvicorn writes URLs through."""
    hide_tokens_in_logs()
    hide_tokens_in_logs()
    access = logging.getLogger("uvicorn.access")
    mine = [f for f in access.filters if isinstance(f, TokenFilter)]
    assert len(mine) == 1


def test_static_files_are_served_without_a_token(tmp_path: Path, workspace: Path) -> None:  # noqa: F811
    """The page is what asks the user for the token; it cannot need one to load."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<title>Tolquane</title>")
    (static / "assets" / "app.js").write_text("console.log('hi')")
    settings = make_settings(tmp_path, workspace, token=TOKEN, static_dir=static)
    with TestClient(create_app(settings)) as client:
        assert client.get("/").status_code == 200
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/runs/1").status_code == 200  # a route inside the app
        assert client.get("/api/flows").status_code == 401


# ------------------------------------------------------------------------------ the users


PASSWORD = "a-long-enough-password"


def test_a_session_gets_past_the_token_wall_and_a_stranger_does_not(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
) -> None:
    """With ``--token`` and users, a signed-in person is as good as the token.

    Otherwise a shared server would need two secrets to answer one request, and the
    login page could not be reached to get the second.
    """
    settings = make_settings(tmp_path, workspace, token=TOKEN)
    with Store(settings.db_path) as store:
        store.add_user("ada", PASSWORD, "admin", False)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/flows").status_code == 401
        assert client.get("/api/flows", headers={"Authorization": "Bearer nope"}).status_code == 401
        assert client.get("/api/flows", headers=auth()).status_code == 200
        token = client.post("/api/auth/login", json={"name": "ada", "password": PASSWORD}).json()[
            "token"
        ]
        assert client.get(
            "/api/flows", headers={"Authorization": f"Bearer {token}"}
        ).status_code == (200)


def test_no_answer_ever_carries_a_password_hash(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
) -> None:
    """The hash is in one column and stays there, whichever route asks about a user."""
    settings = make_settings(tmp_path, workspace)
    with Store(settings.db_path) as store:
        store.add_user("ada", PASSWORD, "admin", False)
    with TestClient(create_app(settings)) as client:
        token = client.post("/api/auth/login", json={"name": "ada", "password": PASSWORD}).json()[
            "token"
        ]
        headers = {"Authorization": f"Bearer {token}"}
        for url in ("/api/users", "/api/auth/me", "/api/auth/tokens"):
            body = client.get(url, headers=headers).text
            assert "scrypt$" not in body, url
            assert "password_hash" not in body, url
            assert PASSWORD not in body, url


def test_every_route_in_the_document_is_in_the_role_table(client: TestClient) -> None:
    """The table answers for every path the contract has, and for the ones it has not."""
    document = client.get("/api/openapi.json").json()
    for path, methods in document["paths"].items():
        for method in methods:
            role = role_for(method, _example(path))
            assert role in (PUBLIC, MEMBER, ADMIN), f"{method.upper()} {path}"
            if path.startswith("/api/users"):
                assert role == ADMIN, f"{method.upper()} {path} is not for administrators"
    assert role_for("GET", "/api/nothing-here") == MEMBER, "an unknown path is not a way in"


# -------------------------------------------------------------------------- the workspace


@pytest.mark.parametrize(
    "path",
    [
        "C:\\flows\\hello.py",
        "c:/flows/hello.py",
        "\\\\server\\share\\hello.py",
        "..\\..\\etc\\passwd.py",
        "sub\\..\\..\\out.py",
    ],
)
def test_windows_paths_are_refused(client: TestClient, path: str) -> None:
    """A path written for the other operating system is a path, not a flow name."""
    made = client.post("/api/flows", json={"path": path, "template": "hello"})
    assert made.status_code == 400, f"{path} was accepted as a name to create"
    assert made.json()["error"]["type"] == "BadRequest"
    opened = client.get("/api/flows/" + path.replace("\\", "%5C"))
    assert opened.status_code == 400, f"{path} was accepted as a name to open"


def _link_out(workspace: Path, tmp_path: Path, name: str = "link.py") -> Path:  # noqa: F811
    outside = tmp_path / "outside.py"
    outside.write_text(HELLO)
    link = workspace / name
    link.symlink_to(outside)
    return outside


def test_a_symlink_out_is_refused_for_every_verb(
    client: TestClient,
    workspace: Path,  # noqa: F811
    tmp_path: Path,
) -> None:
    outside = _link_out(workspace, tmp_path)
    for answer in (
        client.get("/api/flows/link.py"),
        client.put("/api/flows/link.py", json={"source": "x = 1\n"}),
        client.delete("/api/flows/link.py"),
        client.post("/api/flows/link.py/rename", json={"path": "moved.py"}),
        client.post("/api/flows/link.py/check"),
        client.post("/api/runs", json={"path": "link.py"}),
    ):
        assert answer.status_code == 400, answer.text
        assert "outside the workspace" in answer.json()["error"]["message"]
    assert outside.read_text() == HELLO, "the file outside was neither written nor removed"
    assert outside.is_file()


def test_a_symlink_out_is_refused_as_a_target(
    client: TestClient,
    workspace: Path,  # noqa: F811
    tmp_path: Path,
) -> None:
    """Creating and renaming resolve their target the way a read resolves its source."""
    (tmp_path / "elsewhere").mkdir()
    (workspace / "away").symlink_to(tmp_path / "elsewhere")
    for answer in (
        client.post("/api/flows", json={"path": "away/new.py"}),
        client.post("/api/flows/hello.py/rename", json={"path": "away/hello.py"}),
        client.post("/api/flows/hello.py/rename", json={"path": "../escaped.py"}),
    ):
        assert answer.status_code == 400, answer.text
        assert (
            "outside the workspace" in answer.json()["error"]["message"]
            or "'..'" in (answer.json()["error"]["message"])
        )
    assert not list((tmp_path / "elsewhere").iterdir())
    assert (workspace / "hello.py").is_file(), "the flow stayed where it was"


def test_a_sidecar_that_points_away_is_refused(
    client: TestClient,
    workspace: Path,  # noqa: F811
    tmp_path: Path,
) -> None:
    """The layout path is derived from the flow path, and it cannot escape either."""
    target = tmp_path / "stolen.json"
    target.write_text('{"version": 1}')
    (workspace / "hello.layout.json").symlink_to(target)
    layout = {"version": 1, "positions": {"stages.0": {"x": 1, "y": 2}}, "samples": []}
    written = client.put("/api/flows/hello.py/layout", json=layout)
    assert written.status_code == 400
    assert "outside the workspace" in written.json()["error"]["message"]
    assert client.get("/api/flows/hello.py").status_code == 400
    assert client.delete("/api/flows/hello.py").status_code == 400
    assert target.read_text() == '{"version": 1}'


def test_a_source_over_the_limit_is_refused(client: TestClient, workspace: Path) -> None:  # noqa: F811
    assert client.get("/api/settings").json()["max_source_bytes"] == 2_000_000
    assert client.put("/api/settings", json={"max_source_bytes": 4096}).status_code == 200

    big = "# " + "x" * 5000 + "\n"
    answer = client.put("/api/flows/hello.py", json={"source": big})
    assert answer.status_code == 413
    assert answer.json()["error"]["type"] == "TooLarge"
    assert "max_source_bytes" in answer.json()["error"]["message"]
    assert (workspace / "hello.py").read_text() == HELLO, "nothing was written"

    assert client.post("/api/flows/parse", json={"source": big}).status_code == 413
    assert client.post("/api/flows", json={"path": "big.py", "template": "hello"}).status_code == (
        201
    ), "a flow under the limit is still fine"
    assert client.put("/api/settings", json={"max_source_bytes": 512}).status_code == 400


def test_the_listing_skips_what_is_not_a_flow(
    client: TestClient,
    workspace: Path,  # noqa: F811
    tmp_path: Path,
) -> None:
    (workspace / ".hidden").mkdir()
    (workspace / ".hidden" / "secret.py").write_text(HELLO)
    (workspace / ".tolquane-web" / "ai").mkdir(parents=True)
    (workspace / ".tolquane-web" / "ai" / "draft.py").write_text(HELLO)
    (workspace / "__pycache__").mkdir()
    (workspace / "__pycache__" / "hello.py").write_text(HELLO)
    _link_out(workspace, tmp_path, "link.py")

    listed = [flow["path"] for flow in client.get("/api/flows").json()["flows"]]
    assert listed == ["hello.py"]


# ----------------------------------------------------------------------------- the children


def test_a_run_does_not_inherit_the_keys(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The server may have a key for the AI panel. A flow is not the AI panel."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-server-only")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-server-only-too")
    (workspace / "telltale.py").write_text(TELLTALE)
    settings = make_settings(tmp_path, workspace, token=TOKEN)
    with TestClient(create_app(settings)) as client:
        client.headers.update(auth())
        started = client.post("/api/runs", json={"path": "telltale.py", "runtime": "sync"})
        run = wait_for_run(client, started.json()["id"])
        log = client.get(f"/api/runs/{run['id']}/log").text
    assert "key: <none>" in log
    assert "sk-server-only" not in log


def test_the_one_shot_children_are_stripped_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Parse, check, draw and optimize import the flow, so they are children too."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-server-only")
    script = "import os; print(os.environ.get('ANTHROPIC_API_KEY', '<none>'))"
    result = run_command([sys.executable, "-c", script], tmp_path, 30.0)
    assert result.ok
    assert result.stdout.strip() == "<none>"


def test_child_env_drops_the_secrets_and_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-a")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-o")
    monkeypatch.setenv("TOLQUANE_SMTP_PASSWORD", "not-a-real-password")
    monkeypatch.setenv("MY_SERVER_TOKEN", TOKEN)
    monkeypatch.setenv("PATH_TO_KEEP", "/usr/bin")
    env = child_env(TOKEN)
    assert "ANTHROPIC_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert "TOLQUANE_SMTP_PASSWORD" not in env, "the mail password is the server's, not a flow's"
    assert "MY_SERVER_TOKEN" not in env, "a variable holding the token goes whatever it is called"
    assert env["PATH_TO_KEEP"] == "/usr/bin"


def test_child_env_puts_the_workspace_and_the_run_back_after_the_stripping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run may be given anything, including a key of its own; it just never inherits ours."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-server-only")
    env = child_env(
        TOKEN,
        workspace={"TZ": "UTC", "GREETING": "workspace"},
        run={"GREETING": "run", "ANTHROPIC_API_KEY": "sk-the-flows-own"},
    )
    assert env["TZ"] == "UTC"
    assert env["GREETING"] == "run", "the run is applied after the workspace"
    assert env["ANTHROPIC_API_KEY"] == "sk-the-flows-own"


# ------------------------------------------------------------------------------- the limits


def test_a_run_that_prints_too_much_keeps_a_bounded_number_of_events(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The events a late client can replay are capped; the log and the report are not."""
    monkeypatch.setattr(sup, "MAX_EVENTS", 50)
    (workspace / "noisy.py").write_text(NOISY)
    with TestClient(create_app(make_settings(tmp_path, workspace))) as client:
        started = client.post("/api/runs", json={"path": "noisy.py", "runtime": "sync"})
        run = wait_for_run(client, started.json()["id"], timeout=60)
        assert run["status"] == "done"
        live = client.app.state.supervisor.get(run["id"])  # type: ignore[attr-defined]
        assert len(live.events) <= 50
        assert live.dropped > 300

        with client.websocket_connect(f"/api/runs/{run['id']}/events") as socket:
            events = [socket.receive_json() for _ in range(len(live.events) + 1)]
        kinds = [event["event"] for event in events]
        assert kinds[0] == "start", "the graph a late client needs is never the one that goes"
        assert kinds[1] == "dropped"
        assert events[1]["count"] == live.dropped
        assert kinds.count("dropped") == 1, "said once, not once per event"
        assert kinds[-1] == "done"

        log = client.get(f"/api/runs/{run['id']}/log").text
        assert log.count("line ") == 400, "the log keeps what the events could not"


def test_old_traces_and_samples_go_at_startup(tmp_path: Path, workspace: Path) -> None:  # noqa: F811
    work = workspace / ".tolquane-web"
    old, new = time.time() - 30 * 86400, time.time()
    for name in ("traces", "samples", "tmp"):
        (work / name).mkdir(parents=True)
        stale = work / name / "run-1.json"
        stale.write_text("{}")
        os.utime(stale, (old, old))
        fresh = work / name / "run-2.json"
        fresh.write_text("{}")
        os.utime(fresh, (new, new))
    (work / "ai" / "abandoned").mkdir(parents=True)
    os.utime(work / "ai" / "abandoned", (old, old))

    with TestClient(create_app(make_settings(tmp_path, workspace))) as client:
        assert client.get("/api/health").json()["ok"] is True
    for name in ("traces", "samples", "tmp"):
        assert not (work / name / "run-1.json").exists(), f"the old {name} file stayed"
        assert (work / name / "run-2.json").is_file(), f"today's {name} file went"
    assert not (work / "ai" / "abandoned").exists()


def test_the_retention_is_a_setting(tmp_path: Path, workspace: Path) -> None:  # noqa: F811
    store = Store(tmp_path / "web.db")
    settings = make_settings(tmp_path, workspace)
    web = WebSettings(store, settings)
    assert web.keep_traces_days == 7
    store.set_setting("keep_traces_days", 1)
    supervisor = Supervisor(workspace, store, web)
    (workspace / ".tolquane-web" / "traces").mkdir(parents=True)
    trace = workspace / ".tolquane-web" / "traces" / "run-1.json"
    trace.write_text("{}")
    os.utime(trace, (time.time() - 2 * 86400,) * 2)
    assert supervisor.sweep() == 1
    assert not trace.exists()
    assert supervisor.sweep() == 0
    store.close()


class Undying:
    """A child that answers ``SIGTERM`` and ``SIGKILL`` with nothing at all."""

    pid = 424242

    def __init__(self) -> None:
        self.signals: list[str] = []

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        self.signals.append("term")

    def kill(self) -> None:
        self.signals.append("kill")

    def wait(self, timeout: float | None = None) -> int:
        raise subprocess.TimeoutExpired("flow", timeout or 0.0)


def test_a_run_that_survives_sigkill_is_reported_as_failed(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
) -> None:
    """Better a run that says it failed than a row that says "running" for ever."""
    store = Store(tmp_path / "web.db")
    settings = make_settings(tmp_path, workspace)
    web = WebSettings(store, settings)
    store.set_setting("cancel_grace", 0.1)
    supervisor = Supervisor(workspace, store, web)
    proc = Undying()
    run = store.add_run("hello.py", "threads", None, "manual")
    live = LiveRun(run.id, "hello.py", proc)  # type: ignore[arg-type]
    supervisor.runs[run.id] = live

    assert supervisor.cancel(run.id) is True
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not live.finished:
        time.sleep(0.05)
    assert live.finished, "the run was left going"
    assert proc.signals == ["term", "kill"]
    ended = store.get_run(run.id)
    assert ended is not None
    assert ended.status == "failed"
    assert "SIGKILL" in (ended.error or "")
    assert str(proc.pid) in (ended.error or "")
    assert supervisor.live_count() == 0, "the slot it held is free again"
    supervisor.shutdown()
    store.close()


# ------------------------------------------------------------------------- what the page gets


def test_a_foreign_origin_gets_no_cors_header(client: TestClient) -> None:
    """There is no CORS middleware, so another site's page cannot read an answer."""
    answer = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert answer.status_code == 200
    assert "access-control-allow-origin" not in {k.lower() for k in answer.headers}
    assert "access-control-allow-credentials" not in {k.lower() for k in answer.headers}
    options = client.options("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in options.headers}


def test_the_page_carries_its_security_headers(tmp_path: Path, workspace: Path) -> None:  # noqa: F811
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text(
        "<html><head><script>window.theme='dark'</script>"
        '<script type="module" src="/assets/app.js"></script></head><body></body></html>'
    )
    settings = make_settings(tmp_path, workspace, static_dir=static)
    with TestClient(create_app(settings)) as client:
        answer = client.get("/")
    assert answer.headers["x-content-type-options"] == "nosniff"
    policy = answer.headers["content-security-policy"]
    assert "default-src 'self'" in policy
    assert "connect-src 'self' ws: wss:" in policy
    assert "frame-ancestors 'none'" in policy
    # Styles are the one exception, and only styles: CodeMirror writes its own.
    assert "style-src 'self' 'unsafe-inline'" in policy
    assert "script-src 'self' 'sha256-" in policy
    assert policy.count("'unsafe-inline'") == 1
    assert "'unsafe-eval'" not in policy


def test_the_policy_allows_the_built_page_it_ships_with() -> None:
    """The inline script Vite leaves in index.html runs by its hash, not by a blanket rule."""
    import base64
    import hashlib
    import re

    index = packaged_static() / "index.html"
    if not index.is_file():
        pytest.skip("the frontend is not built here; the wheel ships one")
    policy = content_security_policy(index)
    inline = re.findall(
        rb"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", index.read_bytes(), re.DOTALL | re.I
    )
    assert inline, "the built page has no inline script; the hash rule can go"
    for body in inline:
        digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
        assert f"'sha256-{digest}'" in policy


def test_the_settings_page_sees_the_new_limits(client: TestClient) -> None:
    """Both live in the store like every other setting, and both are checked."""
    settings = client.get("/api/settings").json()
    assert settings["max_source_bytes"] == 2_000_000
    assert settings["keep_traces_days"] == 7
    assert client.put("/api/settings", json={"keep_traces_days": 0}).json()["keep_traces_days"] == 0
    assert client.put("/api/settings", json={"keep_traces_days": -1}).status_code == 400


def test_every_template_opens_on_the_canvas(client: TestClient) -> None:
    """A new flow must be editable at once: each template parses to a model, not code-only."""
    from tolquane.web.model import CodeOnly, parse_source
    from tolquane.web.server import TEMPLATES

    for name, text in TEMPLATES.items():
        parsed = parse_source(text.format(name="fresh"), "fresh")
        assert not isinstance(parsed, CodeOnly), (name, getattr(parsed, "reason", None))
    for name in TEMPLATES:
        made = client.post("/api/flows", json={"path": f"{name}_flow.py", "template": name})
        assert made.status_code in (200, 201), made.text
        assert made.json()["model"] is not None
        assert made.json()["code_only"] is None


def test_frame_ancestors_can_be_opened_for_a_host(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Space or a portal shows the app in a frame; the policy names who may."""
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><body></body></html>")
    monkeypatch.setenv("TOLQUANE_WEB_FRAME_ANCESTORS", "https://huggingface.co https://*.hf.space")
    settings = make_settings(tmp_path, workspace, static_dir=static)
    with TestClient(create_app(settings)) as client:
        policy = client.get("/").headers["content-security-policy"]
    assert "frame-ancestors https://huggingface.co https://*.hf.space" in policy
    assert "'none'" not in policy.split("frame-ancestors")[1]
