"""The history of a flow: a real git repository in a temporary directory.

Nothing is mocked. ``git init`` happens through the route an administrator would press,
commits are made by the save route with a message, and the entries, the old version, the
diff and the restore are read back the same way the History tab reads them. The identity
comes from the commit itself (``-c user.name``/``-c user.email``), so this touches no
global git configuration.
"""

from __future__ import annotations

import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="the web extra: pip install 'tolquane[web]'")
pytest.importorskip("httpx", reason="the test client needs httpx")

from fastapi.testclient import TestClient
from test_server import HELLO, make_settings, workspace  # noqa: F401
from test_users import Team, clock, team  # noqa: F401

from tolquane.web import history
from tolquane.web.server import create_app
from tolquane.web.settings import AppSettings

pytestmark = pytest.mark.skipif(history.git_path() is None, reason="git is not installed")


@pytest.fixture
def settings(tmp_path: Path, workspace: Path) -> AppSettings:  # noqa: F811
    return make_settings(tmp_path, workspace)


@pytest.fixture
def client(settings: AppSettings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as made:
        yield made


@pytest.fixture
def repo(client: TestClient) -> TestClient:
    """A workspace that is a repository, with the flow it started with committed."""
    assert client.post("/api/workspace/history/init").json() == {"ok": True}
    opened = client.get("/api/flows/hello.py").json()
    saved = client.put(
        "/api/flows/hello.py",
        json={
            "source": opened["source"],
            "modified": opened["modified"],
            "commit": {"message": "The first flow"},
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["commit"]["rev"]
    return client


def log_of(workspace: Path) -> list[str]:  # noqa: F811
    done = subprocess.run(
        ["git", "log", "--format=%an <%ae> %s"],
        cwd=workspace,
        capture_output=True,
        text=True,
        check=False,
    )
    return [line for line in done.stdout.splitlines() if line.strip()]


# ------------------------------------------------------------------ what there is to read


def test_a_workspace_without_a_repository_says_so(client: TestClient) -> None:
    status = client.get("/api/workspace/history").json()
    assert status == {
        "available": False,
        "reason": history.NOT_A_REPO,
        "repo": False,
        "root": None,
        "dirty": 0,
    }
    refused = client.get("/api/flows/hello.py/history")
    assert refused.status_code == 400
    assert "not in a git repository" in refused.json()["error"]["message"]


def test_no_git_at_all_is_a_reason_and_not_a_crash(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(history, "git_path", lambda: None)
    status = client.get("/api/workspace/history").json()
    assert status["available"] is False
    assert status["repo"] is False
    assert "git is not on PATH" in status["reason"]


def test_init_makes_a_repository_and_a_gitignore(client: TestClient, workspace: Path) -> None:  # noqa: F811
    assert client.post("/api/workspace/history/init").json() == {"ok": True}
    status = client.get("/api/workspace/history").json()
    assert status["available"] is True
    assert status["repo"] is True
    assert Path(status["root"]).resolve() == workspace.resolve()
    assert status["dirty"] == 2, "hello.py and .gitignore, neither committed yet"
    ignored = (workspace / ".gitignore").read_text()
    assert ".tolquane-web/" in ignored
    assert "__pycache__/" in ignored
    # A second init is refused rather than doing anything surprising to the first.
    assert client.post("/api/workspace/history/init").status_code == 400


def test_only_an_administrator_may_start_a_history(team: Team) -> None:  # noqa: F811
    refused = team.client.post("/api/workspace/history/init", headers=team.member)
    assert refused.status_code == 403
    assert refused.json()["error"]["type"] == "Forbidden"
    assert team.client.post("/api/workspace/history/init", headers=team.admin).status_code == 200
    assert team.client.get("/api/workspace/history", headers=team.member).json()["repo"] is True


# ---------------------------------------------------------------------------- commits


def test_a_save_with_a_message_commits_the_flow_and_its_sidecar(
    repo: TestClient,
    workspace: Path,  # noqa: F811
) -> None:
    client = repo
    layout = client.put("/api/flows/hello.py/layout", json={"version": 1, "positions": {}})
    assert layout.status_code == 200, layout.text
    opened = client.get("/api/flows/hello.py").json()
    saved = client.put(
        "/api/flows/hello.py",
        json={
            "source": HELLO.replace("x * 2", "x * 5"),
            "modified": opened["modified"],
            "commit": {"message": "Multiply by five"},
        },
    )
    assert saved.status_code == 200, saved.text
    made = saved.json()["commit"]
    assert made["short"]
    assert made["rev"].startswith(made["short"])

    listed = client.get("/api/flows/hello.py/history").json()
    assert [entry["message"] for entry in listed["entries"]] == [
        "Multiply by five",
        "The first flow",
    ]
    assert listed["entries"][0]["head"] is True
    assert listed["entries"][1]["head"] is False
    assert listed["entries"][0]["author"] == "local"
    assert listed["uncommitted"] is False

    files = subprocess.run(
        ["git", "show", "--name-only", "--format=", "HEAD"],
        cwd=workspace,
        capture_output=True,
        text=True,
        check=False,
    ).stdout.split()
    assert sorted(files) == ["hello.layout.json", "hello.py"]
    assert log_of(workspace)[0] == "local <local@tolquane.local> Multiply by five"


def test_a_save_without_a_message_does_not_commit_unless_auto_commit_is_on(
    repo: TestClient,
    workspace: Path,  # noqa: F811
) -> None:
    client = repo
    opened = client.get("/api/flows/hello.py").json()
    quiet = client.put(
        "/api/flows/hello.py",
        json={"source": HELLO.replace("x * 2", "x * 3"), "modified": opened["modified"]},
    )
    assert quiet.json()["commit"] is None
    assert client.get("/api/flows/hello.py/history").json()["uncommitted"] is True

    assert client.put("/api/settings", json={"auto_commit": True}).status_code == 200
    opened = client.get("/api/flows/hello.py").json()
    automatic = client.put(
        "/api/flows/hello.py",
        json={"source": HELLO.replace("x * 2", "x * 4"), "modified": opened["modified"]},
    )
    assert automatic.json()["commit"] is not None
    assert log_of(workspace)[0].endswith("Edit hello.py")
    assert client.get("/api/flows/hello.py/history").json()["uncommitted"] is False


def test_a_save_that_changes_nothing_is_not_a_commit(repo: TestClient) -> None:
    opened = repo.get("/api/flows/hello.py").json()
    again = repo.put(
        "/api/flows/hello.py",
        json={
            "source": opened["source"],
            "modified": opened["modified"],
            "commit": {"message": "Nothing at all"},
        },
    )
    assert again.status_code == 200
    assert again.json()["commit"] is None


def test_asking_for_a_commit_without_a_repository_saves_nothing(
    client: TestClient,
    workspace: Path,  # noqa: F811
) -> None:
    opened = client.get("/api/flows/hello.py").json()
    refused = client.put(
        "/api/flows/hello.py",
        json={
            "source": HELLO.replace("x * 2", "x * 9"),
            "modified": opened["modified"],
            "commit": {"message": "Nowhere to put it"},
        },
    )
    assert refused.status_code == 400
    assert "not in a git repository" in refused.json()["error"]["message"]
    assert "x * 9" not in (workspace / "hello.py").read_text(), "the file was left alone"


def test_the_commit_is_made_by_whoever_saved(team: Team, workspace: Path) -> None:  # noqa: F811
    client = team.client
    assert client.post("/api/workspace/history/init", headers=team.admin).status_code == 200
    opened = client.get("/api/flows/hello.py", headers=team.member).json()
    saved = client.put(
        "/api/flows/hello.py",
        json={
            "source": opened["source"],
            "modified": opened["modified"],
            "commit": {"message": "Bob was here"},
        },
        headers=team.member,
    )
    assert saved.status_code == 200, saved.text
    assert log_of(workspace)[0] == "bob <bob@tolquane.local> Bob was here"
    assert client.get("/api/flows/hello.py/history", headers=team.member).json()["entries"][0][
        "author"
    ] == ("bob")


# ---------------------------------------------------------------- reading and restoring


def test_a_version_comes_back_with_the_diff_against_the_file_now(repo: TestClient) -> None:
    client = repo
    first = client.get("/api/flows/hello.py/history").json()["entries"][0]["rev"]
    opened = client.get("/api/flows/hello.py").json()
    client.put(
        "/api/flows/hello.py",
        json={"source": HELLO.replace("x * 2", "x * 7"), "modified": opened["modified"]},
    )
    version = client.get(f"/api/flows/hello.py/history/{first}").json()
    assert version["rev"] == first
    assert "x * 2" in version["source"]
    assert "x * 7" not in version["source"]
    assert "-    return x * 2" in version["diff"]
    assert "+    return x * 7" in version["diff"]

    assert client.get("/api/flows/hello.py/history/deadbeef").status_code == 400
    assert client.get("/api/flows/hello.py/history/--upload-pack=evil").status_code == 400


def test_restore_writes_the_old_file_back_and_does_not_commit(
    repo: TestClient,
    workspace: Path,  # noqa: F811
) -> None:
    client = repo
    rev = client.get("/api/flows/hello.py/history").json()["entries"][0]["rev"]
    opened = client.get("/api/flows/hello.py").json()
    client.put(
        "/api/flows/hello.py",
        json={"source": HELLO.replace("x * 2", "x * 8"), "modified": opened["modified"]},
    )
    restored = client.post("/api/flows/hello.py/restore", json={"rev": rev})
    assert restored.status_code == 200, restored.text
    assert "x * 2" in restored.json()["source"]
    assert "x * 2" in (workspace / "hello.py").read_text()
    assert restored.json()["model"]["name"] == "hello", "the flow comes back parsed"
    assert len(log_of(workspace)) == 1, "a restore is not a commit"


def test_the_history_of_a_flow_that_was_renamed_follows_it(
    repo: TestClient,
    workspace: Path,  # noqa: F811
) -> None:
    client = repo
    moved = client.post("/api/flows/hello.py/rename", json={"path": "greet.py"})
    assert moved.status_code == 200
    saved = client.put(
        "/api/flows/greet.py",
        json={
            "source": moved.json()["source"],
            "modified": moved.json()["modified"],
            "commit": {"message": "Renamed to greet"},
        },
    )
    assert saved.json()["commit"] is not None
    entries = client.get("/api/flows/greet.py/history").json()["entries"]
    assert [entry["message"] for entry in entries] == ["Renamed to greet", "The first flow"]


def test_a_flow_that_was_never_committed_has_no_entries(repo: TestClient) -> None:
    made = repo.post("/api/flows", json={"path": "fresh.py", "template": "hello"})
    assert made.status_code == 201
    listed = repo.get("/api/flows/fresh.py/history").json()
    assert listed == {"entries": [], "uncommitted": True}


def test_the_history_routes_refuse_a_path_that_leaves_the_workspace(repo: TestClient) -> None:
    assert repo.get("/api/flows/..%2Fsecret.py/history").status_code == 400
    assert repo.post("/api/flows/..%2Fsecret.py/restore", json={"rev": "HEAD"}).status_code == 400


# ------------------------------------------------------------------ the module itself


def test_git_is_never_asked_to_push_or_reset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The one rule of the module: nothing here can throw work away."""
    seen: list[tuple[str, ...]] = []
    real = history.git

    def watched(where: Path, *args: str, timeout: float = history.TIMEOUT) -> object:
        seen.append(args)
        return real(where, *args, timeout=timeout)

    monkeypatch.setattr(history, "git", watched)
    ws = tmp_path / "space"
    ws.mkdir()
    history.init(ws)
    (ws / "a.py").write_text("print(1)\n")
    made = history.commit(ws, ["a.py"], "One", "ada")
    assert made is not None
    history.entries(ws, "a.py")
    history.show(ws, made.rev, "a.py")
    history.diff(ws, made.rev, "a.py")
    history.restore(ws, made.rev, ["a.py"])
    verbs = {args[0] for args in seen if args}
    assert verbs <= {"init", "rev-parse", "status", "log", "show", "diff", "add", "-c"}
    assert not verbs & {"push", "reset", "checkout", "clean", "rebase"}


@pytest.mark.parametrize("rev", ["", "-x", "--upload-pack=evil", "a b", "a;b"])
def test_a_revision_that_is_not_one_is_refused(rev: str) -> None:
    with pytest.raises(ValueError, match="is not a revision"):
        history.check_rev(rev)


@pytest.mark.parametrize(
    ("given", "wanted"),
    [("ada", "ada"), ("a <b>\nc", "a  b  c"), ("", "tolquane"), ("   ", "tolquane")],
)
def test_an_author_name_cannot_break_the_commit(given: str, wanted: str) -> None:
    assert history.author_name(given) == wanted
