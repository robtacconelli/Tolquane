"""The Tolquane Web server: every route, against a workspace in a temporary directory.

Nothing here needs a network, a key or a browser. Flows are small and run on the sync
runtime; the AI chat replays a recorded conversation; the scheduler is driven by a clock
the test holds. Child processes are real: that is the point of the server.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import time
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

# The server is an extra: without it the suite still runs, it just cannot test this.
pytest.importorskip("fastapi", reason="the web extra: pip install 'tolquane[web]'")
pytest.importorskip("httpx", reason="the test client needs httpx")

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tolquane.ai import ReplayProvider
from tolquane.web.server import create_app
from tolquane.web.settings import AppSettings

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "ai"

CLOCK = datetime(2026, 3, 2, 9, 0, 0).astimezone()
"""A Monday morning. Every schedule preview in these tests is counted from here."""

HELLO = '''"""Double a few numbers."""

import tolquane as tq


@tq.source
def numbers():
    """Yield five numbers."""
    yield from range(1, 6)


@tq.node
def double(x):
    """Double one number."""
    return x * 2


@tq.sink
def show(x):
    """Print one number."""
    print("got", x)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.farm(double, 2) >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

SLOW = '''"""Run until something stops it."""

import time

import tolquane as tq


@tq.source
def forever():
    """Yield a number every 50 milliseconds, for ever."""
    n = 0
    while True:
        time.sleep(0.05)
        n += 1
        yield n


@tq.sink
def show(x):
    """Print one number."""
    print("n", x, flush=True)


def build(source=None):
    start = forever if source is None else tq.from_iterable(source)
    return start >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

BROKEN = HELLO.replace(" >> show", "")  # a farm whose results go nowhere
CODE_ONLY = "import tolquane as tq\n\nVALUE = 1\n"


# ----------------------------------------------------------------------------- fixtures


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "flows"
    ws.mkdir()
    (ws / "hello.py").write_text(HELLO)
    return ws


def make_settings(tmp_path: Path, workspace: Path, **over: Any) -> AppSettings:
    """Settings that touch nothing outside ``tmp_path``: its own database and key file."""
    options: dict[str, Any] = {
        "workspace": workspace,
        "db_path": tmp_path / "web.db",
        "config_path": tmp_path / "web.toml",
        "static_dir": tmp_path / "not-built",
        "scheduler_interval": 60.0,
        "clock": lambda: CLOCK,
    }
    options.update(over)
    return AppSettings(**options)


@pytest.fixture
def settings(tmp_path: Path, workspace: Path) -> AppSettings:
    return make_settings(tmp_path, workspace)


@pytest.fixture
def client(settings: AppSettings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        yield c


def wait_for_run(client: TestClient, run_id: int, timeout: float = 30.0) -> dict[str, Any]:
    """The run once its child process has been reaped."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if not run["live"] and run["ended"]:
            return dict(run)
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not end within {timeout}s")


def read_events(socket: Any, limit: int = 500) -> list[dict[str, Any]]:
    """Every event of a run, until the socket closes after ``done``."""
    events: list[dict[str, Any]] = []
    for _ in range(limit):
        try:
            event = socket.receive_json()
        except WebSocketDisconnect:
            break
        events.append(event)
        if event.get("event") == "done":
            break
    return events


