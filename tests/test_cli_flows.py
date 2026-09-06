"""``tolquane run`` accepts a flow with build(source=None) or one whose main() calls tq.run."""

from __future__ import annotations

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
