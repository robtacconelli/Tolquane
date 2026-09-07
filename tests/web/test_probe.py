"""The import probe: what a flow file needs, and whether the run's interpreter has it.

The interpreter under test is this one, so the "present" module is one the test suite
itself imports and the "missing" ones are names nothing installs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from tolquane.web.probe import PIP_NAMES, Probe, imports_of, probe_imports

FLOW = '''"""A flow that needs a few things."""

import csv
import os.path

import numpy as np
import tolquane as tq
from bs4 import BeautifulSoup

import helpers


@tq.node
def parse(text: str) -> object:
    from cv2 import imread  # an optional dependency, imported where it is used

    return imread(text)
'''


def _fake(tmp_path: Path, name: str, script: str) -> str:
    """An executable that stands in for an interpreter, so failures can be tested."""
    path = tmp_path / name
    path.write_text(f"#!/bin/sh\n{script}\n", encoding="utf-8")
    path.chmod(0o755)
    return str(path)


# --------------------------------------------------------------------------- reading


def test_the_imports_are_the_top_level_names_the_file_mentions() -> None:
    # csv and os are the standard library, tolquane is the library itself, and every
    # import counts wherever it is written: cv2 sits inside a node.
    assert imports_of(FLOW) == ["bs4", "cv2", "helpers", "numpy"]


def test_a_relative_import_names_nothing_to_install() -> None:
    assert imports_of("from . import shared\nfrom .parts import one\n") == []


def test_a_file_that_does_not_parse_has_no_imports() -> None:
    assert imports_of("import (((\n") == []


def test_a_module_imported_twice_is_asked_about_once() -> None:
    assert imports_of("import numpy\nimport numpy.linalg\nfrom numpy import array\n") == ["numpy"]


# --------------------------------------------------------------------------- asking


def test_what_this_interpreter_has_and_what_it_has_not() -> None:
    source = "import pytest\nimport numpy\nfrom cv2 import imread\n"
    found = probe_imports(source, sys.executable)
    assert [p.module for p in found] == ["cv2", "numpy", "pytest"]  # deterministic order
    assert found[2] == Probe("pytest", True, None)
    assert found[1] == Probe("numpy", False, "pip install numpy")
    assert found[0] == Probe("cv2", False, "pip install opencv-python")
    assert found[2].to_dict() == {"module": "pytest", "ok": True, "hint": None}


@pytest.mark.parametrize(("module", "distribution"), sorted(PIP_NAMES.items()))
def test_the_rename_map_names_the_distribution(module: str, distribution: str) -> None:
    (found,) = probe_imports(f"import {module}\n", sys.executable)
    if found.ok:
        pytest.skip(f"{module} is installed in this environment")
    assert found.hint == f"pip install {distribution}"


def test_a_file_that_needs_nothing_asks_nobody(tmp_path: Path) -> None:
    # The interpreter would fail if it were run at all, so [] proves no child was started.
    broken = _fake(tmp_path, "broken", "exit 1")
    assert probe_imports("import json\nimport tolquane as tq\n", broken) == []


def test_the_flows_own_neighbours_are_not_missing_packages(tmp_path: Path) -> None:
    flow = tmp_path / "flow.py"
    (tmp_path / "helpers.py").write_text("VALUE = 1\n", encoding="utf-8")
    (tmp_path / "shared").mkdir()
    (tmp_path / "shared" / "__init__.py").write_text("", encoding="utf-8")
    source = "import helpers\nimport shared\nimport numpy\n"
    assert [p.module for p in probe_imports(source, sys.executable, path=flow)] == ["numpy"]
    # Without the path there is nothing to compare against, so they are asked about.
    assert [p.module for p in probe_imports(source, sys.executable)] == [
        "helpers",
        "numpy",
        "shared",
    ]


def test_a_node_flow_file_is_probed_with_its_neighbour(tmp_path: Path) -> None:
    flow = tmp_path / "flow.py"
    flow.write_text(FLOW, encoding="utf-8")
    (tmp_path / "helpers.py").write_text("VALUE = 1\n", encoding="utf-8")
    found = probe_imports(FLOW, sys.executable, path=flow)
    assert [p.module for p in found] == ["bs4", "cv2", "numpy"]
    assert all(not p.ok and p.hint and p.hint.startswith("pip install ") for p in found)


# --------------------------------------------------------------------------- bad interpreters


def test_an_interpreter_that_is_not_there_is_the_answer_itself() -> None:
    (found,) = probe_imports("import numpy\n", "/nowhere/python3")
    assert found.module == "numpy"
    assert not found.ok
    assert found.hint is not None
    assert found.hint.startswith("could not ask /nowhere/python3: ")


@pytest.mark.skipif(sys.platform == "win32", reason="the fake interpreters are sh scripts")
def test_an_interpreter_that_fails_says_why(tmp_path: Path) -> None:
    broken = _fake(tmp_path, "python-broken", "echo 'no python here' >&2\nexit 2")
    found = probe_imports("import numpy\nimport pytest\n", broken)
    assert [p.module for p in found] == ["numpy", "pytest"]
    assert all(not p.ok for p in found)
    assert all(p.hint == f"could not ask {broken}: no python here" for p in found)


@pytest.mark.skipif(sys.platform == "win32", reason="the fake interpreters are sh scripts")
def test_an_interpreter_that_never_answers_times_out(tmp_path: Path) -> None:
    slow = _fake(tmp_path, "python-slow", "sleep 30")
    (found,) = probe_imports("import numpy\n", slow, timeout=0.5)
    assert not found.ok
    assert found.hint == f"could not ask {slow}: it did not answer within 0.5 seconds"


@pytest.mark.skipif(sys.platform == "win32", reason="the fake interpreters are sh scripts")
def test_a_half_answer_leaves_the_rest_unknown(tmp_path: Path) -> None:
    partial = _fake(tmp_path, "python-partial", "echo 'numpy ok'\nexit 3")
    found = {p.module: p for p in probe_imports("import numpy\nimport pytest\n", partial)}
    assert found["numpy"].ok
    assert not found["pytest"].ok
    assert found["pytest"].hint == (
        f"could not ask {partial}: it stopped before answering (exit code 3)"
    )
