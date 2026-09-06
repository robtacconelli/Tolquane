"""Inputs and environments: what a run is given, and what the interpreter is.

Everything here goes through the real routes and real child processes, because the point
of the feature is what arrives on the other side of a ``subprocess``: a parameter that
reaches ``build()``, a variable that reaches ``os.environ``, an import that the run's own
interpreter does or does not have.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi", reason="the web extra: pip install 'tolquane[web]'")
pytest.importorskip("httpx", reason="the test client needs httpx")

from fastapi.testclient import TestClient
from test_server import make_settings, wait_for_run, workspace  # noqa: F401
from test_users import Team, clock, team  # noqa: F401

from tolquane.web.server import create_app
from tolquane.web.settings import AppSettings
from tolquane.web.supervisor import param_argument

PARAMETERS = '''"""A flow with parameters, which prints what it was given."""

import os

import tolquane as tq

GIVEN = {"factor": 2, "label": "plain"}


@tq.source
def numbers():
    """Yield three numbers."""
    yield from range(1, 4)


@tq.sink
def show(n):
    """Print one result, the label it was given and one variable."""
    print(GIVEN["label"], n * GIVEN["factor"], os.environ.get("GREETING", "<none>"), flush=True)


def build(source=None, *, factor: int = 2, label: str = "plain"):
    GIVEN["factor"] = factor
    GIVEN["label"] = label
    start = numbers if source is None else tq.from_iterable(source)
    return start >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

NEEDS_A_PACKAGE = '''"""A flow that imports something nobody has."""

import json

import tolquane as tq

import definitely_not_a_real_module


@tq.source
def numbers():
    """Yield one number."""
    yield 1


@tq.sink
def show(n):
    """Print one number."""
    print(json.dumps(n))


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''


@pytest.fixture
def settings(tmp_path: Path, workspace: Path) -> AppSettings:  # noqa: F811
    (workspace / "parameters.py").write_text(PARAMETERS)
    return make_settings(tmp_path, workspace)


@pytest.fixture
def client(settings: AppSettings) -> Any:
    with TestClient(create_app(settings)) as made:
        yield made


# ------------------------------------------------------------------ runs and parameters


def test_a_run_is_given_its_parameters_and_its_environment(client: TestClient) -> None:
    started = client.post(
        "/api/runs",
        json={
            "path": "parameters.py",
            "runtime": "sync",
            "params": {"factor": 3, "label": "tripled"},
            "env": {"GREETING": "hello"},
        },
    )
    assert started.status_code == 200, started.text
    assert started.json()["params"] == {"factor": 3, "label": "tripled"}
    assert started.json()["env"] == {"GREETING": "hello"}

    run = wait_for_run(client, started.json()["id"])
    assert run["status"] == "done", run["log"]
    assert "tripled 3 hello" in run["log"]
    assert "tripled 9 hello" in run["log"]
    # And they come back with the run, so the run page can say what it was given.
    assert client.get(f"/api/runs/{run['id']}").json()["params"]["factor"] == 3
    assert client.get("/api/runs").json()["runs"][0]["env"] == {"GREETING": "hello"}


def test_a_parameter_that_is_a_string_stays_a_string(client: TestClient) -> None:
    """``--param`` reads a Python literal, so ``"3"`` has to arrive quoted, not as 3."""
    started = client.post(
        "/api/runs",
        json={"path": "parameters.py", "runtime": "sync", "params": {"label": "3"}},
    )
    run = wait_for_run(client, started.json()["id"])
    assert run["status"] == "done", run["log"]
    assert "3 2 <none>" in run["log"], "the label was the string '3', doubled numbers after it"


@pytest.mark.parametrize(
    ("body", "says"),
    [
        ({"params": {"not a name": 1}}, "not a parameter name"),
        ({"env": {"not-a-name": "x"}}, "environment variable name"),
        ({"env": {"OK": {"nested": 1}}}, "env.OK"),
    ],
)
def test_a_run_with_input_that_is_not_input_is_refused(
    client: TestClient, body: dict[str, Any], says: str
) -> None:
    answer = client.post("/api/runs", json={"path": "parameters.py", **body})
    assert answer.status_code == 400
    assert says in answer.json()["error"]["message"]


def test_the_workspace_environment_reaches_every_run_and_a_run_may_win(
    client: TestClient,
) -> None:
    assert client.put("/api/settings", json={"env": {"GREETING": "from the workspace"}}).status_code
    plain = wait_for_run(
        client,
        client.post("/api/runs", json={"path": "parameters.py", "runtime": "sync"}).json()["id"],
    )
    assert "from the workspace" in plain["log"]

    # The run's own variables are applied after the workspace's, so a run can override one.
    mine = client.post(
        "/api/runs",
        json={"path": "parameters.py", "runtime": "sync", "env": {"GREETING": "from the run"}},
    )
    ended = wait_for_run(client, mine.json()["id"])
    assert "from the run" in ended["log"]
    assert "from the workspace" not in ended["log"]


@pytest.mark.parametrize(
    ("value", "text"),
    [(3, "3"), ("3", "'3'"), (0.5, "0.5"), (True, "True"), (None, "None"), ([1, 2], "[1, 2]")],
)
def test_a_parameter_is_written_as_the_literal_the_cli_reads_back(value: Any, text: str) -> None:
    assert param_argument("x", value) == f"x={text}"


def test_the_child_is_started_with_the_interpreter_from_the_settings(client: TestClient) -> None:
    """The command line the supervisor builds: the interpreter, then what it was given."""
    supervisor = client.app.state.supervisor  # type: ignore[attr-defined]
    argv = supervisor._argv(
        "parameters.py", "sync", 0, None, None, None, False, {"factor": 3}, {"TZ": "UTC"}
    )
    assert argv[:5] == [sys.executable, "-m", "tolquane", "run", "parameters.py"]
    assert argv[-4:] == ["--param", "factor=3", "--env", "TZ=UTC"]


# ----------------------------------------------------------------------- the interpreter


def test_the_interpreter_setting_is_run_before_it_is_saved(client: TestClient) -> None:
    current = client.get("/api/settings").json()
    assert current["python"] == sys.executable
    assert current["env"] == {}
    assert current["env_names"] == []
    assert current["auto_commit"] is False
    assert current["notifications"] == {
        "webhook_default": None,
        "smtp": None,
        "has_smtp_password": False,
    }

    same = client.put("/api/settings", json={"python": sys.executable})
    assert same.status_code == 200, same.text
    assert same.json()["python"] == sys.executable

    missing = client.put("/api/settings", json={"python": "/nowhere/python3"})
    assert missing.status_code == 400
    assert "pip install tolquane" in missing.json()["error"]["message"]

    # An interpreter that runs but has no Tolquane is the other half of the check.
    empty = client.put("/api/settings", json={"python": sys.executable + "-does-not-exist"})
    assert empty.status_code == 400
    assert client.get("/api/settings").json()["python"] == sys.executable


def test_an_interpreter_without_tolquane_is_named_with_its_fix(
    client: TestClient, tmp_path: Path
) -> None:
    """A shell script that is not Python at all stands in for a virtualenv without us."""
    fake = tmp_path / "python-without-tolquane"
    fake.write_text("#!/bin/sh\necho 'ModuleNotFoundError: No module named tolquane' >&2\nexit 1\n")
    fake.chmod(0o755)
    answer = client.put("/api/settings", json={"python": str(fake)})
    assert answer.status_code == 400
    message = answer.json()["error"]["message"]
    assert "cannot import tolquane" in message
    assert "pip install tolquane" in message


# ----------------------------------------------------------------------- the import probe


def test_check_says_what_the_flow_imports(client: TestClient, workspace: Path) -> None:  # noqa: F811
    """A flow of nothing but the standard library and Tolquane asks for nothing."""
    checked = client.post("/api/flows/parameters.py/check")
    assert checked.status_code == 200, checked.text
    assert checked.json()["imports"] == []

    (workspace / "needs.py").write_text(NEEDS_A_PACKAGE)
    refused = client.post("/api/flows/needs.py/check")
    assert refused.status_code == 400
    probes = refused.json()["error"]["detail"]["imports"]
    assert probes == [
        {
            "module": "definitely_not_a_real_module",
            "ok": False,
            "hint": "pip install definitely_not_a_real_module",
        }
    ]


def test_a_neighbour_module_is_not_a_missing_package(
    client: TestClient,
    workspace: Path,  # noqa: F811
) -> None:
    (workspace / "helpers.py").write_text("VALUE = 1\n")
    (workspace / "uses.py").write_text(
        PARAMETERS.replace("import os\n", "import os\n\nimport helpers\n")
    )
    checked = client.post("/api/flows/uses.py/check")
    assert checked.status_code == 200, checked.text
    assert checked.json()["imports"] == [], "helpers.py is next door, not on PyPI"


# --------------------------------------------------------------------------- schedules


def test_a_schedule_keeps_its_parameters_and_hands_them_to_its_runs(
    client: TestClient,
) -> None:
    made = client.post(
        "/api/schedules",
        json={
            "flow": "parameters.py",
            "cron": "*/5 * * * *",
            "runtime": "sync",
            "params": {"factor": 4, "label": "scheduled"},
            "env": {"GREETING": "on time"},
        },
    )
    assert made.status_code == 201, made.text
    schedule = made.json()
    assert schedule["params"] == {"factor": 4, "label": "scheduled"}
    assert schedule["env"] == {"GREETING": "on time"}
    assert schedule["retries"] == 0
    assert schedule["notify"] == {"events": [], "webhook": None, "emails": []}
    assert schedule["last_outcome"] is None

    fired = client.post(f"/api/schedules/{schedule['id']}/run")
    assert fired.status_code == 200, fired.text
    assert fired.json()["params"] == {"factor": 4, "label": "scheduled"}
    run = wait_for_run(client, fired.json()["id"])
    assert "scheduled 4 on time" in run["log"]

    changed = client.put(
        f"/api/schedules/{schedule['id']}", json={"params": {"factor": 1}, "retries": 2}
    )
    assert changed.json()["params"] == {"factor": 1}
    assert changed.json()["retries"] == 2
    assert client.get("/api/schedules").json()["schedules"][0]["retries"] == 2


def test_a_schedule_with_input_that_is_not_input_is_refused(client: TestClient) -> None:
    answer = client.post(
        "/api/schedules",
        json={"flow": "parameters.py", "cron": "@daily", "env": {"9lives": "no"}},
    )
    assert answer.status_code == 400
    assert "environment variable name" in answer.json()["error"]["message"]


# ------------------------------------------------------------------------------- roles


def test_a_member_sees_the_names_of_the_workspace_environment_and_not_the_values(
    team: Team,  # noqa: F811
) -> None:
    saved = team.client.put(
        "/api/settings", json={"env": {"API_HOST": "example.test"}}, headers=team.admin
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["env"] == {"API_HOST": "example.test"}

    view = team.client.get("/api/settings", headers=team.member).json()
    assert view["env"] is None
    assert view["env_names"] == ["API_HOST"]
    assert view["notifications"]["has_smtp_password"] is None
    assert view["python"] == sys.executable

    refused = team.client.put(
        "/api/settings", json={"env": {"API_HOST": "mine"}}, headers=team.member
    )
    assert refused.status_code == 403
    assert "env" in refused.json()["error"]["message"]
