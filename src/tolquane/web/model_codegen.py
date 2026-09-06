"""Writing a flow model back out as a house-style flow file.

Everything here works on the JSON form of the model described in
``docs/web-interfaces.md``, never on the dataclasses, so the parser can render a
candidate file while it is still deciding whether it has understood one.

The output is what ``ruff format`` would leave alone: two blank lines around every
top-level definition, one line per stage of a long pipeline, a magic trailing comma in
a call that had to be exploded. Determinism matters more than beauty here, because a
second round trip has to give the same bytes.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

WIDTH = 100
"""The repository's ruff line length."""

INDENT = "    "

_FARM_OPTIONS = (
    "emit",
    "collect",
    "ordered",
    "emitter",
    "collector",
    "key",
    "prefetch",
    "window",
    "name",
    "capacity",
    "runtime",
)

FARM_DEFAULTS: dict[str, Any] = {
    "emit": "round_robin",
    "collect": None,
    "ordered": False,
    "emitter": None,
    "collector": None,
    "key": None,
    "prefetch": 1,
    "window": None,
    "name": None,
    "capacity": None,
    "runtime": None,
}

TREE_OPTIONS = frozenset({"key", "emitter", "collector"})
"""Farm options whose value is a tree (or ``False`` for emitter and collector)."""

STANDARD_MAIN = "def main() -> None:\n    tq.run(build())"
STANDARD_GUARD = "main()"


# --------------------------------------------------------------------------- expressions


def render_tree(tree: Mapping[str, Any]) -> str:
    """One flow tree as a Python expression on a single line."""
    kind = tree.get("type")
    if kind == "start":
        return "start"
    if kind == "ref":
        return str(tree["id"])
    if kind == "inline":
        return str(tree["source"])
    if kind == "pipeline":
        return " >> ".join(render_tree(s) for s in _stages(tree))
    name, args = call_parts(tree)
    return f"{name}({', '.join(args)})"


def call_parts(tree: Mapping[str, Any]) -> tuple[str, list[str]]:
    """The function name and rendered arguments of a block constructor."""
    kind = tree.get("type")
    if kind == "farm":
        return "tq.farm", _farm_args(tree)
    if kind == "comb":
        return "tq.comb", [render_tree(tree["first"]), render_tree(tree["second"])]
    if kind == "feedback":
        args = [render_tree(tree["inner"])]
        if tree.get("name"):
            args.append(f"name={_literal(tree['name'])}")
        return "tq.feedback", args
    if kind == "all2all":
        args = [render_tree(tree["left"]), render_tree(tree["right"])]
        for option in ("R", "G"):
            value = tree.get(option)
            if value is not None:
                args.append(f"{option}={render_tree(value)}")
        if tree.get("merge"):
            args.append("merge=True")
        return "tq.all2all", args
    raise ValueError(f"unknown flow tree node {kind!r}")


def _farm_args(tree: Mapping[str, Any]) -> list[str]:
    worker = tree["worker"]
    if isinstance(worker, list):
        args = ["[" + ", ".join(render_tree(w) for w in worker) + "]"]
    else:
        args = [render_tree(worker), str(tree.get("workers", 4))]
    options: Mapping[str, Any] = tree.get("options") or {}
    for option in _FARM_OPTIONS:
        value = options.get(option, FARM_DEFAULTS[option])
        if value == FARM_DEFAULTS[option] and type(value) is type(FARM_DEFAULTS[option]):
            continue
        if option in TREE_OPTIONS:
            rendered = "False" if value is False else render_tree(value)
        else:
            rendered = _literal(value)
        args.append(f"{option}={rendered}")
    return args


