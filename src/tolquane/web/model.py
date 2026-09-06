"""The flow model: a house-style flow file as data, and the way back to Python.

A flow is a `flow.py` in the house style (``docs/style.md``): a docstring, imports, one
definition per node, ``build(source=None)`` composing them and ``main()``. The canvas is
a view of that file, so the model keeps every node body as the text the author wrote and
only the composition as structure. What the model cannot say, it keeps verbatim as an
``inline`` expression; what it cannot read at all opens read-only, as ``CodeOnly`` with
the expanded graph to draw and a reason a person can act on.

    from tolquane.web.model import parse_file, to_python

    model = parse_file("flow.py")
    print(to_python(model))

Parsing executes the file to check that the model rebuilds the same graph, so the
command line form runs in its own process:

    python -m tolquane.web.model parse flow.py
    python -m tolquane.web.model generate model.json
    python -m tolquane.web.model graph flow.py

The JSON shapes are written down in ``docs/web-interfaces.md``, section S1.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tolquane as tq
from tolquane._events import graph_view as expanded_graph_view
from tolquane.errors import GraphError
from tolquane.graph import Block, Graph, expand

from . import model_codegen, model_parse

VERSION = 1
"""The model format. Bump it when a change is not readable by the frontend."""

LAYOUT_SUFFIX = ".layout.json"


# --------------------------------------------------------------------------- the model


@dataclass
class NodeDef:
    """One node definition, kept as the text the author wrote."""

    id: str
    kind: str = "node"
    is_class: bool = False
    is_async: bool = False
    params: list[str] = field(default_factory=list)
    doc: str | None = None
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "is_class": self.is_class,
            "is_async": self.is_async,
            "params": list(self.params),
            "doc": self.doc,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NodeDef:
        return cls(
            id=str(data["id"]),
            kind=str(data.get("kind", "node")),
            is_class=bool(data.get("is_class", False)),
            is_async=bool(data.get("is_async", False)),
            params=[str(p) for p in data.get("params") or []],
            doc=data.get("doc"),
            source=str(data.get("source", "")),
        )


@dataclass
class FlowModel:
    """A flow file as data: its prose, its nodes and the tree that composes them."""

    name: str
    doc: str | None = None
    prelude: list[str] = field(default_factory=list)
    nodes: list[NodeDef] = field(default_factory=list)
    flow: dict[str, Any] = field(default_factory=dict)
    start: str | None = None
    main: str | None = None
    epilogue: list[str] = field(default_factory=list)
    build_notes: list[str] = field(default_factory=list)
    guard: str | None = None
    version: int = VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "name": self.name,
            "doc": self.doc,
            "prelude": list(self.prelude),
            "nodes": [n.to_dict() for n in self.nodes],
            "flow": self.flow,
            "start": self.start,
            "main": self.main,
            "epilogue": list(self.epilogue),
            "build_notes": list(self.build_notes),
            "guard": self.guard,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FlowModel:
        return cls(
            name=str(data.get("name", "flow")),
            doc=data.get("doc"),
            prelude=[str(s) for s in data.get("prelude") or []],
            nodes=[NodeDef.from_dict(n) for n in data.get("nodes") or []],
            flow=dict(data.get("flow") or {}),
            start=data.get("start"),
            main=data.get("main"),
            epilogue=[str(s) for s in data.get("epilogue") or []],
            build_notes=[str(s) for s in data.get("build_notes") or []],
            guard=data.get("guard"),
            version=int(data.get("version", VERSION)),
        )

    def node(self, node_id: str) -> NodeDef | None:
        return next((n for n in self.nodes if n.id == node_id), None)


@dataclass
class CodeOnly:
    """A file the model cannot represent: the editor still works, the canvas is read-only."""

    reason: str
    graph: dict[str, Any] | None = None
    name: str = "flow"

    def to_dict(self) -> dict[str, Any]:
        return {"code_only": True, "reason": self.reason, "name": self.name, "graph": self.graph}


# --------------------------------------------------------------------------- parsing


def parse_source(text: str, name: str = "flow", *, verify: bool = True) -> FlowModel | CodeOnly:
    """Read a flow file's text. ``verify=False`` skips executing it, for a quick look."""
    return _parsed(text, name, None, verify=verify)


