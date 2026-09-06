"""Users, sessions, roles: who may ask the server for what.

The three modes of the contract are three fixtures. ``client`` is local mode, the way
every other test in this directory runs: no users, loopback, everybody is the implicit
admin. ``team`` is users mode, with an administrator and a member signed in. ``token``
is a server started with ``--token`` and nobody in it yet, which is where the first
administrator is made from the login page.

Nothing here needs a network or a key. Passwords are hashed for real, because the cost
of scrypt is the point of it, so the users a test needs are counted rather than assumed.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import NamedTuple

import pytest

pytest.importorskip("fastapi", reason="the web extra: pip install 'tolquane[web]'")
pytest.importorskip("httpx", reason="the test client needs httpx")

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_server import make_settings, wait_for_run, workspace  # noqa: F401

from tolquane.cli import main
from tolquane.web import store as store_module
from tolquane.web.server import ADMIN, MEMBER, PUBLIC, create_app, role_for
from tolquane.web.settings import AppSettings
from tolquane.web.store import (
    SESSION_DAYS,
    Store,
    User,
    hash_password,
    token_hash,
    verify_password,
)

ADMIN_PASSWORD = "ada-in-the-loop"
MEMBER_PASSWORD = "bob-writes-flows"
TOKEN = "s3cr3t-token"

START = datetime(2026, 3, 2, 9, 0, 0, tzinfo=UTC)
"""A Monday morning, in UTC: sessions are counted in days from here."""


class Clock:
    """A clock a test moves by hand: the store and the scheduler both read it."""

    def __init__(self, start: datetime = START) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def tick(self, **span: float) -> None:
        self.now += timedelta(**span)


class Team(NamedTuple):
    """A users-mode server and the two people signed in to it."""

    client: TestClient
    admin: dict[str, str]
    member: dict[str, str]
    clock: Clock


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def client(tmp_path: Path, workspace: Path, clock: Clock) -> Iterator[TestClient]:  # noqa: F811
    """Local mode: no users, no token, everything allowed. What 1.2 was."""
    with TestClient(create_app(make_settings(tmp_path, workspace, clock=clock))) as made:
        yield made


@pytest.fixture
def token_client(tmp_path: Path, workspace: Path, clock: Clock) -> Iterator[TestClient]:  # noqa: F811
    """Token mode: ``--token`` and nobody yet, so the first admin can be made."""
    settings = make_settings(tmp_path, workspace, token=TOKEN, clock=clock)
    with TestClient(create_app(settings)) as made:
        yield made


def make_team(settings: AppSettings, clock: Clock) -> Iterator[Team]:
    """An admin and a member, made before the server starts, then both signed in."""
    with Store(settings.db_path, clock=clock) as store:
        store.add_user("ada", ADMIN_PASSWORD, "admin", False)
        store.add_user("bob", MEMBER_PASSWORD, "member", False)
    with TestClient(create_app(settings)) as client:
        yield Team(client, sign_in(client, "ada", ADMIN_PASSWORD), member(client), clock)


@pytest.fixture
def team(tmp_path: Path, workspace: Path, clock: Clock) -> Iterator[Team]:  # noqa: F811
    """Users mode: at least one user, so every request needs a session or a token."""
    yield from make_team(make_settings(tmp_path, workspace, clock=clock), clock)


def sign_in(client: TestClient, name: str, password: str) -> dict[str, str]:
    answer = client.post("/api/auth/login", json={"name": name, "password": password})
    assert answer.status_code == 200, answer.text
    return bearer(answer.json()["token"])


def member(client: TestClient) -> dict[str, str]:
    return sign_in(client, "bob", MEMBER_PASSWORD)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def auth() -> dict[str, str]:
    return bearer(TOKEN)


# ------------------------------------------------------------------------- the modes


def test_local_mode_is_what_it_was(client: TestClient) -> None:
    """No users: no login, the implicit admin, and the workspace on the health page."""
    me = client.get("/api/auth/me").json()
    assert me["mode"] == "local"
    assert me["user"] == {
        "id": 0,
        "name": "local",
        "role": "admin",
        "created": "",
        "disabled": False,
        "must_change_password": False,
        "last_seen": None,
    }
    assert me["can_setup"] is False
    assert client.get("/api/health").json()["workspace"].endswith("flows")
    assert client.get("/api/flows").status_code == 200
    assert client.get("/api/users").json() == {"users": []}
    # A token from another day, left in a browser, does not lock anybody out of a
    # server that asks for none.
    assert client.get("/api/flows", headers=bearer("stale")).status_code == 200


def test_making_the_first_user_turns_the_lights_on(client: TestClient) -> None:
    """Local mode lasts exactly as long as there are no users."""
    made = client.post(
        "/api/users", json={"name": "ada", "password": ADMIN_PASSWORD, "role": "admin"}
    )
    assert made.status_code == 201, made.text
    assert made.json()["must_change_password"] is True
    assert client.get("/api/auth/me").json() == {"user": None, "mode": "users", "can_setup": False}
    refused = client.get("/api/flows")
    assert refused.status_code == 401
    assert refused.json()["error"]["type"] == "Unauthorized"
    assert client.get("/api/flows", headers=sign_in(client, "ada", ADMIN_PASSWORD)).status_code == (
        200
    )


def test_users_mode_asks_everybody_to_sign_in(team: Team) -> None:
    client = team.client
    assert client.get("/api/auth/me").json()["mode"] == "users"
    assert client.get("/api/flows").status_code == 401
    assert client.get("/api/openapi.json").status_code == 401
    assert client.get("/api/nothing-here").status_code == 401  # not even the shape of a 404
    assert client.get("/api/flows", headers=team.member).status_code == 200
    assert client.get("/api/openapi.json", headers=team.member).status_code == 200
    assert client.get("/api/auth/me", headers=team.member).json()["user"]["name"] == "bob"
    assert client.get("/api/flows", headers=bearer("not-a-token")).status_code == 401


def test_health_is_public_and_says_less_to_a_stranger(team: Team) -> None:
    """A monitor may ask; the login page asks before there is anybody to ask as."""
    open_health = team.client.get("/api/health")
    assert open_health.status_code == 200
    assert open_health.json()["ok"] is True
    assert "workspace" not in open_health.json()
    signed_in = team.client.get("/api/health", headers=team.member).json()
    assert signed_in["workspace"].endswith("flows")


def test_token_mode_makes_the_first_admin_once(token_client: TestClient) -> None:
    me = token_client.get("/api/auth/me", headers=auth()).json()
    assert (me["mode"], me["can_setup"], me["user"]["name"]) == ("token", True, "token")
    assert token_client.get("/api/auth/me").status_code == 401  # the wall is still the wall

    made = token_client.post(
        "/api/auth/setup", json={"name": "Ada", "password": ADMIN_PASSWORD}, headers=auth()
    )
    assert made.status_code == 201, made.text
    assert made.json()["user"] == {
        "id": 1,
        "name": "ada",  # names are lower-cased
        "role": "admin",
        "created": made.json()["user"]["created"],
        "disabled": False,
        "must_change_password": False,
        "last_seen": None,
    }
    session = bearer(made.json()["token"])
    assert token_client.get("/api/users", headers=session).json()["users"][0]["name"] == "ada"
    assert token_client.get("/api/auth/me", headers=session).json()["mode"] == "users"

    again = token_client.post(
        "/api/auth/setup", json={"name": "eve", "password": ADMIN_PASSWORD}, headers=auth()
    )
    assert again.status_code == 409
    assert "already has users" in again.json()["error"]["message"]


def test_setup_is_not_a_way_in_without_a_token(client: TestClient) -> None:
    """In local mode the first user is made with the CLI, not by whoever asks first."""
    refused = client.post("/api/auth/setup", json={"name": "eve", "password": ADMIN_PASSWORD})
    assert refused.status_code == 403
    assert "tolquane web users add" in refused.json()["error"]["message"]


def test_the_server_token_stays_an_admin_when_there_are_users(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
    clock: Clock,
) -> None:
    settings = make_settings(tmp_path, workspace, token=TOKEN, clock=clock)
    for team in make_team(settings, clock):
        client = team.client
        assert client.get("/api/users", headers=auth()).status_code == 200
        assert client.get("/api/auth/me", headers=auth()).json() == {
            "user": {
                "id": 0,
                "name": "token",
                "role": "admin",
                "created": "",
                "disabled": False,
                "must_change_password": False,
                "last_seen": None,
            },
            "mode": "users",
            "can_setup": False,
        }
        # A session works alongside it: the wall lets a signed-in user past the token.
        assert client.get("/api/flows", headers=team.member).status_code == 200
        assert client.get("/api/flows").status_code == 401


# -------------------------------------------------------------------------- the roles


def _example(path: str) -> str:
    """One concrete URL for a templated path: the ids do not matter, the role does."""
    out = path.replace("{path}", "hello.py")
    while "{" in out:
        start = out.index("{")
        end = out.index("}", start)
        out = out[:start] + "1" + out[end + 1 :]
    return out


def test_every_admin_route_in_the_document_refuses_a_member(team: Team) -> None:
    """The contract is the OpenAPI document and the role table; walk both together.

    Only the admin routes are called: a member's request to a member's route does what
    it says on the tin, and this test is not the place to start runs or delete flows.
    """
    document = team.client.get("/api/openapi.json", headers=team.admin).json()
    checked = []
    for path, methods in document["paths"].items():
        for method in methods:
            url = _example(path)
            if role_for(method, url) != ADMIN:
                continue
            answer = team.client.request(method.upper(), url, headers=team.member, json={})
            assert answer.status_code == 403, f"{method.upper()} {path} let a member in"
            assert answer.json()["error"]["type"] == "Forbidden"
            assert "administrator" in answer.json()["error"]["message"]
            checked.append(f"{method.upper()} {path}")
    assert sorted(checked) == [
        "DELETE /api/users/{user_id}",
        "GET /api/users",
        "POST /api/users",
        "POST /api/workspace/history/init",
        "PUT /api/users/{user_id}",
    ]


def test_a_member_may_do_the_work(team: Team) -> None:
    """Flows, runs, schedules and the AI are the job; a member is here to do it."""
    for url in ("/api/flows", "/api/runs", "/api/schedules", "/api/settings", "/api/auth/tokens"):
        assert team.client.get(url, headers=team.member).status_code == 200, url
    preview = team.client.post(
        "/api/schedules/preview", json={"cron": "@daily"}, headers=team.member
    )
    assert preview.status_code == 200


def test_the_role_table_is_the_whole_answer() -> None:
    """It is data, and it is read the same way for a URL and for a route template."""
    assert role_for("GET", "/api/health") == PUBLIC
    assert role_for("POST", "/api/auth/login") == PUBLIC
    assert role_for("POST", "/api/auth/logout") == MEMBER
    assert role_for("GET", "/api/flows/hello.py") == MEMBER
    assert role_for("GET", "/api/users") == ADMIN
    assert role_for("DELETE", "/api/users/{user_id}") == ADMIN
    assert role_for("DELETE", "/api/users/7") == ADMIN
    assert role_for("POST", "/api/health") == MEMBER  # only GET is public


def test_a_member_sees_the_settings_but_changes_only_the_theme(team: Team) -> None:
    view = team.client.get("/api/settings", headers=team.member).json()
    assert view["server"] is None
    assert view["ai"]["has_anthropic_key"] is None
    assert view["ai"]["provider"] == "anthropic"
    assert view["default_runtime"] == "threads"

    themed = team.client.put("/api/settings", json={"theme": "light"}, headers=team.member)
    assert themed.status_code == 200
    assert themed.json()["theme"] == "light"

    refused = team.client.put(
        "/api/settings", json={"theme": "dark", "default_runtime": "sync"}, headers=team.member
    )
    assert refused.status_code == 403
    assert "default_runtime" in refused.json()["error"]["message"]
    assert team.client.get("/api/settings", headers=team.admin).json()["theme"] == "light"

    keys = team.client.put(
        "/api/settings", json={"ai": {"anthropic_key": "sk-nope"}}, headers=team.member
    )
    assert keys.status_code == 403
    admin_view = team.client.get("/api/settings", headers=team.admin).json()
    assert admin_view["ai"]["has_anthropic_key"] is False
    assert admin_view["server"]["token_set"] is False


# ------------------------------------------------------------------ sessions and tokens


def test_a_session_slides_and_then_expires(team: Team) -> None:
    client, clock = team.client, team.clock
    assert client.get("/api/flows", headers=team.member).status_code == 200
    clock.tick(days=SESSION_DAYS - 5)
    assert client.get("/api/flows", headers=team.member).status_code == 200  # slides here
    clock.tick(days=SESSION_DAYS - 5)
    assert client.get("/api/flows", headers=team.member).status_code == 200
    clock.tick(days=SESSION_DAYS + 1)
    gone = client.get("/api/flows", headers=team.member)
    assert gone.status_code == 401
    assert client.get("/api/auth/me", headers=team.member).json()["user"] is None


def test_logging_out_forgets_the_session(team: Team) -> None:
    assert team.client.post("/api/auth/logout", headers=team.member).json() == {"ok": True}
    assert team.client.get("/api/flows", headers=team.member).status_code == 401
    # The other person is still signed in: one session went, not the account.
    assert team.client.get("/api/flows", headers=team.admin).status_code == 200


def test_api_tokens_are_shown_once_and_never_expire(team: Team) -> None:
    client = team.client
    made = client.post("/api/auth/tokens", json={"label": "nightly"}, headers=team.member)
    assert made.status_code == 201, made.text
    token = made.json()["token"]
    listed = client.get("/api/auth/tokens", headers=team.member).json()["tokens"]
    assert [entry["label"] for entry in listed] == ["nightly"]
    assert "token" not in listed[0]

    assert client.get("/api/flows", headers=bearer(token)).status_code == 200
    assert client.get("/api/users", headers=bearer(token)).status_code == 403  # still a member
    assert client.get("/api/auth/tokens", headers=team.admin).json()["tokens"] == []
    # Somebody else's token is not there to take, an administrator's included.
    mine = f"/api/auth/tokens/{made.json()['id']}"
    assert client.delete(mine, headers=team.admin).status_code == 404

    team.clock.tick(days=365)
    assert client.get("/api/flows", headers=bearer(token)).status_code == 200
    assert client.get("/api/flows", headers=team.admin).status_code == 401, (
        "a browser session, unlike an API token, does not last a year"
    )
    assert client.delete(mine, headers=sign_in(client, "bob", MEMBER_PASSWORD)).status_code == 200
    assert client.get("/api/flows", headers=bearer(token)).status_code == 401


def test_the_local_admin_has_no_password_and_no_tokens(client: TestClient) -> None:
    """Local mode is not a person: there is nothing to change and nothing to issue."""
    for answer in (
        client.get("/api/auth/tokens"),
        client.post("/api/auth/tokens", json={"label": "x"}),
        client.post("/api/auth/password", json={"current": "x", "new": ADMIN_PASSWORD}),
    ):
        assert answer.status_code == 400
        assert "tolquane web users add" in answer.json()["error"]["message"]
    assert client.post("/api/auth/logout").json() == {"ok": True}


def test_the_websocket_and_the_event_stream_take_a_session(team: Team) -> None:
    """Neither can set a header, so ``?token=`` carries a session as well as ``--token``."""
    client = team.client
    started = client.post(
        "/api/runs", json={"path": "hello.py", "runtime": "sync"}, headers=team.member
    )
    run_id = started.json()["id"]
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(f"/api/runs/{run_id}/events?token=nope") as socket,
    ):
        socket.receive_json()
    session = team.member["Authorization"].split(" ", 1)[1]
    with client.websocket_connect(f"/api/runs/{run_id}/events?token={session}") as socket:
        assert socket.receive_json()["event"] == "start"

    chat = {"messages": [{"role": "user", "content": "hi"}]}
    assert client.post("/api/ai/chat", json=chat).status_code == 401
    streamed = client.post(f"/api/ai/chat?token={session}", json=chat)
    assert streamed.status_code == 200
    assert "text/event-stream" in streamed.headers["content-type"]
    client.headers.update(team.member)
    wait_for_run(client, run_id)


# ----------------------------------------------------------------------- the accounts


def test_a_disabled_user_is_stopped_at_once(team: Team) -> None:
    client = team.client
    bob = next(
        u
        for u in client.get("/api/users", headers=team.admin).json()["users"]
        if u["name"] == "bob"
    )
    changed = client.put(f"/api/users/{bob['id']}", json={"disabled": True}, headers=team.admin)
    assert changed.status_code == 200
    assert changed.json()["disabled"] is True
    assert client.get("/api/flows", headers=team.member).status_code == 401  # the session too
    refused = client.post("/api/auth/login", json={"name": "bob", "password": MEMBER_PASSWORD})
    assert refused.status_code == 403
    assert refused.json()["error"]["type"] == "Forbidden"

    client.put(f"/api/users/{bob['id']}", json={"disabled": False}, headers=team.admin)
    assert (
        client.post(
            "/api/auth/login", json={"name": "bob", "password": MEMBER_PASSWORD}
        ).status_code
        == 200
    )


def test_the_last_administrator_cannot_be_taken_away(team: Team) -> None:
    client = team.client
    users = {
        user["name"]: user["id"]
        for user in client.get("/api/users", headers=team.admin).json()["users"]
    }
    for change in ({"role": "member"}, {"disabled": True}):
        refused = client.put(f"/api/users/{users['ada']}", json=change, headers=team.admin)
        assert refused.status_code == 400, change
        assert "last administrator" in refused.json()["error"]["message"]
    mine = client.delete(f"/api/users/{users['ada']}", headers=team.admin)
    assert mine.status_code == 400
    assert "yourself" in mine.json()["error"]["message"]

    client.post(
        "/api/users",
        json={"name": "cass", "password": ADMIN_PASSWORD, "role": "admin"},
        headers=team.admin,
    )
    assert (
        client.put(
            f"/api/users/{users['ada']}", json={"role": "member"}, headers=team.admin
        ).status_code
        == 200
    )
    # ada is a member now, so she is no longer allowed to be here at all.
    assert client.get("/api/users", headers=team.admin).status_code == 403


def test_deleting_a_user_takes_their_sessions_with_them(team: Team) -> None:
    client = team.client
    bob = next(
        u
        for u in client.get("/api/users", headers=team.admin).json()["users"]
        if u["name"] == "bob"
    )
    assert client.delete(f"/api/users/{bob['id']}", headers=team.admin).json() == {"ok": True}
    assert client.get("/api/flows", headers=team.member).status_code == 401
    assert client.delete(f"/api/users/{bob['id']}", headers=team.admin).status_code == 404
    assert [u["name"] for u in client.get("/api/users", headers=team.admin).json()["users"]] == [
        "ada"
    ]


def test_password_rules_and_what_a_change_does_not_do(team: Team) -> None:
    client = team.client
    short = client.post(
        "/api/users",
        json={"name": "eve", "password": "sh0rt", "role": "member"},
        headers=team.admin,
    )
    assert short.status_code == 400
    assert "at least 8 characters" in short.json()["error"]["message"]
    bad_name = client.post(
        "/api/users", json={"name": "Eve Adams!", "password": ADMIN_PASSWORD}, headers=team.admin
    )
    assert bad_name.status_code == 400
    assert "not a user name" in bad_name.json()["error"]["message"]
    twice = client.post(
        "/api/users", json={"name": "ada", "password": ADMIN_PASSWORD}, headers=team.admin
    )
    assert twice.status_code == 400
    assert "already a user called 'ada'" in twice.json()["error"]["message"]

    assert (
        client.post(
            "/api/auth/password",
            json={"current": "wrong", "new": "another-password"},
            headers=team.member,
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/password",
            json={"current": MEMBER_PASSWORD, "new": "short"},
            headers=team.member,
        ).status_code
        == 400
    )

    changed = client.post(
        "/api/auth/password",
        json={"current": MEMBER_PASSWORD, "new": "another-password"},
        headers=team.member,
    )
    assert changed.json() == {"ok": True}
    # The session that made the change lives on: it is the browser the person is in.
    assert client.get("/api/flows", headers=team.member).status_code == 200
    assert (
        client.post(
            "/api/auth/login", json={"name": "bob", "password": MEMBER_PASSWORD}
        ).status_code
        == 401
    )
    assert sign_in(client, "bob", "another-password")


def test_an_administrator_resets_a_password_and_asks_for_a_new_one(team: Team) -> None:
    client = team.client
    bob = next(
        u
        for u in client.get("/api/users", headers=team.admin).json()["users"]
        if u["name"] == "bob"
    )
    reset = client.put(
        f"/api/users/{bob['id']}", json={"password": "temporary-one"}, headers=team.admin
    )
    assert reset.status_code == 200
    assert reset.json()["must_change_password"] is True
    fresh = sign_in(client, "bob", "temporary-one")
    assert client.get("/api/auth/me", headers=fresh).json()["user"]["must_change_password"] is True
    client.post(
        "/api/auth/password",
        json={"current": "temporary-one", "new": "chosen-by-bob"},
        headers=fresh,
    )
    assert client.get("/api/auth/me", headers=fresh).json()["user"]["must_change_password"] is (
        False
    )
    assert client.put(f"/api/users/{bob['id']}", json={}, headers=team.admin).status_code == 400
    assert client.put("/api/users/99", json={"role": "admin"}, headers=team.admin).status_code == (
        404
    )
    assert (
        client.put(
            f"/api/users/{bob['id']}", json={"role": "wizard"}, headers=team.admin
        ).status_code
        == 400
    )


# ------------------------------------------------------------------- runs and schedules


def test_a_run_and_a_schedule_remember_who_asked(team: Team) -> None:
    client = team.client
    run = client.post(
        "/api/runs", json={"path": "hello.py", "runtime": "sync"}, headers=team.member
    )
    assert run.status_code == 200, run.text
    assert run.json()["user"] == "bob"
    client.headers.update(team.member)
    assert wait_for_run(client, run.json()["id"])["user"] == "bob"
    assert client.get("/api/runs").json()["runs"][0]["user"] == "bob"

    made = client.post(
        "/api/schedules", json={"flow": "hello.py", "cron": "@daily", "runtime": "sync"}
    )
    assert made.json()["user"] == "bob"
    now = client.post(f"/api/schedules/{made.json()['id']}/run")
    assert now.json()["user"] == "bob", "a schedule's run belongs to whoever made it"
    wait_for_run(client, now.json()["id"])


def test_the_rows_of_an_older_database_belong_to_local(tmp_path: Path) -> None:
    """A file written before 1.3 opens, migrates, and says who those runs were."""
    path = tmp_path / "web.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    conn.execute("INSERT INTO schema_version (version) VALUES (0)")
    store_module._migration_1(conn)
    conn.execute("UPDATE schema_version SET version = 1")
    conn.execute(
        'INSERT INTO runs (flow, runtime, "trigger", started, status, log)'
        " VALUES ('old.py', 'threads', 'manual', '2026-01-01T00:00:00+00:00', 'done', '')"
    )
    conn.execute(
        "INSERT INTO schedules (flow, cron, runtime, created)"
        " VALUES ('old.py', '@daily', 'threads', '2026-01-01T00:00:00+00:00')"
    )
    conn.commit()
    conn.close()
    with Store(path) as store:
        assert store.version == store_module.schema_version()
        assert store.list_runs()[0].user == "local"
        assert store.list_schedules()[0].user == "local"
        assert store.count_users() == 0


# ---------------------------------------------------------------------------- hashing


def test_a_password_is_stored_as_scrypt_and_nothing_else(tmp_path: Path) -> None:
    stored = hash_password(ADMIN_PASSWORD)
    kind, salt, digest = stored.split("$")
    assert kind == "scrypt"
    assert len(salt) >= 20
    assert len(digest) >= 40
    assert ADMIN_PASSWORD not in stored
    assert hash_password(ADMIN_PASSWORD) != stored, "every password gets its own salt"
    assert verify_password(stored, ADMIN_PASSWORD) is True
    assert verify_password(stored, ADMIN_PASSWORD + " ") is False
    # A name that does not exist takes the same road as a wrong password: one hash.
    assert verify_password(None, ADMIN_PASSWORD) is False
    assert verify_password("not-a-hash", ADMIN_PASSWORD) is False

    with Store(tmp_path / "web.db") as store:
        user = store.add_user("ada", ADMIN_PASSWORD, "admin")
        assert user.password_hash.startswith("scrypt$")
        assert "password_hash" not in user.to_dict()
        row = store._conn.execute("SELECT * FROM sessions").fetchone()
        assert row is None
        issued = store.create_session(user.id)
        held = store._conn.execute("SELECT token_hash FROM sessions").fetchone()["token_hash"]
        assert held == token_hash(issued.token)
        assert issued.token not in held


# ------------------------------------------------------------------------------ the CLI


def stored(home: Path, name: str) -> User:
    """One user, read straight out of the file the command wrote."""
    with Store(home / "web.db") as store:
        user = store.get_user_by_name(name)
    assert user is not None, f"the command did not write {name}"
    return user


def cli(monkeypatch: pytest.MonkeyPatch, home: Path, *argv: str) -> int:
    monkeypatch.setenv("TOLQUANE_HOME", str(home))
    return main(["web", "users", *argv])


def test_the_cli_makes_users_without_a_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    home = tmp_path / "home"
    assert cli(monkeypatch, home, "list") == 0
    assert "no users" in capsys.readouterr().out

    assert cli(monkeypatch, home, "add", "ada", "--admin", "--password", ADMIN_PASSWORD) == 0
    assert "added ada (admin)" in capsys.readouterr().out
    assert cli(monkeypatch, home, "add", "bob", "--password", MEMBER_PASSWORD) == 0
    capsys.readouterr()

    assert cli(monkeypatch, home, "list") == 0
    listed = capsys.readouterr().out
    assert "ada" in listed
    assert "admin" in listed
    assert "bob" in listed
    assert "member" in listed

    assert verify_password(stored(home, "ada").password_hash, ADMIN_PASSWORD)
    assert stored(home, "bob").must_change_password is False


def test_the_cli_refuses_a_duplicate_and_a_short_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    home = tmp_path / "home"
    assert cli(monkeypatch, home, "add", "ada", "--password", ADMIN_PASSWORD) == 0
    capsys.readouterr()
    assert cli(monkeypatch, home, "add", "ada", "--password", ADMIN_PASSWORD) == 1
    assert "already a user called 'ada'" in capsys.readouterr().err
    assert cli(monkeypatch, home, "add", "eve", "--password", "sh0rt") == 1
    assert "at least 8 characters" in capsys.readouterr().err
    assert cli(monkeypatch, home, "add", "Eve Adams", "--password", ADMIN_PASSWORD) == 1
    assert "not a user name" in capsys.readouterr().err
    assert cli(monkeypatch, home, "passwd", "nobody", "--password", ADMIN_PASSWORD) == 1
    assert "no user called 'nobody'" in capsys.readouterr().err


def test_the_cli_asks_for_the_password_when_it_is_not_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Nobody types a password on a command line where the shell keeps it."""
    import getpass

    said: list[str] = []

    def typed(prompt: str = "") -> str:
        said.append(prompt)
        return ADMIN_PASSWORD

    monkeypatch.setattr(getpass, "getpass", typed)
    home = tmp_path / "home"
    assert cli(monkeypatch, home, "add", "ada", "--admin") == 0
    assert said == ["Password for ada: ", "Again: "]
    capsys.readouterr()

    answers = iter([ADMIN_PASSWORD, "something-else"])
    monkeypatch.setattr(getpass, "getpass", lambda prompt="": next(answers))
    assert cli(monkeypatch, home, "passwd", "ada") == 1
    assert "not the same" in capsys.readouterr().err

    monkeypatch.setattr(getpass, "getpass", lambda prompt="": "a-new-password")
    assert cli(monkeypatch, home, "passwd", "ada") == 0
    assert "the password of ada is changed" in capsys.readouterr().out
    assert verify_password(stored(home, "ada").password_hash, "a-new-password")