def sse(response: Any) -> list[dict[str, Any]]:
    """The events of a ``text/event-stream`` body."""
    return [
        json.loads(line[len("data: ") :])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


# ----------------------------------------------------------------------------- health


def test_health_and_openapi(client: TestClient) -> None:
    health = client.get("/api/health").json()
    assert health["ok"] is True
    assert health["runs_live"] == 0
    assert health["scheduler"] is True
    assert health["workspace"].endswith("flows")

    document = client.get("/api/openapi.json").json()
    operations = {
        route["operationId"] for path in document["paths"].values() for route in path.values()
    }
    # The frontend's client is generated from these names, so they have to read well.
    assert {"listFlows", "getFlow", "saveFlow", "startRun", "cancelRun", "listSchedules"} <= (
        operations
    )
    assert operations >= {"getSettings", "updateSettings", "aiChat", "getHealth", "optimizeFlow"}


# ----------------------------------------------------------------------------- flows


def test_flow_listing_and_crud(client: TestClient, workspace: Path) -> None:
    listed = client.get("/api/flows").json()
    assert [flow["path"] for flow in listed["flows"]] == ["hello.py"]
    assert listed["flows"][0]["name"] == "hello"
    assert listed["flows"][0]["has_layout"] is False
    assert listed["flows"][0]["last_run"] is None

    made = client.post("/api/flows", json={"path": "sub/new.py", "template": "hello"})
    assert made.status_code == 201, made.text
    assert made.json()["path"] == "sub/new.py"
    assert made.json()["model"]["nodes"][0]["id"] == "numbers"
    assert (workspace / "sub" / "new.py").is_file()
    assert client.post("/api/flows", json={"path": "sub/new.py"}).status_code == 409
    # The frontend addresses a flow with encodeURIComponent, so a nested path arrives escaped.
    assert client.get("/api/flows/sub%2Fnew.py").json()["path"] == "sub/new.py"
    assert client.post("/api/flows", json={"path": "x.py", "template": "nope"}).status_code == 400

    opened = client.get("/api/flows/hello.py").json()
    assert opened["code_only"] is None
    assert opened["model"]["name"] == "hello"
    assert next(node["name"] for node in opened["graph"]["nodes"]) == "numbers"
    assert opened["layout"] is None

    saved = client.put(
        "/api/flows/hello.py",
        json={"source": HELLO.replace("x * 2", "x * 3"), "modified": opened["modified"]},
    )
    assert saved.status_code == 200
    assert "x * 3" in saved.json()["source"]
    stale = client.put(
        "/api/flows/hello.py", json={"source": HELLO, "modified": opened["modified"]}
    )
    assert stale.status_code == 409
    assert "x * 3" in stale.json()["error"]["detail"]["source"]

    layout = {
        "version": 1,
        "positions": {"stages.0": {"x": 10, "y": 20}},
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "samples": [{"name": "three", "items": [1, 2, 3]}],
    }
    assert client.put("/api/flows/hello.py/layout", json=layout).json() == {"ok": True}
    assert (workspace / "hello.layout.json").is_file()
    assert client.get("/api/flows/hello.py").json()["layout"]["positions"]["stages.0"]["x"] == 10
    assert client.get("/api/flows").json()["flows"][0]["has_layout"] is True

    renamed = client.post("/api/flows/hello.py/rename", json={"path": "greet.py"})
    assert renamed.status_code == 200
    assert renamed.json()["path"] == "greet.py"
    assert (workspace / "greet.layout.json").is_file()
    assert not (workspace / "hello.py").exists()

    assert client.delete("/api/flows/greet.py").json() == {"ok": True}
    assert not (workspace / "greet.py").exists()
    assert not (workspace / "greet.layout.json").exists()
    assert client.get("/api/flows/greet.py").status_code == 404


def test_code_only_file_still_opens(client: TestClient, workspace: Path) -> None:
    (workspace / "odd.py").write_text(CODE_ONLY)
    opened = client.get("/api/flows/odd.py").json()
    assert opened["model"] is None
    assert "build()" in opened["code_only"]["reason"]
    assert opened["source"] == CODE_ONLY

    (workspace / "broken.py").write_text("def build(:\n")
    broken = client.get("/api/flows/broken.py").json()
    assert broken["model"] is None
    assert "does not parse" in broken["code_only"]["reason"]


def test_parse_generate_and_the_tools(client: TestClient, workspace: Path) -> None:
    parsed = client.post("/api/flows/parse", json={"source": HELLO, "name": "hello"}).json()
    assert parsed["code_only"] is None
    assert [node["id"] for node in parsed["model"]["nodes"]] == ["numbers", "double", "show"]
    assert len(parsed["graph"]["nodes"]) == 6
    assert not list((workspace / ".tolquane-web" / "tmp").glob("*")), "the scratch file is gone"

    generated = client.post("/api/flows/generate", json={"model": parsed["model"]}).json()
    assert "def build(source=None):" in generated["source"]
    assert "tq.farm(double, 2)" in generated["source"]
    assert client.post("/api/flows/generate", json={"model": {"flow": 3}}).status_code == 400

    checked = client.post("/api/flows/hello.py/check").json()
    assert checked == {"ok": True, "nodes": 6, "edges": 6, "imports": []}
    explained = client.post("/api/flows/hello.py/explain").json()["text"]
    assert "double.emitter" in explained
    assert client.post("/api/flows/hello.py/draw").json()["mermaid"].startswith("flowchart LR")

    optimized = client.post("/api/flows/hello.py/optimize", json={"all2all": False}).json()
    assert any("remove_collector" in note for note in optimized["notes"])
    assert len(optimized["graph"]["nodes"]) == 5  # the collector is gone
    assert optimized["source"] is None  # the rewrite has no Python form yet


def test_a_flow_that_does_not_validate_answers_with_the_fix(
    client: TestClient, workspace: Path
) -> None:
    (workspace / "broken.py").write_text(BROKEN)
    answer = client.post("/api/flows/broken.py/check")
    assert answer.status_code == 400
    error = answer.json()["error"]
    assert error["type"] == "GraphError"
    assert "results go nowhere" in error["message"]
    assert "add a stage after it" in error["message"]


@pytest.mark.parametrize(
    "path",
    ["%2e%2e%2f%2e%2e%2fetc%2fpasswd.py", "%2Fetc%2Fpasswd.py", "/etc/passwd.py", "notes.txt"],
)
def test_paths_that_leave_the_workspace_are_refused(client: TestClient, path: str) -> None:
    answer = client.get(f"/api/flows/{path}")
    assert answer.status_code == 400
    assert answer.json()["error"]["type"] == "BadRequest"


def test_a_symlink_out_of_the_workspace_is_refused(
    client: TestClient, workspace: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.py"
    outside.write_text(HELLO)
    (workspace / "link.py").symlink_to(outside)
    answer = client.get("/api/flows/link.py")
    assert answer.status_code == 400
    assert "outside the workspace" in answer.json()["error"]["message"]


# ----------------------------------------------------------------------------- runs


def test_a_run_streams_its_events_live_and_replays_them_late(client: TestClient) -> None:
    started = client.post("/api/runs", json={"path": "hello.py", "runtime": "sync", "tap": 3})
    assert started.status_code == 200, started.text
    run = started.json()
    assert run["status"] == "running"
    assert run["live"] is True
    assert run["trigger"] == "manual"

    with client.websocket_connect(f"/api/runs/{run['id']}/events") as socket:
        events = read_events(socket)
    kinds = [event["event"] for event in events]
    assert kinds[0] == "start"
    assert kinds[-1] == "done"
    assert events[-1]["status"] == "done"
    assert "progress" in kinds
    assert "report" in kinds
    printed = "".join(e["text"] for e in events if e["event"] == "stdout")
    assert sorted(int(line.split()[1]) for line in printed.splitlines()) == [2, 4, 6, 8, 10]
    assert len(events[0]["graph"]["nodes"]) == 6

    ended = wait_for_run(client, run["id"])
    assert ended["status"] == "done"
    assert ended["report"]["runtime"] == "sync"
    assert ended["error"] is None
    assert client.get(f"/api/runs/{run['id']}/log").text.count("got") == 5

    # A client that arrives after the end still sees the whole run.
    with client.websocket_connect(f"/api/runs/{run['id']}/events") as socket:
        replayed = read_events(socket)
    assert [event["event"] for event in replayed] == kinds

    listed = client.get("/api/runs", params={"flow": "hello.py"}).json()["runs"]
    assert [r["id"] for r in listed] == [run["id"]]
    assert listed[0]["log"] == ""  # the list leaves the log out; ask for the run itself
    assert client.get("/api/flows").json()["flows"][0]["last_run"]["status"] == "done"
    assert client.get("/api/runs/999").status_code == 404
    assert client.post("/api/runs", json={"path": "nope.py"}).status_code == 404


def test_a_run_with_a_sample_and_a_trace(client: TestClient, workspace: Path) -> None:
    layout = {"positions": {}, "samples": [{"name": "three", "items": [1, 2, 3]}]}
    client.put("/api/flows/hello.py/layout", json=layout)
    started = client.post(
        "/api/runs",
        json={"path": "hello.py", "runtime": "sync", "sample": "three", "trace": True},
    )
    assert started.status_code == 200, started.text
    run = wait_for_run(client, started.json()["id"])
    assert run["status"] == "done"
    assert run["sample"] == "three"
    log = client.get(f"/api/runs/{run['id']}/log").text
    assert sorted(int(line.split()[1]) for line in log.splitlines()) == [2, 4, 6]

    trace = client.get(f"/api/runs/{run['id']}/trace")
    assert trace.status_code == 200
    assert "traceEvents" in trace.json()
    assert not list((workspace / ".tolquane-web" / "samples").glob("*")), "the sample is cleaned up"

    missing = client.post("/api/runs", json={"path": "hello.py", "sample": "nope"})
    assert missing.status_code == 400
    assert "no sample called" in missing.json()["error"]["message"]

    plain = wait_for_run(client, client.post("/api/runs", json={"path": "hello.py"}).json()["id"])
    assert client.get(f"/api/runs/{plain['id']}/trace").status_code == 404


def test_a_failing_flow_leaves_the_server_healthy(client: TestClient, workspace: Path) -> None:
    (workspace / "boom.py").write_text(HELLO.replace("return x * 2", "raise ValueError('boom')"))
    started = client.post("/api/runs", json={"path": "boom.py", "runtime": "sync"})
    run = wait_for_run(client, started.json()["id"])
    assert run["status"] == "failed"
    assert "boom" in run["error"]
    assert "ValueError" in client.get(f"/api/runs/{run['id']}/log").text
    health = client.get("/api/health").json()
    assert health["ok"] is True
    assert health["runs_live"] == 0


def test_cancel_and_the_concurrency_limit(client: TestClient, workspace: Path) -> None:
    (workspace / "slow.py").write_text(SLOW)
    assert client.put("/api/settings", json={"max_concurrent_runs": 1}).status_code == 200
    first = client.post("/api/runs", json={"path": "slow.py"}).json()
    second = client.post("/api/runs", json={"path": "slow.py"})
    assert second.status_code == 429
    assert "max_concurrent_runs" in second.json()["error"]["message"]

    cancelled = client.post(f"/api/runs/{first['id']}/cancel")
    assert cancelled.status_code == 200
    run = wait_for_run(client, first["id"])
    assert run["status"] == "cancelled"
    assert client.get("/api/health").json()["runs_live"] == 0
    # Cancelling a run that is over is not an error; it comes back as it stands.
    assert client.post(f"/api/runs/{first['id']}/cancel").json()["status"] == "cancelled"
    assert client.post("/api/runs", json={"path": "slow.py"}).status_code == 200


def test_every_child_is_killed_when_the_server_stops(tmp_path: Path, workspace: Path) -> None:
    (workspace / "slow.py").write_text(SLOW)
    app = create_app(make_settings(tmp_path, workspace))
    with TestClient(app) as client:
        run = client.post("/api/runs", json={"path": "slow.py"}).json()
        live = app.state.supervisor.get(run["id"])
        assert live.proc.poll() is None
    assert live.proc.poll() is not None, "the lifespan leaves no orphan"
    assert live.status == "cancelled"


def test_the_websocket_of_an_unknown_run(client: TestClient) -> None:
    with client.websocket_connect("/api/runs/404/events") as socket:
        first = socket.receive_json()
    assert first["type"] == "NotFound"


# ----------------------------------------------------------------------------- schedules


def test_schedules_including_preview_and_run_now(client: TestClient) -> None:
    preview = client.post("/api/schedules/preview", json={"cron": "*/15 8-9 * * mon-fri"}).json()
    assert preview["description"].startswith("every 15 minutes")
    assert len(preview["next_five"]) == 5
    assert preview["next_five"][0] == (CLOCK + timedelta(minutes=15)).isoformat()
    assert client.post("/api/schedules/preview", json={"cron": "nonsense"}).status_code == 400

    made = client.post("/api/schedules", json={"flow": "hello.py", "cron": "*/5 * * * *"})
    assert made.status_code == 201, made.text
    schedule = made.json()
    assert schedule["enabled"] is True
    assert schedule["runtime"] == "threads"
    assert schedule["description"] == "every 5 minutes"
    bad_cron = client.post("/api/schedules", json={"flow": "hello.py", "cron": "77 * * *"})
    assert bad_cron.status_code == 400
    assert client.post(
        "/api/schedules", json={"flow": "x.py", "cron": "* * * * *"}
    ).status_code == (404)

    listed = client.get("/api/schedules", params={"flow": "hello.py"}).json()["schedules"]
    assert [s["id"] for s in listed] == [schedule["id"]]

    changed = client.put(f"/api/schedules/{schedule['id']}", json={"runtime": "sync"}).json()
    assert changed["runtime"] == "sync"
    assert client.put(f"/api/schedules/{schedule['id']}", json={}).status_code == 400

    fired = client.post(f"/api/schedules/{schedule['id']}/run")
    assert fired.status_code == 200, fired.text
    run = fired.json()
    assert run["trigger"] == f"schedule:{schedule['id']}"
    assert run["runtime"] == "sync"
    ended = wait_for_run(client, run["id"])
    assert ended["status"] == "done"
    after = client.get("/api/schedules").json()["schedules"][0]
    assert after["last_run"] == run["id"]
    assert after["last_status"] == "done"

    assert client.delete(f"/api/schedules/{schedule['id']}").json() == {"ok": True}
    assert client.get("/api/schedules").json()["schedules"] == []
    assert client.delete(f"/api/schedules/{schedule['id']}").status_code == 404


def test_the_scheduler_fires_a_due_schedule_through_the_supervisor(
    client: TestClient, settings: AppSettings
) -> None:
    scheduler = client.app.state.scheduler  # type: ignore[attr-defined]
    made = client.post("/api/schedules", json={"flow": "hello.py", "cron": "*/5 * * * *"}).json()
    assert scheduler.tick(now=CLOCK) == 0  # the first pass only writes the next time
    assert client.get("/api/schedules").json()["schedules"][0]["next_run"] is not None
    assert scheduler.tick(now=CLOCK) == 0  # not due yet, and not fired twice

    assert scheduler.tick(now=CLOCK + timedelta(minutes=10)) == 1
    runs = client.get("/api/runs").json()["runs"]
    assert [run["trigger"] for run in runs] == [f"schedule:{made['id']}"]
    assert wait_for_run(client, runs[0]["id"])["status"] == "done"


# ----------------------------------------------------------------------------- settings


def test_settings_round_trip_and_keys(client: TestClient, tmp_path: Path) -> None:
    current = client.get("/api/settings").json()
    assert current["default_runtime"] == "threads"
    assert current["default_batch"] == 32
    assert current["exec_timeout"] == 30
    assert current["max_concurrent_runs"] == 4
    assert current["cancel_grace"] == 10
    assert current["theme"] == "dark"
    assert current["ai"] == {
        "provider": "anthropic",
        "model": None,
        "has_anthropic_key": False,
        "has_openai_key": False,
    }
    assert current["server"] == {"host": "127.0.0.1", "port": 8765, "token_set": False}

    changed = client.put(
        "/api/settings",
        json={
            "theme": "light",
            "default_batch": 64,
            "ai": {"provider": "openai", "model": "gpt-5.5", "anthropic_key": "sk-not-a-real-key"},
        },
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["theme"] == "light"
    assert body["default_batch"] == 64
    assert body["ai"]["provider"] == "openai"
    assert body["ai"]["has_anthropic_key"] is True
    assert body["ai"]["has_openai_key"] is False
    assert "sk-not-a-real-key" not in changed.text, "a key is never echoed"

    key_file = tmp_path / "web.toml"
    assert "sk-not-a-real-key" in key_file.read_text()
    assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
    assert client.get("/api/settings").json()["ai"]["has_anthropic_key"] is True

    forgotten = client.put("/api/settings", json={"ai": {"anthropic_key": None}})
    assert forgotten.json()["ai"]["has_anthropic_key"] is False
    assert "sk-not-a-real-key" not in key_file.read_text()

    # The contract writes the keys flat; the settings page sends the nested shape it was
    # given by GET. Both are the same request.
    flat = client.put(
        "/api/settings", json={"ai.provider": "anthropic", "ai.openai_key": "sk-also-not-real"}
    )
    assert flat.json()["ai"] == {
        "provider": "anthropic",
        "model": "gpt-5.5",
        "has_anthropic_key": False,
        "has_openai_key": True,
    }
    assert "sk-also-not-real" not in flat.text
    client.put("/api/settings", json={"ai": {"openai_key": None}})

    bad = client.put("/api/settings", json={"default_runtime": "magic"})
    assert bad.status_code == 400
    assert "one of threads, processes, sync" in bad.json()["error"]["message"]
    unknown = client.put("/api/settings", json={"colour": "blue"})
    assert unknown.status_code == 400
    assert "unknown setting(s) colour" in unknown.json()["error"]["message"]
    assert client.get("/api/settings").json()["theme"] == "light"


def test_a_key_in_the_environment_counts_as_set(
    tmp_path: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "from-the-shell")
    with TestClient(create_app(make_settings(tmp_path, workspace))) as client:
        assert client.get("/api/settings").json()["ai"]["has_openai_key"] is True


def test_settings_change_what_a_run_does(client: TestClient) -> None:
    client.put("/api/settings", json={"default_runtime": "sync"})
    run = client.post("/api/runs", json={"path": "hello.py"}).json()
    assert run["runtime"] == "sync"
    assert wait_for_run(client, run["id"])["report"]["runtime"] == "sync"


# ----------------------------------------------------------------------------- the token


def test_the_token_is_asked_for_everywhere(tmp_path: Path, workspace: Path) -> None:
    settings = make_settings(tmp_path, workspace, token="s3cr3t")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/flows").status_code == 401
        assert client.get("/api/health").status_code == 401
        assert client.get("/api/flows", headers={"Authorization": "Bearer wrong"}).status_code == (
            401
        )
        assert client.get("/api/flows").json()["error"]["type"] == "Unauthorized"

        auth = {"Authorization": "Bearer s3cr3t"}
        assert client.get("/api/flows", headers=auth).status_code == 200
        assert client.get("/api/settings", headers=auth).json()["server"]["token_set"] is True
        run = client.post("/api/runs", json={"path": "hello.py"}, headers=auth).json()

        with (
            pytest.raises(WebSocketDisconnect),
            client.websocket_connect(f"/api/runs/{run['id']}/events?token=wrong") as socket,
        ):
            socket.receive_json()
        with client.websocket_connect(f"/api/runs/{run['id']}/events?token=s3cr3t") as socket:
            assert read_events(socket)[-1]["event"] == "done"


# ----------------------------------------------------------------------------- the AI


def test_chat_streams_the_builder_and_leaves_the_open_file_alone(
    tmp_path: Path, workspace: Path
) -> None:
    def factory(provider: str, model: str | None, key: str | None) -> ReplayProvider:
        assert provider == "anthropic"
        return ReplayProvider(FIXTURES / "square_sum_anthropic.json")

    settings = make_settings(tmp_path, workspace, provider_factory=factory)
    before = (workspace / "hello.py").read_text()
    with TestClient(create_app(settings)) as client:
        answer = client.post(
            "/api/ai/chat",
            json={
                "path": "hello.py",
                "messages": [
                    {"role": "user", "content": "make it square"},
                    {"role": "assistant", "content": "sure"},
                    {"role": "user", "content": "and sum the even ones"},
                ],
            },
        )
        assert answer.status_code == 200
        assert answer.headers["content-type"].startswith("text/event-stream")
        events = sse(answer)

    kinds = [event["type"] for event in events]
    assert "text" in kinds
    assert kinds[-1] == "done"
    tools = [event for event in events if event["type"] == "tool"]
    assert {tool["name"] for tool in tools} == {"write_flow", "check_flow", "run_flow"}
    assert {tool["status"] for tool in tools} == {"started", "done"}
    written = next(event for event in events if event["type"] == "flow")
    assert "def build(source=None)" in written["source"]
    assert written["model"]["name"] == "flow"
    assert written["graph"]["nodes"]
    assert events[-1]["ok"] is True

    assert (workspace / "hello.py").read_text() == before, "the open file is the client's to write"
    assert not list((workspace / ".tolquane-web" / "ai").glob("*")), "the scratch is cleaned up"


def test_chat_says_what_is_missing_instead_of_failing(
    tmp_path: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(create_app(make_settings(tmp_path, workspace))) as client:
        events = sse(
            client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]})
        )
    assert events[-1]["type"] == "error"
    assert "no anthropic key" in events[-1]["message"]


# ----------------------------------------------------------------------------- the app


def test_the_frontend_is_served_with_a_single_page_fallback(
    tmp_path: Path, workspace: Path
) -> None:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<title>Tolquane</title>")
    (static / "assets" / "app.js").write_text("console.log('hi')")
    settings = make_settings(tmp_path, workspace, static_dir=static)
    with TestClient(create_app(settings)) as client:
        assert client.get("/").text == "<title>Tolquane</title>"
        assert client.get("/runs/12").text == "<title>Tolquane</title>"  # a route inside the app
        assert client.get("/assets/app.js").text == "console.log('hi')"
        assert client.get("/api/nope").status_code == 404
        assert client.get("/api/nope").json()["error"]["type"] == "NotFound"


def test_without_a_build_the_api_still_works(client: TestClient) -> None:
    answer = client.get("/")
    assert answer.status_code == 200
    assert "not built" in answer.json()["message"]
    assert answer.json()["api"] == "/api"
    assert client.get("/api/health").json()["ok"] is True


def test_the_workspace_has_to_exist(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="not a directory"):
        create_app(make_settings(tmp_path, tmp_path / "nowhere"))


# ----------------------------------------------------------------------------- the CLI


def _web(*args: str, cwd: Path, home: Path) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
    env["TOLQUANE_HOME"] = str(home)
    return subprocess.run(
        [sys.executable, "-m", "tolquane", "web", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
        timeout=120,
    )


def test_tolquane_web_check(tmp_path: Path, workspace: Path) -> None:
    done = _web("--check", "--no-browser", cwd=workspace, home=tmp_path / "home")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "ok, workspace" in done.stdout
    assert str(workspace) in done.stdout
    assert (tmp_path / "home" / "web.db").is_file()


def test_tolquane_web_refuses_a_public_address_without_a_token(
    tmp_path: Path, workspace: Path
) -> None:
    refused = _web("--check", "--host", "0.0.0.0", cwd=workspace, home=tmp_path / "home")
    assert refused.returncode == 2
    assert "--token" in refused.stderr
    fine = _web(
        "--check", "--host", "0.0.0.0", "--token", "abc", cwd=workspace, home=tmp_path / "home"
    )
    assert fine.returncode == 0, fine.stdout + fine.stderr