def parse_file(path: str | Path) -> FlowModel | CodeOnly:
    """Read a flow file. The model's name is the file's stem."""
    file = Path(path)
    return _parsed(file.read_text(encoding="utf-8"), file.stem, str(file), verify=True)


def _parsed(text: str, name: str, path: str | None, *, verify: bool) -> FlowModel | CodeOnly:
    result = model_parse.parse(text, name, verify=verify, path=path)
    if isinstance(result, model_parse.ParseFailure):
        return CodeOnly(result.reason, _graph_or_none(text, name, path), name)
    return FlowModel.from_dict(result)


def _graph_or_none(text: str, name: str, path: str | None) -> dict[str, Any] | None:
    """The expanded graph of a file the model could not read, when it can be had at all."""
    try:
        return _view(model_parse.graph_of_source(text, name, None, path))
    except Exception:
        return None


# --------------------------------------------------------------------------- generating


def to_python(model: FlowModel) -> str:
    """The flow file for a model: house style, ruff-clean, the same bytes every time."""
    return model_codegen.render(model.to_dict())


# --------------------------------------------------------------------------- looking


def graph_view(subject: Any) -> dict[str, Any]:
    """The expanded graph as data, for the canvas's "threads" view.

    Takes a block, an expanded ``Graph``, a ``FlowModel``, the path of a flow file or the
    text of one. A path or text is executed, so keep it on the near side of a process
    boundary when the code is not yours.
    """
    return _view(_expanded(subject))


def _expanded(subject: Any) -> Graph:
    if isinstance(subject, Graph):
        return subject
    if isinstance(subject, Block):
        return expand(subject)
    if isinstance(subject, FlowModel):
        return model_parse.graph_of_source(to_python(subject), subject.name)
    if isinstance(subject, CodeOnly):
        raise ValueError("a code-only file carries its graph in .graph")
    if isinstance(subject, Path) or (isinstance(subject, str) and _looks_like_path(subject)):
        file = Path(subject)
        return model_parse.graph_of_source(
            file.read_text(encoding="utf-8"), file.stem, None, str(file)
        )
    if isinstance(subject, str):
        return model_parse.graph_of_source(subject, "flow")
    return expand(subject)  # a bare callable is a node


def _looks_like_path(text: str) -> bool:
    return "\n" not in text and text.endswith(".py")


def _view(graph: Graph) -> dict[str, Any]:
    """One shape for the expanded graph, and it belongs to the library.

    ``tolquane._events.graph_view`` is what ``tolquane run --events`` puts in its
    ``start`` event, and it is what the canvas draws; the two must be the same JSON or a
    running flow would not line up with the file it came from. The library cannot import
    the web package, so the library's is the one, and this is a way in for the things
    only the model has names for (a path, a block, a model).
    """
    return expanded_graph_view(graph)


def check_model(model: FlowModel) -> list[str]:
    """What is wrong with a model, in the words ``tq.check`` uses. Empty when it is sound."""
    problems = _structure(model)
    if problems:
        return problems
    try:
        source = to_python(model)
    except Exception as exc:
        return [f"the model cannot be written as Python: {exc}"]
    try:
        with model_parse.loaded(source, model.name) as module:
            tq.check(module.build())
    except GraphError as exc:
        return [str(exc)]
    except Exception as exc:
        return [f"{type(exc).__name__}: {exc}"]
    return []


def _structure(model: FlowModel) -> list[str]:
    if not model.flow:
        return ["the model has no flow"]
    known = {n.id for n in model.nodes}
    missing = sorted(_refs(model.flow) - known)
    problems = [f"the flow uses {name!r}, which is not one of its nodes" for name in missing]
    if model.start and model.start not in known:
        problems.append(f"the start node {model.start!r} is not one of the flow's nodes")
    return problems


