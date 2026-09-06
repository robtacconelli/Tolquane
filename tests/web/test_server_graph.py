"""One expanded graph, one JSON shape.

``tolquane run --events`` puts the graph in its ``start`` event so a viewer can draw the
run; ``tolquane.web.model.graph_view`` puts it in every flow the server hands the canvas.
If the two ever differed, a running flow would not line up with the file it came from,
so the library's is the one and the web package delegates to it. These tests hold both
ends: the functions in this process, and the two command lines in their own.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import tolquane as tq
from tolquane._events import graph_view as events_view
from tolquane.graph import expand
from tolquane.web.model import graph_view as model_view

ORDERED_FARM = '''"""Double numbers in order."""

import tolquane as tq


@tq.source
def numbers():
    """Yield ten numbers."""
    yield from range(1, 11)


@tq.node
def double(x):
    """Double one number."""
    return x * 2


@tq.sink
def show(x):
    """Print one number."""
    print(x)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.farm(double, 3, ordered=True) >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''

FEEDBACK_LOOP = '''"""Double every number until it passes ten."""

import tolquane as tq


@tq.source
def numbers():
    """Yield five numbers."""
    yield from range(1, 6)


@tq.node
def climb(item, ctx):
    """Send an item round again, or out once it is big enough."""
    if item > 10:
        ctx.send(item)
    else:
        ctx.feedback(item * 2)


@tq.sink
def show(x):
    """Print one number."""
    print(x)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.feedback(climb) >> show


def main():
    tq.run(build())


if __name__ == "__main__":
    main()
'''


@tq.source
def numbers() -> object:
    yield from range(1, 11)


@tq.node
def double(x: int) -> int:
    return x * 2


@tq.node
def climb(item: int, ctx: tq.Context) -> None:
    if item > 10:
        ctx.send(item)
    else:
        ctx.feedback(item * 2)


@tq.sink
def show(x: int) -> None:
    print(x)


@pytest.mark.parametrize(
    ("name", "block"),
    [
        ("ordered farm", numbers >> tq.farm(double, 3, ordered=True) >> show),
        ("feedback loop", numbers >> tq.feedback(climb) >> show),
    ],
)
def test_the_two_graph_views_are_one(name: str, block: tq.Block) -> None:
    view = model_view(block)
    assert view == events_view(expand(block)), name
    assert view["nodes"]
    assert set(view) == {"nodes", "edges", "loops", "windows"}


def _run(argv: list[str], cwd: Path) -> str:
    done = subprocess.run(
        [sys.executable, "-m", *argv], cwd=cwd, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stdout + done.stderr
    return done.stdout


@pytest.mark.parametrize(
    ("name", "source", "loops"),
    [("ordered.py", ORDERED_FARM, 0), ("loop.py", FEEDBACK_LOOP, 1)],
)
def test_the_run_and_the_canvas_see_the_same_graph(
    tmp_path: Path, name: str, source: str, loops: int
) -> None:
    (tmp_path / name).write_text(source)
    running = _run(["tolquane", "run", name, "--events"], tmp_path)
    start = json.loads(running.splitlines()[0])
    assert start["event"] == "start"
    canvas = json.loads(_run(["tolquane.web.model", "graph", name], tmp_path))
    assert start["graph"] == canvas
    assert len(canvas["loops"]) == loops
    assert json.loads(running.splitlines()[-1])["status"] == "done"
