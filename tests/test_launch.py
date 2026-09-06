"""``tolquane launch``: every group of a deploy file from one command."""

from __future__ import annotations

import socket
import subprocess
import sys
from pathlib import Path

import tolquane as tq
from tolquane.launch import commands

FLOW = """
import tolquane as tq

@tq.source
def numbers():
    yield from range(1, 11)

@tq.node
def double(x):
    return x * 2

@tq.sink
def show(x):
    print("got", x, flush=True)

def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.farm(double, 2) >> show

def main():
    tq.run(build())

if __name__ == "__main__":
    main()
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _deploy(a: int, b: int) -> str:
    return (
        f'[groups.A]\nendpoint = "127.0.0.1:{a}"\n'
        'nodes = ["numbers", "double.emitter", "double.collector"]\n'
        f'[groups.B]\nendpoint = "127.0.0.1:{b}"\nnodes = ["double.[0-9]*", "show"]\n'
    )


def test_commands_local_and_remote() -> None:
    deployment = tq.load_deployment(
        {
            "groups": {
                "A": {"endpoint": "localhost:7000", "nodes": ["x"]},
                "B": {
                    "endpoint": "10.9.9.9:7000",
                    "nodes": ["y"],
                    "ssh": "me@box",
                    "workdir": "/srv",
                },
            },
            "options": {"python": "python3.13"},
        }
    )
    plan = commands(deployment, "d.toml", "flow.py", runtime="processes", stats=True)
    (_a, argv_a, local_a), (_b, argv_b, local_b) = plan
    assert local_a
    assert argv_a[:4] == ["python3.13", "-m", "tolquane", "run"]
    assert "--group" in argv_a
    assert argv_a[argv_a.index("--group") + 1] == "A"
    assert "--stats" in argv_a
    assert "processes" in argv_a
    assert not local_b
    assert argv_b[:2] == ["ssh", "-T"]
    assert argv_b[-2] == "me@box"
    assert argv_b[-1].startswith("cd /srv && exec python3.13 -m tolquane run flow.py")


def test_launch_two_local_groups(tmp_path: Path) -> None:
    (tmp_path / "flow.py").write_text(FLOW)
    (tmp_path / "deploy.toml").write_text(_deploy(_free_port(), _free_port()))
    dry = subprocess.run(
        [sys.executable, "-m", "tolquane", "launch", "deploy.toml", "flow.py", "--dry-run"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert dry.returncode == 0
    assert "[A] here:" in dry.stdout
    assert "[B] here:" in dry.stdout
    proc = subprocess.run(
        [sys.executable, "-m", "tolquane", "launch", "deploy.toml", "flow.py", "--show", "B"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    got = sorted(int(line.split()[-1]) for line in proc.stdout.splitlines() if "got" in line)
    assert got == [2 * i for i in range(1, 11)]
    assert all(line.startswith("[B]") for line in proc.stdout.splitlines() if line.strip())


def test_launch_reports_a_failing_group(tmp_path: Path) -> None:
    (tmp_path / "flow.py").write_text(FLOW.replace("return x * 2", "raise ValueError('boom')"))
    (tmp_path / "deploy.toml").write_text(_deploy(_free_port(), _free_port()))
    proc = subprocess.run(
        [sys.executable, "-m", "tolquane", "launch", "deploy.toml", "flow.py"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode != 0
    assert "group(s) failed" in proc.stderr