def _refs(tree: Any) -> set[str]:
    """Only the ids of ``ref`` nodes: an inline expression may name anything."""
    found: set[str] = set()
    if isinstance(tree, list):
        for item in tree:
            found |= _refs(item)
    elif isinstance(tree, dict):
        if tree.get("type") == "ref":
            found.add(str(tree["id"]))
        for key, value in tree.items():
            if key != "type":
                found |= _refs(value)
    return found


# --------------------------------------------------------------------------- the sidecar


@dataclass
class Position:
    x: float = 0.0
    y: float = 0.0

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y}


@dataclass
class Viewport:
    x: float = 0.0
    y: float = 0.0
    zoom: float = 1.0

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "zoom": self.zoom}


@dataclass
class Sample:
    """One saved input for the Run panel; ``items`` are JSON values."""

    name: str
    items: list[Any] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "items": list(self.items)}


@dataclass
class Layout:
    """The canvas sidecar: where the cards sit, and the samples to run the flow with.

    Positions are keyed by the path of the tree element they belong to (``stages.1``,
    ``stages.1.worker``, ``stages.1.options.emitter``).
    """

    positions: dict[str, Position] = field(default_factory=dict)
    viewport: Viewport | None = None
    samples: list[Sample] = field(default_factory=list)
    version: int = VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "positions": {k: v.to_dict() for k, v in self.positions.items()},
            "viewport": self.viewport.to_dict() if self.viewport else None,
            "samples": [s.to_dict() for s in self.samples],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Layout:
        viewport = data.get("viewport")
        return cls(
            positions={
                str(k): Position(float(v.get("x", 0.0)), float(v.get("y", 0.0)))
                for k, v in (data.get("positions") or {}).items()
            },
            viewport=Viewport(
                float(viewport.get("x", 0.0)),
                float(viewport.get("y", 0.0)),
                float(viewport.get("zoom", 1.0)),
            )
            if isinstance(viewport, dict)
            else None,
            samples=[
                Sample(str(s.get("name", "")), list(s.get("items") or []))
                for s in data.get("samples") or []
            ],
            version=int(data.get("version", VERSION)),
        )


def layout_path(path: str | Path) -> Path:
    """The sidecar next to a flow file: ``flow.py`` becomes ``flow.layout.json``."""
    file = Path(path)
    if file.name.endswith(LAYOUT_SUFFIX):
        return file
    return file.with_suffix(LAYOUT_SUFFIX)


def read_layout(path: str | Path) -> Layout | None:
    """The sidecar of a flow, or ``None`` when it has none or it is not readable."""
    sidecar = layout_path(path)
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return Layout.from_dict(data) if isinstance(data, dict) else None


def write_layout(path: str | Path, layout: Layout) -> None:
    """Write the sidecar next to a flow, formatted so a diff stays readable."""
    sidecar = layout_path(path)
    sidecar.write_text(json.dumps(layout.to_dict(), indent=2) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- command line


USAGE = """usage: python -m tolquane.web.model <command> <file>

  parse <flow.py>       the model as JSON, or {"code_only": true, ...}
  generate <model.json> the flow file as Python
  graph <flow.py>       the expanded graph as JSON
"""


def main(argv: list[str] | None = None) -> int:
    """Run one command against one file, so the caller never executes the user's code."""
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2 or args[0] not in ("parse", "generate", "graph"):
        sys.stderr.write(USAGE)
        return 2
    command, target = args
    try:
        if command == "parse":
            result = parse_file(target)
            data = result.to_dict()
            print(json.dumps(data, indent=2))
        elif command == "generate":
            model = FlowModel.from_dict(json.loads(Path(target).read_text(encoding="utf-8")))
            sys.stdout.write(to_python(model))
        else:
            print(json.dumps(graph_view(Path(target)), indent=2))
    except Exception as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
