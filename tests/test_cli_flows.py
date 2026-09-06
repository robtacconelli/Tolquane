"""The command line: running a flow that has only main(), and `tolquane web`'s own flags."""

from __future__ import annotations

import json
import socket
import webbrowser
from pathlib import Path

import pytest

from tolquane.cli import main

MAIN_ONLY = """
import tolquane as tq

@tq.source
def numbers():
    yield from range(3)

@tq.sink
def show(x):
    print("got", x)

def main():
    tq.run(numbers >> show)

if __name__ == "__main__":
    main()
"""


def test_run_a_flow_with_only_main(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    flow = tmp_path / "flow.py"
    flow.write_text(MAIN_ONLY)
    assert main(["run", str(flow)]) == 0
    assert capsys.readouterr().out.count("got") == 3
    assert main(["check", str(flow)]) == 0


def test_sample_needs_build(tmp_path: Path) -> None:
    flow = tmp_path / "flow.py"
    flow.write_text(MAIN_ONLY)
    (tmp_path / "s.json").write_text("[1, 2]")
    with pytest.raises(SystemExit, match="needs build"):
        main(["run", str(flow), "--sample", str(tmp_path / "s.json")])


def test_neither_build_nor_main(tmp_path: Path) -> None:
    flow = tmp_path / "flow.py"
    flow.write_text("import tolquane as tq\n")
    with pytest.raises(SystemExit, match="define build"):
        main(["run", str(flow)])


# --------------------------------------------------------------- tolquane web, the command


def _free_port() -> int:
    """A port nothing is on right now: what a test can ask the server to take."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def test_web_openapi_prints_the_contract(capsys: pytest.CaptureFixture[str]) -> None:
    """`tolquane web --openapi > web/openapi.json` is how the frontend's types are made."""
    pytest.importorskip("fastapi")
    assert main(["web", "--openapi"]) == 0
    document = json.loads(capsys.readouterr().out)
    assert document["openapi"].startswith("3.")
    assert document["paths"]["/api/health"]["get"]["operationId"] == "getHealth"


def test_web_version_says_what_would_start(capsys: pytest.CaptureFixture[str]) -> None:
    import tolquane

    assert main(["web", "--version"]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"tolquane {tolquane.__version__}\n")
    assert "frontend:" in out
    assert "server:" in out


def test_web_start_line_and_no_browser(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    uvicorn = pytest.importorskip("uvicorn")
    monkeypatch.setenv("TOLQUANE_HOME", str(tmp_path / "home"))
    served: list[tuple[str, int]] = []
    monkeypatch.setattr(uvicorn, "run", lambda app, host, port, **kw: served.append((host, port)))
    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", lambda url: opened.append(url))
    port = _free_port()
    code = main(["web", "--no-browser", "--port", str(port), "--workspace", str(tmp_path)])
    assert code == 0
    assert served == [("127.0.0.1", port)]
    line = capsys.readouterr().out.splitlines()[0]
    assert f"http://127.0.0.1:{port}/" in line
    assert str(tmp_path) in line
    assert not opened


def test_web_says_when_the_port_is_taken(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("uvicorn")
    monkeypatch.setenv("TOLQUANE_HOME", str(tmp_path / "home"))
    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        held.listen(1)
        port = int(held.getsockname()[1])
        code = main(["web", "--no-browser", "--port", str(port), "--workspace", str(tmp_path)])
    assert code == 1
    err = capsys.readouterr().err
    assert "already in use" in err
    assert f"--port {port + 1}" in err


def test_web_check_starts_and_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("uvicorn")
    monkeypatch.setenv("TOLQUANE_HOME", str(tmp_path / "home"))
    assert main(["web", "--check", "--no-browser", "--workspace", str(tmp_path)]) == 0
    assert "ok, workspace" in capsys.readouterr().out


def test_web_wants_a_workspace_that_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("uvicorn")
    monkeypatch.setenv("TOLQUANE_HOME", str(tmp_path / "home"))
    assert main(["web", "--check", "--workspace", str(tmp_path / "nowhere")]) == 1
    assert "not a directory" in capsys.readouterr().err
