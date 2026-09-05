"""Every flow the builder wrote still checks and runs, on the sample files next to it."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

GENERATED = Path(__file__).resolve().parents[1] / "examples" / "generated"
FLOWS = sorted(p for p in GENERATED.iterdir() if (p / "flow.py").exists())
NETWORK = {"url_status_report"}

_RUN = """
import sys, io, contextlib
sys.path.insert(0, sys.argv[1])
import tolquane as tq, flow
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    report = tq.run(flow.build(), runtime="sync")
print(f"@@{len(buf.getvalue().splitlines())} lines; {len(report.nodes)} nodes")
"""


def _run_script(directory: Path) -> str:
    done = subprocess.run(
        [sys.executable, "flow.py"], capture_output=True, text=True, cwd=directory, timeout=300
    )
    assert done.returncode == 0, done.stderr[-2000:]
    return done.stdout


@pytest.mark.parametrize("directory", FLOWS, ids=[p.name for p in FLOWS])
def test_generated_flow_checks_and_runs(directory: Path) -> None:
    check = subprocess.run(
        [sys.executable, "-m", "tolquane.cli", "check", "flow.py"],
        capture_output=True,
        text=True,
        cwd=directory,
        timeout=120,
    )
    assert check.returncode == 0, check.stderr
    assert check.stdout.startswith("OK:")
    transcript = json.loads((directory / "transcript.json").read_text())
    assert transcript["turns"][-1]["calls"] == []  # ended with a summary, not a tool call
    assert all(not r["is_error"] for t in transcript["turns"] for r in t["results"])
    if directory.name in NETWORK:
        return
    ran = subprocess.run(
        [sys.executable, "-c", _RUN, str(directory)],
        capture_output=True,
        text=True,
        cwd=directory,
        timeout=300,
    )
    assert ran.returncode == 0, ran.stderr[-2000:]
    assert "@@" in ran.stdout


def test_expected_outputs() -> None:
    assert _run_script(GENERATED / "fibonacci_ordered").splitlines()[:3] == [
        "fib( 1) = 1",
        "fib( 2) = 1",
        "fib( 3) = 2",
    ]
    primes = _run_script(GENERATED / "primes_in_order").splitlines()
    assert primes[:5] == ["2", "3", "5", "7", "11"]
    assert primes[-1] == "2262 primes"
    regions = _run_script(GENERATED / "csv_region_totals").splitlines()
    assert [line.split()[0] for line in regions] == ["east", "north", "south", "west"]
    assert regions[0].split()[1] == "205.00"
    errors = _run_script(GENERATED / "log_error_counts").splitlines()
    assert errors[0].split() == ["3", "api"]
    assert errors[1].split() == ["2", "db"]
    assert "wrote 3 unique records" in _run_script(GENERATED / "dedupe_records")
    assert "sqrt(2) = 1.414213562373" in _run_script(GENERATED / "newton_sqrt_feedback")
    freq = _run_script(GENERATED / "word_frequency").splitlines()
    assert len(freq) == 10
    assert int(freq[0].split()[1]) >= int(freq[1].split()[1])
    average = [ln for ln in _run_script(GENERATED / "moving_average").splitlines() if "avg5=" in ln]
    assert len(average) == 96  # 100 readings, first average once 5 are in
    rows = _run_script(GENERATED / "row_normalize").splitlines()
    assert len(rows) == 3
    assert "1.0" in rows[0]