def test_the_cli_disables_and_enables_and_keeps_one_administrator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    home = tmp_path / "home"
    cli(monkeypatch, home, "add", "ada", "--admin", "--password", ADMIN_PASSWORD)
    cli(monkeypatch, home, "add", "bob", "--password", MEMBER_PASSWORD)
    capsys.readouterr()

    assert cli(monkeypatch, home, "disable", "ada") == 1
    assert "last administrator" in capsys.readouterr().err
    assert cli(monkeypatch, home, "disable", "bob") == 0
    assert "no longer sign in" in capsys.readouterr().out
    assert stored(home, "bob").disabled is True
    assert cli(monkeypatch, home, "enable", "bob") == 0
    assert "can sign in again" in capsys.readouterr().out
    assert stored(home, "bob").disabled is False

    assert cli(monkeypatch, home, "add", "cass", "--admin", "--password", ADMIN_PASSWORD) == 0
    assert cli(monkeypatch, home, "disable", "ada") == 0
    capsys.readouterr()
    assert cli(monkeypatch, home, "list") == 0
    assert "disabled" in capsys.readouterr().out


def test_the_cli_and_the_server_share_the_database(
    tmp_path: Path,
    workspace: Path,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``tolquane web users add`` is how a machine with no ``--token`` gets its first admin."""
    home = tmp_path / "home"
    assert cli(monkeypatch, home, "add", "ada", "--admin", "--password", ADMIN_PASSWORD) == 0
    capsys.readouterr()
    settings = make_settings(tmp_path, workspace, db_path=home / "web.db")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/flows").status_code == 401
        assert client.get("/api/auth/me").json()["mode"] == "users"
        headers = sign_in(client, "ada", ADMIN_PASSWORD)
        assert client.get("/api/users", headers=headers).json()["users"][0]["name"] == "ada"
