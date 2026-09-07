"""Schedule outcomes: the retry chain, the two channels, and what is recorded.

The webhook end of it is a real HTTP server on a free port, so the JSON that arrives is
the JSON the contract asks for and nothing is asserted about a call that was never made.
The email end is a fake ``smtplib.SMTP`` that records the message it was given. The retry
chain is driven twice: once as pure logic, with the delay collapsed and runs that are
rows rather than processes, and once end to end through the server with a flow that
really fails and a delay of nothing.
"""

from __future__ import annotations

import json
import smtplib
import socketserver
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi", reason="the web extra: pip install 'tolquane[web]'")
pytest.importorskip("httpx", reason="the test client needs httpx")

from fastapi.testclient import TestClient
from test_server import make_settings, wait_for_run, workspace  # noqa: F401

from tolquane.web.notify import Notifier, Outcome, Outcomes, attempt_of, base_url, message_of
from tolquane.web.server import create_app
from tolquane.web.settings import AppSettings, WebSettings
from tolquane.web.store import Store

FAILS = '''"""A flow that always fails."""

import tolquane as tq


@tq.source
def numbers():
    """Yield two numbers."""
    yield from range(2)


@tq.sink
def explode(n):
    """Fail on the first item."""
    raise RuntimeError("this flow never works")


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> explode


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''


# ------------------------------------------------------------------------------ the ends


class _QuietServer(HTTPServer):
    """HTTPServer without the reverse DNS lookup of server_bind, which stalls on macOS."""

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.socket.getsockname()[:2]
        self.server_name = host
        self.server_port = port


class Receiver:
    """A webhook nobody has to mock: one HTTP server, on a free port, keeping the bodies."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []
        self.codes: list[int] = []
        self.lock = threading.Lock()
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # the name BaseHTTPRequestHandler dispatches to
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                with receiver.lock:
                    receiver.bodies.append(json.loads(body))
                    code = receiver.codes.pop(0) if receiver.codes else 200
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args: Any) -> None:
                pass

        self.server = _QuietServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address[0], self.server.server_address[1]
        return f"http://{host}:{port}/hook"

    def waited(self, count: int = 1, timeout: float = 20.0) -> list[dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.bodies) >= count:
                    return list(self.bodies)
            time.sleep(0.02)
        raise AssertionError(f"the webhook was called {len(self.bodies)} times, not {count}")


@pytest.fixture
def webhook() -> Iterator[Receiver]:
    receiver = Receiver()
    receiver.thread.start()
    try:
        yield receiver
    finally:
        receiver.server.shutdown()
        receiver.server.server_close()


class FakeSMTP:
    """What ``smtplib.SMTP`` does, as far as this module is concerned."""

    made: list[FakeSMTP] = []

    def __init__(self, host: str, port: int, timeout: float | None = None) -> None:
        self.host, self.port, self.timeout = host, port, timeout
        self.started = False
        self.credentials: tuple[str, str] | None = None
        self.sent: list[Any] = []
        self.closed = False
        FakeSMTP.made.append(self)

    def starttls(self) -> None:
        self.started = True

    def login(self, username: str, password: str) -> None:
        self.credentials = (username, password)

    def send_message(self, message: Any) -> None:
        self.sent.append(message)

    def quit(self) -> None:
        self.closed = True


@pytest.fixture
def smtp(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[FakeSMTP]]:
    FakeSMTP.made = []
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    yield FakeSMTP
    FakeSMTP.made = []


@pytest.fixture
def settings(tmp_path: Path, workspace: Path) -> AppSettings:  # noqa: F811
    (workspace / "fails.py").write_text(FAILS)
    return make_settings(tmp_path, workspace)


@pytest.fixture
def client(settings: AppSettings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as made:
        # The one retry of a webhook waits half a minute in production; nobody waits here.
        made.app.state.notifier.retry_after = 0.0  # type: ignore[attr-defined]
        yield made


def notifications_of(
    client: TestClient, run_id: int, count: int = 1, timeout: float = 10.0
) -> list[dict[str, Any]]:
    """The rows for a run, once they are there: the delivery is on a thread of its own,
    so the message can arrive a moment before the row that says it did."""
    deadline = time.monotonic() + timeout
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        rows = client.get(f"/api/runs/{run_id}/notifications").json()["notifications"]
        if len(rows) >= count:
            return rows
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} recorded {len(rows)} notifications, not {count}")


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    with Store(tmp_path / "outcomes.db") as opened:
        yield opened


@pytest.fixture
def web(store: Store, tmp_path: Path, workspace: Path) -> WebSettings:  # noqa: F811
    app = AppSettings(
        workspace=workspace, db_path=tmp_path / "outcomes.db", config_path=tmp_path / "web.toml"
    )
    return WebSettings(store, app)


# --------------------------------------------------------------------------- the message


def test_the_message_carries_the_facts_of_the_contract(store: Store, web: WebSettings) -> None:
    run = store.add_run("hello.py", "sync", trigger="schedule:1", params={"n": 1})
    ended = store.finish_run(
        run.id, "failed", {"busiest": ["double"], "elapsed": 0.2}, "line\n" * 10, None, "it broke"
    )
    schedule = store.add_schedule("hello.py", "@daily")
    body = message_of(Outcome("failed", ended, schedule, attempts=3), "http://127.0.0.1:8765")
    assert body["event"] == "failed"
    assert body["status"] == "failed"
    assert body["attempts"] == 3
    assert body["flow"] == "hello.py"
    assert body["schedule"] == {"id": schedule.id, "cron": "@daily"}
    assert body["run"]["id"] == run.id
    assert body["run"]["params"] == {"n": 1}
    assert body["busiest"] == ["double"]
    assert body["error"] == "it broke"
    assert body["log_tail"].endswith("line\n")
    assert body["url"] == f"http://127.0.0.1:8765/runs/{run.id}"
    assert json.dumps(body), "the whole message has to be JSON"


@pytest.mark.parametrize(
    ("host", "port", "wanted"),
    [
        ("127.0.0.1", 8765, "http://127.0.0.1:8765"),
        ("0.0.0.0", 9000, "http://127.0.0.1:9000"),
        ("example.test", 80, "http://example.test:80"),
    ],
)
def test_the_link_points_at_something_reachable(host: str, port: int, wanted: str) -> None:
    assert base_url(host, port) == wanted


@pytest.mark.parametrize(
    ("trigger", "wanted"),
    [
        ("schedule:7", (7, 1)),
        ("retry:7:2", (7, 2)),
        ("retry:7:0", (7, 1)),
        ("manual", None),
        ("api", None),
        ("schedule:not-a-number", None),
    ],
)
def test_a_trigger_says_whose_chain_a_run_is_in(trigger: str, wanted: Any) -> None:
    assert attempt_of(trigger) == wanted


# --------------------------------------------------------------------------- delivery


def test_a_webhook_is_posted_and_recorded(
    store: Store, web: WebSettings, webhook: Receiver
) -> None:
    notifier = Notifier(store, web, url_base="http://127.0.0.1:8765")
    run = store.finish_run(store.add_run("hello.py", "sync").id, "failed", None, "", None, "no")
    schedule = store.add_schedule(
        "hello.py", "@daily", notify={"events": ["failed"], "webhook": webhook.url}
    )
    results = notifier.deliver(Outcome("failed", run, schedule, attempts=1))
    assert [result.to_dict() for result in results] == [
        {"channel": "webhook", "target": webhook.url, "status": "sent", "error": None}
    ]
    assert webhook.waited(1)[0]["status"] == "failed"
    rows = [row.to_dict() for row in store.list_notifications(run_id=run.id)]
    assert len(rows) == 1
    assert rows[0]["channel"] == "webhook"
    assert rows[0]["status"] == "sent"
    assert rows[0]["schedule_id"] == schedule.id


def test_a_webhook_that_fails_is_tried_once_more_and_both_tries_are_recorded(
    store: Store, web: WebSettings, webhook: Receiver
) -> None:
    notifier = Notifier(store, web, retry_after=0.0)
    webhook.codes.append(500)  # the first POST is refused, the second is not
    run = store.finish_run(store.add_run("hello.py", "sync").id, "failed", None, "", None, None)
    schedule = store.add_schedule("hello.py", "@daily", notify={"webhook": webhook.url})
    results = notifier.deliver(Outcome("failed", run, schedule))
    assert results[0].status == "sent"
    assert len(webhook.waited(2)) == 2
    rows = [row.to_dict() for row in store.list_notifications(run_id=run.id)]
    assert [row["status"] for row in rows] == ["failed", "sent"]
    assert "500" in rows[0]["error"]


def test_a_webhook_nobody_answers_is_recorded_as_failed(store: Store, web: WebSettings) -> None:
    notifier = Notifier(store, web, timeout=1.0, retry_after=0.0)
    run = store.finish_run(store.add_run("hello.py", "sync").id, "failed", None, "", None, None)
    # Port 1 on loopback: nothing is listening, and nothing is going to start.
    schedule = store.add_schedule("hello.py", "@daily", notify={"webhook": "http://127.0.0.1:1/x"})
    results = notifier.deliver(Outcome("failed", run, schedule))
    assert results[0].status == "failed"
    assert results[0].error
    assert [row.status for row in store.list_notifications(run_id=run.id)] == ["failed", "failed"]


def test_an_email_goes_through_smtplib_with_starttls_and_a_password(
    store: Store, web: WebSettings, smtp: type[FakeSMTP]
) -> None:
    web.update(
        {
            "notifications": {
                "smtp": {
                    "host": "mail.example.test",
                    "port": 2525,
                    "username": "robot",
                    "from": "tolquane@example.test",
                    "starttls": True,
                },
                "smtp_password": "not-a-real-password",
            }
        }
    )
    notifier = Notifier(store, web)
    run = store.finish_run(
        store.add_run("hello.py", "sync").id, "failed", None, "the log\n", None, "it broke"
    )
    schedule = store.add_schedule(
        "hello.py", "@daily", notify={"events": ["failed"], "emails": ["ada@example.test"]}
    )
    results = notifier.deliver(Outcome("failed", run, schedule, attempts=2))
    assert [result.status for result in results] == ["sent"]
    assert len(smtp.made) == 1
    server = smtp.made[0]
    assert (server.host, server.port) == ("mail.example.test", 2525)
    assert server.started is True
    assert server.credentials == ("robot", "not-a-real-password")
    assert server.closed is True
    message = server.sent[0]
    assert message["Subject"] == "[Tolquane] hello.py: failed"
    assert message["To"] == "ada@example.test"
    assert message["From"] == "tolquane@example.test"
    text = message.get_content()
    assert "after 2 attempt(s)" in text
    assert "it broke" in text
    assert "the log" in text
    # And the password is nowhere near the database.
    assert "not-a-real-password" not in json.dumps(store.settings())
    assert web.as_dict()["notifications"]["has_smtp_password"] is True


def test_an_email_without_smtp_settings_is_recorded_as_failed(
    store: Store, web: WebSettings
) -> None:
    notifier = Notifier(store, web)
    run = store.finish_run(store.add_run("hello.py", "sync").id, "done", None, "", None, None)
    schedule = store.add_schedule("hello.py", "@daily", notify={"emails": ["ada@example.test"]})
    results = notifier.deliver(Outcome("done", run, schedule))
    assert results[0].status == "failed"
    assert "no SMTP settings" in (results[0].error or "")


def test_the_default_webhook_is_used_when_a_schedule_names_none(
    store: Store, web: WebSettings, webhook: Receiver
) -> None:
    web.update({"notifications": {"webhook_default": webhook.url}})
    notifier = Notifier(store, web)
    run = store.finish_run(store.add_run("hello.py", "sync").id, "done", None, "", None, None)
    schedule = store.add_schedule("hello.py", "@daily", notify={"events": ["done"]})
    results = notifier.deliver(Outcome("done", run, schedule))
    assert [result.status for result in results] == ["sent"]
    assert webhook.waited(1)[0]["event"] == "done"


# ------------------------------------------------------------------------- the chain


class Chain:
    """A ``start_run`` that records rows instead of starting processes."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.started: list[Any] = []

    def __call__(self, schedule: Any, trigger: str) -> Any:
        run = self.store.add_run(schedule.flow, schedule.runtime, trigger=trigger)
        self.store.update_schedule(schedule.id, last_run=run.id, last_status="running")
        self.started.append(run)
        return run


def test_a_failed_run_is_retried_and_told_about_once(
    store: Store, web: WebSettings, webhook: Receiver
) -> None:
    notifier = Notifier(store, web)
    chain = Chain(store)
    outcomes = Outcomes(store, notifier, chain, sleeper=lambda delay, work: work())
    schedule = store.add_schedule(
        "hello.py",
        "@daily",
        retries=2,
        retry_delay=0,
        notify={"events": ["failed"], "webhook": webhook.url},
    )
    first = chain(schedule, f"schedule:{schedule.id}")
    for attempt in range(3):
        run = store.finish_run(chain.started[attempt].id, "failed", None, "boom\n", None, "boom")
        outcomes.finished(run)
    assert [run.trigger for run in chain.started] == [
        f"schedule:{schedule.id}",
        f"retry:{schedule.id}:2",
        f"retry:{schedule.id}:3",
    ]
    assert first.trigger.startswith("schedule:")
    bodies = webhook.waited(1)
    assert len(bodies) == 1, "one message for the chain, not one per attempt"
    assert bodies[0]["attempts"] == 3
    assert bodies[0]["status"] == "failed"
    assert store.get_schedule(schedule.id).last_outcome == {
        "status": "failed",
        "attempts": 3,
        "notified": True,
    }


def test_a_run_that_ends_well_is_not_retried(store: Store, web: WebSettings) -> None:
    chain = Chain(store)
    outcomes = Outcomes(store, Notifier(store, web), chain, sleeper=lambda delay, work: work())
    schedule = store.add_schedule("hello.py", "@daily", retries=3, retry_delay=0)
    chain(schedule, f"schedule:{schedule.id}")
    outcomes.finished(store.finish_run(chain.started[0].id, "done", None, "", None, None))
    assert len(chain.started) == 1
    assert store.get_schedule(schedule.id).last_outcome == {
        "status": "done",
        "attempts": 1,
        "notified": False,
    }


def test_a_cancelled_run_is_never_retried(store: Store, web: WebSettings) -> None:
    chain = Chain(store)
    outcomes = Outcomes(store, Notifier(store, web), chain, sleeper=lambda delay, work: work())
    schedule = store.add_schedule("hello.py", "@daily", retries=5, retry_delay=0)
    chain(schedule, f"schedule:{schedule.id}")
    outcomes.finished(store.finish_run(chain.started[0].id, "cancelled", None, "", None, None))
    assert len(chain.started) == 1, "somebody stopped it on purpose"


def test_a_manual_run_is_nobodys_chain(store: Store, web: WebSettings) -> None:
    chain = Chain(store)
    outcomes = Outcomes(store, Notifier(store, web), chain, sleeper=lambda delay, work: work())
    run = store.add_run("hello.py", "sync", trigger="manual")
    outcomes.finished(store.finish_run(run.id, "failed", None, "", None, "no"))
    assert chain.started == []


def test_a_schedule_deleted_mid_chain_stops_it(store: Store, web: WebSettings) -> None:
    chain = Chain(store)
    outcomes = Outcomes(store, Notifier(store, web), chain, sleeper=lambda delay, work: work())
    schedule = store.add_schedule("hello.py", "@daily", retries=2, retry_delay=0)
    chain(schedule, f"schedule:{schedule.id}")
    ended = store.finish_run(chain.started[0].id, "failed", None, "", None, "no")
    store.delete_schedule(schedule.id)
    with pytest.raises(ValueError, match="no schedule"):
        outcomes.finished(ended)
    assert len(chain.started) == 1


# --------------------------------------------------------------------- through the server


def test_a_scheduled_flow_that_fails_is_retried_and_the_webhook_is_told(
    client: TestClient, webhook: Receiver
) -> None:
    made = client.post(
        "/api/schedules",
        json={
            "flow": "fails.py",
            "cron": "@daily",
            "runtime": "sync",
            "retries": 1,
            "retry_delay": 0,
            "notify": {"events": ["failed"], "webhook": webhook.url},
        },
    )
    assert made.status_code == 201, made.text
    schedule = made.json()
    assert schedule["notify"]["webhook"] == webhook.url
    assert schedule["retry_delay"] == 0

    first = client.post(f"/api/schedules/{schedule['id']}/run").json()
    assert wait_for_run(client, first["id"])["status"] == "failed"

    body = webhook.waited(1)[0]
    assert body["attempts"] == 2, "the first run and one retry"
    assert body["status"] == "failed"
    assert body["schedule"]["id"] == schedule["id"]
    assert body["run"]["trigger"] == f"retry:{schedule['id']}:2"
    assert body["log_tail"], "the end of the log travels with the news"

    runs = client.get("/api/runs?flow=fails.py").json()["runs"]
    assert [run["trigger"] for run in runs] == [
        f"retry:{schedule['id']}:2",
        f"schedule:{schedule['id']}",
    ]
    listed = client.get("/api/schedules").json()["schedules"][0]
    assert listed["last_outcome"] == {"status": "failed", "attempts": 2, "notified": True}
    assert listed["last_status"] == "failed"

    told = notifications_of(client, runs[0]["id"])
    assert [row["channel"] for row in told] == ["webhook"]
    assert told[0]["status"] == "sent"
    assert told[0]["target"] == webhook.url


def test_a_test_message_is_sent_now_and_answered_per_channel(
    client: TestClient, webhook: Receiver, smtp: type[FakeSMTP]
) -> None:
    made = client.post(
        "/api/schedules",
        json={
            "flow": "fails.py",
            "cron": "@daily",
            "notify": {
                "events": ["failed", "done"],
                "webhook": webhook.url,
                "emails": ["ada@example.test"],
            },
        },
    )
    schedule = made.json()
    assert schedule["notify"]["events"] == ["failed", "done"]

    tried = client.post(f"/api/schedules/{schedule['id']}/test")
    assert tried.status_code == 200, tried.text
    results = tried.json()["results"]
    assert [result["channel"] for result in results] == ["webhook", "email"]
    assert results[0]["status"] == "sent"
    assert results[1]["status"] == "failed", "there are no SMTP settings yet"
    assert "no SMTP settings" in results[1]["error"]
    body = webhook.waited(1)[0]
    assert body["event"] == "test"
    assert body["flow"] == "fails.py"
    assert body["run"]["id"] == 0, "no run has happened, so the message describes a placeholder"


def test_a_schedule_with_nowhere_to_send_says_so(client: TestClient) -> None:
    made = client.post("/api/schedules", json={"flow": "fails.py", "cron": "@daily"})
    answer = client.post(f"/api/schedules/{made.json()['id']}/test")
    assert answer.status_code == 400
    assert "nowhere to send" in answer.json()["error"]["message"]
    assert client.post("/api/schedules/999/test").status_code == 404


@pytest.mark.parametrize(
    ("notify", "says"),
    [
        ({"events": ["exploded"]}, "notify.events must be a list of"),
        ({"webhook": "ftp://nope"}, "http:// or https://"),
        ({"emails": ["not an address"]}, "is not an email address"),
        ({"unknown": 1}, "notify.unknown"),
    ],
)
def test_a_schedule_with_a_notify_that_is_not_one_is_refused(
    client: TestClient, notify: dict[str, Any], says: str
) -> None:
    answer = client.post(
        "/api/schedules", json={"flow": "fails.py", "cron": "@daily", "notify": notify}
    )
    assert answer.status_code == 400
    assert says in answer.json()["error"]["message"]


@pytest.mark.parametrize(
    ("body", "says"),
    [
        ({"retries": 6}, "between 0 and 5"),
        ({"retries": -1}, "between 0 and 5"),
        ({"retry_delay": -5}, "0 or more"),
    ],
)
def test_retries_have_a_ceiling_and_a_floor(
    client: TestClient, body: dict[str, Any], says: str
) -> None:
    answer = client.post("/api/schedules", json={"flow": "fails.py", "cron": "@daily", **body})
    assert answer.status_code == 400
    assert says in answer.json()["error"]["message"]


def test_the_notifications_of_a_run_that_had_none(client: TestClient) -> None:
    started = client.post("/api/runs", json={"path": "fails.py", "runtime": "sync"}).json()
    wait_for_run(client, started["id"])
    assert client.get(f"/api/runs/{started['id']}/notifications").json() == {"notifications": []}
    assert client.get("/api/runs/999/notifications").status_code == 404


def test_the_smtp_password_is_write_only(client: TestClient, tmp_path: Path) -> None:
    saved = client.put(
        "/api/settings",
        json={
            "notifications": {
                "smtp": {"host": "mail.example.test", "port": 25, "starttls": False},
                "smtp_password": "not-a-real-password",
                "webhook_default": "https://example.test/hook",
            }
        },
    )
    assert saved.status_code == 200, saved.text
    assert "not-a-real-password" not in saved.text
    body = saved.json()["notifications"]
    assert body["smtp"] == {
        "host": "mail.example.test",
        "port": 25,
        "username": "",
        "from": "",
        "starttls": False,
    }
    assert body["has_smtp_password"] is True
    assert body["webhook_default"] == "https://example.test/hook"
    assert "not-a-real-password" in (tmp_path / "web.toml").read_text()

    forgotten = client.put("/api/settings", json={"notifications": {"smtp_password": None}})
    assert forgotten.json()["notifications"]["has_smtp_password"] is False

    refused = client.put(
        "/api/settings",
        json={"notifications": {"smtp": {"host": "m", "password": "here"}}},
    )
    assert refused.status_code == 400
    assert "smtp_password" in refused.json()["error"]["message"]