def _literal(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    return repr(value)


def _stages(tree: Mapping[str, Any]) -> Sequence[Mapping[str, Any]]:
    stages: Sequence[Mapping[str, Any]] = tree.get("stages") or []
    return stages


# --------------------------------------------------------------------------- statements


def _wrap_return(tree: Mapping[str, Any]) -> list[str]:
    """The ``return`` of ``build()``, wrapped the way ruff format would wrap it."""
    expr = render_tree(tree)
    flat = f"{INDENT}return {expr}"
    if len(flat) <= WIDTH:
        return [flat]
    inner = INDENT * 2 + expr
    if len(inner) <= WIDTH:
        return [f"{INDENT}return (", inner, f"{INDENT})"]
    if tree.get("type") == "pipeline":
        out = [f"{INDENT}return ("]
        for i, stage in enumerate(_stages(tree)):
            out.extend(_stage_lines(stage, first=i == 0))
        out.append(f"{INDENT})")
        return out
    lines = _exploded(tree, INDENT)
    lines[0] = f"{INDENT}return " + lines[0].lstrip()
    return lines


def _stage_lines(stage: Mapping[str, Any], *, first: bool) -> list[str]:
    """One stage of a wrapped pipeline: ``>> farm(...)``, exploded when it is too long."""
    prefix = INDENT * 2 if first else INDENT * 2 + ">> "
    text = render_tree(stage)
    if len(prefix + text) <= WIDTH or stage.get("type") in ("ref", "start", "inline", "pipeline"):
        return [prefix + text]
    lines = _exploded(stage, INDENT * 2)
    lines[0] = prefix + lines[0].lstrip()
    return lines


def _exploded(tree: Mapping[str, Any], indent: str) -> list[str]:
    """A block constructor with one argument per line and a magic trailing comma."""
    name, args = call_parts(tree)
    out = [f"{indent}{name}("]
    out.extend(f"{indent}{INDENT}{arg}," for arg in args)
    out.append(f"{indent})")
    return out


def _start_lines(start: str) -> list[str]:
    line = f"{INDENT}start = {start} if source is None else tq.from_iterable(source)"
    if len(line) <= WIDTH:
        return [line]
    return [
        f"{INDENT}start = (",
        f"{INDENT * 2}{start} if source is None else tq.from_iterable(source)",
        f"{INDENT})",
    ]


def _docstring(doc: str) -> str:
    if '"""' in doc or doc.endswith('"') or doc.endswith("\\"):
        return json.dumps(doc)
    return f'"""{doc}"""'


def _is_import(statement: str) -> bool:
    head = statement.lstrip().split("\n", 1)[0]
    return head.startswith("import ") or head.startswith("from ")


def _is_tolquane_import(statement: str) -> bool:
    head = statement.split("\n", 1)[0]
    return head.startswith("import tolquane") or head.startswith("from tolquane")


def _is_definition(statement: str) -> bool:
    head = statement.split("\n", 1)[0]
    return head.startswith(("def ", "class ", "async def ", "@"))


def _blank_between(previous: str, current: str) -> int:
    """How many blank lines to put between two prelude or epilogue statements."""
    if _is_definition(previous) or _is_definition(current):
        return 2
    if "\n" in previous or "\n" in current:
        return 1
    if previous.startswith("#") or current.startswith("#"):
        return 1
    return 0  # a run of one-line constants stays a block, as the examples write them


# --------------------------------------------------------------------------- the file


def render(model: Mapping[str, Any]) -> str:
    """The whole flow file for one model, deterministically."""
    lines: list[str] = []

    def emit(text: str) -> None:
        lines.extend(text.split("\n"))

    def blank(count: int = 1) -> None:
        lines.extend([""] * count)

    doc = model.get("doc")
    if doc:
        emit(_docstring(str(doc)))
        blank()

    prelude = [str(s) for s in model.get("prelude") or []]
    imports = [s for s in prelude if _is_import(s)]
    others = [s for s in prelude if not _is_import(s)]
    outside = [s for s in imports if not _is_tolquane_import(s)]
    inside = [s for s in imports if _is_tolquane_import(s)]
    for statement in outside:
        emit(statement)
    if outside:
        blank()
    emit("import tolquane as tq")
    for statement in inside:
        emit(statement)

    if others:
        blank()
        previous: str | None = None
        for statement in others:
            if previous is not None:
                blank(_blank_between(previous, statement))
            emit(statement)
            previous = statement

    for node in model.get("nodes") or []:
        blank(2)
        emit(str(node["source"]))

    blank(2)
    emit(_build(model))

    blank(2)
    main = model.get("main")
    emit(str(main) if main else STANDARD_MAIN)

    epilogue = [str(s) for s in model.get("epilogue") or []]
    previous = None
    for statement in epilogue:
        blank(2 if previous is None else _blank_between(previous, statement))
        emit(statement)
        previous = statement

    blank(2)
    emit('if __name__ == "__main__":')
    guard = model.get("guard") or STANDARD_GUARD
    for line in str(guard).split("\n"):
        emit(INDENT + line if line else "")

    return "\n".join(lines).rstrip("\n") + "\n"


def _build(model: Mapping[str, Any]) -> str:
    lines = ["def build(source=None):"]
    for note in model.get("build_notes") or []:
        lines.extend(INDENT + line if line else "" for line in str(note).split("\n"))
    start = model.get("start")
    if start:
        lines.extend(_start_lines(str(start)))
    flow = model.get("flow")
    if not flow:
        raise ValueError("the model has no flow to return")
    lines.extend(_wrap_return(flow))
    return "\n".join(lines)
