"""The command line: flows with only main(), --param and --env, and `tolquane web`'s flags."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
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


# ------------------------------------------------------------------ parameters and the environment


PARAMS_FLOW = """
import os

import tolquane as tq


@tq.source
def numbers():
    yield from range(3)


@tq.sink
def show(x):
    print("got", x)


def build(source=None, *, factor: int = 1, label: str = "n"):
    start = numbers if source is None else tq.from_iterable(source)
    tag = os.environ.get("TOLQUANE_TAG", "-")
    return start >> tq.node(lambda x: f"{label}{x * factor}{tag}") >> show
"""

PLAIN_FLOW = """
import tolquane as tq


@tq.source
def numbers():
    yield from range(2)


@tq.sink
def show(x):
    print("got", x)


def build(source=None):
    return numbers >> show
"""


def _flow(tmp_path: Path, source: str = PARAMS_FLOW, name: str = "flow.py") -> str:
    path = tmp_path / name
    path.write_text(source)
    return str(path)


def test_the_defaults_are_used_when_no_param_is_given(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["run", _flow(tmp_path)]) == 0
    assert capsys.readouterr().out.split() == ["got", "n0-", "got", "n1-", "got", "n2-"]


def test_params_reach_build_as_the_literals_they_look_like(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # factor=10 is the number ten, label=v is the word: a plain word stays a string.
    assert main(["run", _flow(tmp_path), "--param", "factor=10", "--param", "label=v"]) == 0
    assert capsys.readouterr().out.split() == ["got", "v0-", "got", "v10-", "got", "v20-"]


def test_check_explain_and_draw_take_params_too(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    flow = _flow(tmp_path)
    for command in ("check", "explain", "draw"):
        assert main([command, flow, "--param", "factor=3"]) == 0
        assert capsys.readouterr().out


def test_an_unknown_param_names_the_flows_parameters(tmp_path: Path) -> None:
    flow = _flow(tmp_path)
    with pytest.raises(SystemExit, match="this flow's parameters are: factor, label"):
        main(["run", flow, "--param", "nope=1"])
    # The sample is what feeds `source`, so it is not a parameter either.
    with pytest.raises(SystemExit, match="no parameter 'source'"):
        main(["run", flow, "--param", "source=[1]"])


def test_a_flow_with_no_parameters_says_so(tmp_path: Path) -> None:
    flow = _flow(tmp_path, PLAIN_FLOW, "plain.py")
    with pytest.raises(SystemExit, match="no parameter 'factor'; this flow has none"):
        main(["run", flow, "--param", "factor=2"])


def test_a_param_without_a_value_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="--param takes name=value"):
        main(["run", _flow(tmp_path), "--param", "factor"])


def test_param_needs_a_build(tmp_path: Path) -> None:
    flow = _flow(tmp_path, MAIN_ONLY, "mainonly.py")
    with pytest.raises(SystemExit, match="--param needs build"):
        main(["run", flow, "--param", "factor=2"])


def test_env_is_set_for_the_run_and_put_back_afterwards(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert "TOLQUANE_TAG" not in os.environ
    assert main(["run", _flow(tmp_path), "--env", "TOLQUANE_TAG=!"]) == 0
    assert capsys.readouterr().out.split() == ["got", "n0!", "got", "n1!", "got", "n2!"]
    assert "TOLQUANE_TAG" not in os.environ  # the process is left as it was found


def test_env_covers_the_import_of_the_flow(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # TAG is read while the module is imported, which happens after --env is applied.
    at_import = PARAMS_FLOW.replace(
        'tag = os.environ.get("TOLQUANE_TAG", "-")', "tag = TAG"
    ).replace("import tolquane as tq", 'import tolquane as tq\n\nTAG = os.environ["TOLQUANE_TAG"]')
    flow = _flow(tmp_path, at_import, "at_import.py")
    assert main(["run", flow, "--env", "TOLQUANE_TAG=?"]) == 0
    assert capsys.readouterr().out.split() == ["got", "n0?", "got", "n1?", "got", "n2?"]


def test_an_env_without_a_value_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="--env takes NAME=value"):
        main(["run", _flow(tmp_path), "--env", "TOLQUANE_TAG"])


def test_the_start_event_carries_the_params_and_the_names_of_the_environment(
    tmp_path: Path,
) -> None:
    flow = _flow(tmp_path)
    done = subprocess.run(
        [
            sys.executable,
            "-m",
            "tolquane",
            "run",
            flow,
            "--events",
            "--param",
            "factor=2",
            "--param",
            "label=x",
            "--env",
            "TOLQUANE_TAG=secret",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    events = [json.loads(line) for line in done.stdout.splitlines()]
    start = events[0]
    assert start["event"] == "start"
    assert start["params"] == {"factor": 2, "label": "x"}  # 2 is a number, "x" a word
    assert start["env"] == ["TOLQUANE_TAG"]  # names only: a value is where a secret lives
    assert "secret" not in json.dumps(start)  # only the flow itself may print a value
    printed = [e["text"] for e in events if e["event"] == "stdout"]
    assert printed == ["got x0secret\n", "got x2secret\n", "got x4secret\n"]


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
