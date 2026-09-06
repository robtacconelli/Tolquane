"""What a flow file imports, and whether the interpreter that would run it has them.

A flow that says ``import pandas`` fails at import time, before any node runs, with a
traceback the canvas cannot draw. The probe reads the imports out of the text with
``ast`` and asks the run's own interpreter, in one child process, which of them it can
import; what is missing comes back with the ``pip install`` line that fixes it.

    from tolquane.web.probe import probe_imports

    for found in probe_imports(source, python, path="/w/flow.py"):
        if not found.ok:
            print(found.module, found.hint)

The standard library, ``tolquane`` itself and the flow's own neighbours (a ``.py`` next
to it with that name) are never asked about: they are not on PyPI, or they are already
there.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TIMEOUT = 20.0
"""Seconds the child interpreter gets to answer for the whole file."""

PIP_NAMES = {
    "cv2": "opencv-python",
    "PIL": "pillow",
    "sklearn": "scikit-learn",
    "yaml": "pyyaml",
    "bs4": "beautifulsoup4",
    "dotenv": "python-dotenv",
}
"""Modules whose distribution goes by another name. The hint has to be copy-pasteable."""

_SCRIPT = """
import importlib
import sys

for name in sys.argv[1:]:
    try:
        importlib.import_module(name)
    except BaseException:
        print(name, "no", flush=True)
    else:
        print(name, "ok", flush=True)
"""
"""One child call for the whole list: starting an interpreter is the slow part."""


@dataclass(frozen=True)
class Probe:
    """One import of a flow file: the module, whether it is there, and what would fix it."""

    module: str
    ok: bool
    hint: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"module": self.module, "ok": self.ok, "hint": self.hint}


def imports_of(source: str) -> list[str]:
    """The top-level modules a flow file imports, sorted, without the ones nobody installs.

    Every ``import`` statement counts, including the ones inside a function: an optional
    dependency imported where it is used still stops the run when it is missing. Relative
    imports name nothing to install, so they are left out.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []  # a file that does not parse has other problems to report first
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            found.add(node.module.split(".")[0])
    return sorted(name for name in found if _worth_asking(name))


def _worth_asking(module: str) -> bool:
    return bool(module) and module != "tolquane" and module not in sys.stdlib_module_names


def probe_imports(
    source: str,
    python: str,
    *,
    path: str | Path | None = None,
    timeout: float = TIMEOUT,
) -> list[Probe]:
    """Ask ``python`` whether it can import what this flow file imports.

    ``path`` is the flow's own path when it has one, so a module that is simply the file
    next door is not reported as missing; without it every neighbour looks like a package
    that is not installed. An interpreter that cannot be run at all is not an exception:
    each module comes back ``ok=False`` with the reason as its hint, because the answer
    the caller wants is "this run would not start", either way.
    """
    modules = [m for m in imports_of(source) if not _is_neighbour(m, path)]
    if not modules:
        return []
    answers, failure = _ask(python, modules, timeout)
    out: list[Probe] = []
    for module in modules:
        if module in answers:
            ok = answers[module]
            out.append(Probe(module, ok, None if ok else f"pip install {_pip_name(module)}"))
        else:
            out.append(Probe(module, False, f"could not ask {python}: {failure}"))
    return out


def _pip_name(module: str) -> str:
    return PIP_NAMES.get(module, module)


def _is_neighbour(module: str, path: str | Path | None) -> bool:
    """A module of the workspace itself: the flow's own sibling file or package."""
    if path is None:
        return False
    folder = Path(path).parent
    return (folder / f"{module}.py").is_file() or (folder / module / "__init__.py").is_file()


def _ask(python: str, modules: list[str], timeout: float) -> tuple[dict[str, bool], str]:
    """One child interpreter, one line per module: ``<module> ok`` or ``<module> no``."""
    try:
        done = subprocess.run(
            [python, "-c", _SCRIPT, *modules],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {}, f"it did not answer within {timeout:g} seconds"
    except OSError as exc:
        return {}, str(exc)
    answers: dict[str, bool] = {}
    for line in done.stdout.splitlines():
        name, _, verdict = line.partition(" ")
        if name in modules and verdict in ("ok", "no"):
            answers[name] = verdict == "ok"
    return answers, _why(done)


def _why(done: subprocess.CompletedProcess[str]) -> str:
    """Why a child that was started still said nothing useful, in one line."""
    stderr = [line for line in done.stderr.splitlines() if line.strip()]
    if stderr:
        return stderr[-1].strip()
    return f"it stopped before answering (exit code {done.returncode})"
