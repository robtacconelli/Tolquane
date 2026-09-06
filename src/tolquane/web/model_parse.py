"""Reading a house-style flow file into the model.

Two passes. The first is ``ast`` over the source text: it finds the node definitions,
the prelude, ``build`` and ``main``, and turns the composition expression into the tree
the canvas draws. Node bodies are never rewritten, only sliced out of the text, so a
round trip gives back what the author wrote.

The second pass executes both files. The original file is built, the model's rendering
of it is built, and the two expanded graphs are compared; if the model has misread
anything the file falls back to code-only mode with the difference as the reason. That
pass is also the only way to see the graph of a file the model cannot represent, so the
helpers that execute a flow file live here rather than in ``model.py``.
"""

from __future__ import annotations

import ast
import contextlib
import inspect
import itertools
import sys
import threading
import types
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tolquane as tq
from tolquane.graph import Graph, expand

from . import model_codegen

TQ_DECORATORS = frozenset({"source", "node", "sink", "raw"})
"""Decorators that mark a definition as a node and name its kind."""

TREE_OPTIONS = model_codegen.TREE_OPTIONS
"""Farm options whose value is itself a block."""

ALIAS = "tq"
"""The one alias the generated file can use, because node bodies are kept verbatim."""


@dataclass(frozen=True)
class ParseFailure:
    """Why a file cannot be modelled. Becomes the reason of a ``CodeOnly``."""

    reason: str


def parse(text: str, name: str, *, verify: bool = True, path: str | None = None) -> Any:
    """The model of one flow file as JSON-ready data, or a ``ParseFailure``."""
    reader = _Reader(text, name)
    model = reader.read()
    if isinstance(model, ParseFailure):
        return model
    if verify:
        problem = check_round_trip(model, text, name, reader.original_expr, path)
        if problem is not None:
            return ParseFailure(problem)
    return model


# --------------------------------------------------------------------------- the ast pass


def _tq_call(func: ast.expr) -> str | None:
    """The name behind a ``tq.<something>``, whether or not it is being called."""
    if isinstance(func, ast.Call):
        return _tq_call(func.func)
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        return func.attr if func.value.id == ALIAS else None
    return None


def _names_in(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _span(stmt: ast.stmt) -> tuple[int, int]:
    """First and last line of a statement, counting its decorators."""
    start = stmt.lineno
    for decorator in getattr(stmt, "decorator_list", None) or []:
        start = min(start, decorator.lineno)
    return start, stmt.end_lineno or stmt.lineno


def _is_guard(stmt: ast.stmt) -> bool:
    if not isinstance(stmt, ast.If):
        return False
    test = stmt.test
    return (
        isinstance(test, ast.Compare)
        and isinstance(test.left, ast.Name)
        and test.left.id == "__name__"
        and len(test.comparators) == 1
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == "__main__"
    )


def _method(cls: ast.ClassDef, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for item in cls.body:
        if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef) and item.name == name:
            return item
    return None


def _positional(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    return [a.arg for a in [*fn.args.posonlyargs, *fn.args.args]]


def _params(stmt: ast.stmt) -> list[str]:
    if isinstance(stmt, ast.ClassDef):
        call = _method(stmt, "__call__")
        return _positional(call)[1:] if call is not None else []
    if isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef):
        return _positional(stmt)
    return []


@dataclass(frozen=True)
class _Lead:
    """The comment blocks between two top-level statements."""

    standalone: list[str]
    attached: str  # the block that runs straight into the statement, if any


def _read_lead(gap: list[str]) -> _Lead:
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in gap:
        if line.strip().startswith("#"):
            current.append(line.strip())
        elif current:
            blocks.append(current)
            current = []
    attached = "\n".join(current) + "\n" if current else ""
    return _Lead(["\n".join(block) for block in blocks], attached)


@dataclass
class _Definition:
    """A top-level ``def`` or ``class``, before it is known to be a node."""

    stmt: ast.stmt
    source: str
    kind: str | None  # from its tq decorator, when it has one


@dataclass
class _Chunk:
    stmt: ast.stmt
    lead: _Lead


@dataclass
class _Flow:
    """What ``build()`` (or an older ``main()``) says the graph is."""

    tree: dict[str, Any]
    start: str | None = None
    notes: list[str] = field(default_factory=list)
    main: str | None = None
    params: list[dict[str, Any]] = field(default_factory=list)


class _Reader:
    """One pass of ``ast`` over one file."""

    def __init__(self, text: str, name: str) -> None:
        self.text = text
        self.name = name
        self.lines = text.split("\n")
        self.definitions: dict[str, _Definition] = {}
        self.referenced: set[str] = set()
        self.implied: dict[str, str] = {}
        self.bindings: dict[str, dict[str, Any]] = {}
        self.start_var: str | None = None
        self.original_expr: str | None = None
        self.last_line = 0

    # -- text ------------------------------------------------------------------

    def source_of(self, stmt: ast.stmt) -> str:
        start, end = _span(stmt)
        return "\n".join(self.lines[start - 1 : end])

    def segment(self, node: ast.expr) -> str:
        text = ast.get_source_segment(self.text, node)
        return text if text is not None else ast.unparse(node)

    # -- the whole file --------------------------------------------------------

    def read(self) -> dict[str, Any] | ParseFailure:
        try:
            module = ast.parse(self.text)
        except SyntaxError as exc:
            return ParseFailure(f"the file does not parse: {exc}")
        alias = self._alias(module)
        if alias is None:
            return ParseFailure("the file does not import tolquane, so it is not a flow")
        if alias != ALIAS:
            return ParseFailure(
                f"the flow model writes `import tolquane as {ALIAS}`, but this file imports it "
                f"as {alias!r}; node bodies are kept verbatim, so the alias has to match"
            )

        chunks = self._chunks(module)
        build_fn = self._function(chunks, "build")
        main_fn = self._function(chunks, "main")
        guard = next((c.stmt for c in chunks if _is_guard(c.stmt)), None)

        flow = self._read_flow(build_fn, main_fn)
        if isinstance(flow, ParseFailure):
            return flow

        prelude: list[str] = []
        epilogue: list[str] = []
        nodes: list[dict[str, Any]] = []
        after_main = False
        for chunk in chunks:
            stmt, lead = chunk.stmt, chunk.lead
            landmark = stmt is build_fn or stmt is main_fn or stmt is guard
            free = prelude if not after_main else epilogue
            free.extend(lead.standalone)
            if landmark:
                if lead.attached and stmt is build_fn:
                    flow.notes[:0] = lead.attached.rstrip("\n").split("\n")
                elif lead.attached:
                    free.append(lead.attached.rstrip("\n"))
                after_main = after_main or stmt is main_fn
                continue
            name = getattr(stmt, "name", None)
            if isinstance(name, str) and name in self.definitions and self._is_node(name):
                nodes.append(self._node(name, lead.attached))
                continue
            free.append(lead.attached + self.source_of(stmt))
        tail = _read_lead([*self.lines[self.last_line :], ""])
        epilogue.extend(tail.standalone)  # a comment after the guard keeps its words

        return {
            "version": 1,
            "name": self.name,
            "doc": ast.get_docstring(module, clean=False),
            "prelude": [s for s in prelude if not _is_plain_tolquane_import(s)],
            "nodes": nodes,
            "flow": flow.tree,
            "start": flow.start,
            "params": flow.params,
            "main": flow.main,
            "epilogue": epilogue,
            "build_notes": flow.notes,
            "guard": self._guard_body(guard),
        }

    def _alias(self, module: ast.Module) -> str | None:
        for stmt in module.body:
            if isinstance(stmt, ast.Import):
                for imported in stmt.names:
                    if imported.name == "tolquane":
                        return imported.asname or imported.name
            if isinstance(stmt, ast.ImportFrom) and (stmt.module or "").startswith("tolquane"):
                return ALIAS  # a `from tolquane... import` alone still names the library
        return None

    def _chunks(self, module: ast.Module) -> list[_Chunk]:
        """Every top-level statement with the comment blocks that precede it."""
        out: list[_Chunk] = []
        previous_end = 0
        body = list(module.body)
        if body and ast.get_docstring(module, clean=False) is not None:
            previous_end = body[0].end_lineno or 1
            body = body[1:]
        for stmt in body:
            start, end = _span(stmt)
            lead = _read_lead(self.lines[previous_end : start - 1])
            previous_end = self.last_line = end
            definable = isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
            if definable and stmt.name not in ("build", "main"):  # type: ignore[attr-defined]
                name = stmt.name  # type: ignore[attr-defined]
                self.definitions[name] = _Definition(
                    stmt, self.source_of(stmt), self._decorator_kind(stmt)
                )
            out.append(_Chunk(stmt, lead))
        return out

    def _function(
        self, chunks: list[_Chunk], name: str
    ) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
        for chunk in chunks:
            stmt = chunk.stmt
            if isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef) and stmt.name == name:
                return stmt
        return None

    def _decorator_kind(self, stmt: ast.stmt) -> str | None:
        for decorator in getattr(stmt, "decorator_list", None) or []:
            attr = _tq_call(decorator)
            if attr in TQ_DECORATORS:
                return attr
        return None

    def _is_node(self, name: str) -> bool:
        return self.definitions[name].kind is not None or name in self.referenced

    def _node(self, name: str, attached: str) -> dict[str, Any]:
        definition = self.definitions[name]
        stmt = definition.stmt
        is_class = isinstance(stmt, ast.ClassDef)
        call = _method(stmt, "__call__") if isinstance(stmt, ast.ClassDef) else stmt
        return {
            "id": name,
            "kind": definition.kind or self.implied.get(name, "node"),
            "is_class": is_class,
            "is_async": isinstance(call, ast.AsyncFunctionDef),
            "params": _params(stmt),
            "doc": ast.get_docstring(stmt),  # type: ignore[arg-type]
            "source": attached + definition.source,
        }

    def _guard_body(self, guard: ast.stmt | None) -> str | None:
        if not isinstance(guard, ast.If):
            return None
        start = guard.body[0].lineno
        end = guard.body[-1].end_lineno or start
        raw = self.lines[start - 1 : end]
        indent = min((len(line) - len(line.lstrip()) for line in raw if line.strip()), default=0)
        body = "\n".join(line[indent:] if line.strip() else "" for line in raw)
        return None if body == model_codegen.STANDARD_GUARD else body

    # -- build and main --------------------------------------------------------

    def _read_flow(
        self,
        build_fn: ast.FunctionDef | ast.AsyncFunctionDef | None,
        main_fn: ast.FunctionDef | ast.AsyncFunctionDef | None,
    ) -> _Flow | ParseFailure:
        if build_fn is not None:
            flow = self._read_build(build_fn)
            if isinstance(flow, _Flow) and main_fn is not None:
                flow.main = self._read_main(main_fn)
            return flow
        if main_fn is None:
            return ParseFailure("the file has no build() and no main(), so it has no graph")
        found = self._read_flow_from_main(main_fn)
        assert isinstance(found, _Flow | ParseFailure)
        return found

    def _read_build(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> _Flow | ParseFailure:
        if isinstance(fn, ast.AsyncFunctionDef):
            return ParseFailure("build() is a coroutine; the model composes the graph directly")
        args = fn.args
        if args.vararg or args.kwarg or args.posonlyargs:
            return ParseFailure(
                "build() takes the sample source and keyword-only parameters, nothing else"
            )
        if len(args.args) > 1:
            return ParseFailure(
                f"build() takes {len(args.args)} positional parameters; the house style is "
                "build(source=None, *, name=default, ...)"
            )
        params = self._read_params(args)
        if isinstance(params, ParseFailure):
            return params
        source_param = args.args[0].arg if args.args else None
        body = list(fn.body)
        notes = self._comments_in(fn)
        if not body or not isinstance(body[-1], ast.Return) or body[-1].value is None:
            return ParseFailure("build() does not end in `return <graph>`")
        start: str | None = None
        for stmt in body[:-1]:
            if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1:
                return ParseFailure(
                    "build() holds a statement the model cannot read; the house style is the "
                    "start line, sub-block assignments and a return"
                )
            target = stmt.targets[0]
            if not isinstance(target, ast.Name):
                return ParseFailure("build() assigns to something that is not a plain name")
            named = self._start_of(stmt.value, source_param)
            if named is not None:
                start, self.start_var = named, target.id
            else:
                self.bindings[target.id] = self.tree(stmt.value)
        returned = body[-1].value
        assert returned is not None
        tree = self.tree(returned)
        if source_param is not None and source_param in self._used_names(returned):
            return ParseFailure(
                f"build() uses {source_param!r} outside the start line, so the model cannot "
                "wire a sample on its own"
            )
        return _Flow(tree, start, notes, params=params)

    def _read_params(self, args: ast.arguments) -> list[dict[str, Any]] | ParseFailure:
        """``build``'s keyword-only parameters: a name, a literal default, an annotation.

        The default is kept as the source the author wrote, so a round trip gives back the
        same bytes, and it has to be a literal: the model calls ``build()`` with no
        arguments to check itself, and a run gives the parameters it was asked for and
        nothing else.
        """
        out: list[dict[str, Any]] = []
        for arg, default in zip(args.kwonlyargs, args.kw_defaults, strict=True):
            if default is None:
                return ParseFailure(
                    f"build()'s parameter {arg.arg!r} has no default; the model runs the flow "
                    "with its defaults, so every parameter needs one"
                )
            try:
                ast.literal_eval(default)
            except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                return ParseFailure(
                    f"the default of build()'s parameter {arg.arg!r} is "
                    f"`{self.segment(default)}`, which is not a literal"
                )
            out.append(
                {
                    "name": arg.arg,
                    "default": self.segment(default),
                    "annotation": self.segment(arg.annotation) if arg.annotation else None,
                }
            )
        return out

    def _used_names(self, returned: ast.expr) -> set[str]:
        used = _names_in(returned)
        for tree in self.bindings.values():
            used |= _tree_names(tree)
        return used

    def _start_of(self, value: ast.expr, source_param: str | None) -> str | None:
        """The node in ``start = <node> if source is None else tq.from_iterable(source)``."""
        if source_param is None or not isinstance(value, ast.IfExp):
            return None
        test = value.test
        if not isinstance(test, ast.Compare) or len(test.ops) != 1:
            return None
        if not isinstance(test.left, ast.Name) or test.left.id != source_param:
            return None
        compared = test.comparators[0]
        if not isinstance(compared, ast.Constant) or compared.value is not None:
            return None
        if isinstance(test.ops[0], ast.Is):
            named, other = value.body, value.orelse
        elif isinstance(test.ops[0], ast.IsNot):
            named, other = value.orelse, value.body
        else:
            return None
        if not isinstance(named, ast.Name) or _tq_call(other) != "from_iterable":
            return None
        self.referenced.add(named.id)
        return named.id

    def _read_main(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
        source = self.source_of(fn)
        return None if source.strip() == model_codegen.STANDARD_MAIN else source

    def _read_flow_from_main(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> Any:
        """A flow whose graph is still written inline in ``main()``, as the older examples."""
        no_graph = ParseFailure(
            "the file has no build(); to find the graph, main() would have to be one "
            "tq.run(<graph>) call"
        )
        statements = [s for s in fn.body if not isinstance(s, ast.Pass)]
        if len(statements) != 1 or not isinstance(statements[0], ast.Expr):
            return no_graph
        call = statements[0].value
        wrapper: str | None = None
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name):
            if call.func.id != "print" or len(call.args) != 1:
                return no_graph
            wrapper, call = "print", call.args[0]
        if not isinstance(call, ast.Call) or _tq_call(call.func) != "run" or not call.args:
            return no_graph
        self.original_expr = self.segment(call.args[0])
        tree = self.tree(call.args[0])
        rest = [self.segment(a) for a in call.args[1:]]
        rest += [f"{kw.arg}={self.segment(kw.value)}" for kw in call.keywords if kw.arg]
        run = f"tq.run({', '.join(['build()', *rest])})"
        inner = f"{wrapper}({run})" if wrapper else run
        main = None if inner == "tq.run(build())" else f"def main() -> None:\n    {inner}"
        return _Flow(tree, None, self._comments_in(fn), main)

    def _comments_in(self, fn: ast.stmt) -> list[str]:
        """The comment lines of a function body, in order and without their indent."""
        start, end = _span(fn)
        return [line.strip() for line in self.lines[start:end] if line.strip().startswith("#")]

    # -- the composition tree --------------------------------------------------

    def tree(self, node: ast.expr) -> dict[str, Any]:
        """One expression as a flow tree; anything unknown stays verbatim as ``inline``."""
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.RShift):
            return {"type": "pipeline", "stages": self._stages(node)}
        if isinstance(node, ast.Name):
            if node.id == self.start_var:
                return {"type": "start"}
            if node.id in self.bindings:
                return self.bindings[node.id]
            if node.id in self.definitions:
                self.referenced.add(node.id)
                return {"type": "ref", "id": node.id}
        if isinstance(node, ast.Call):
            attr = _tq_call(node.func)
            builder = getattr(self, f"_call_{attr}", None) if attr else None
            built = builder(node) if builder is not None else None
            if built is not None:
                return dict(built)
        return self.inline(node)

    def inline(self, node: ast.expr) -> dict[str, Any]:
        """An expression the model does not know: kept verbatim, its nodes still found."""
        for name in _names_in(node) & set(self.definitions):
            self.referenced.add(name)
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            attr = _tq_call(call.func)
            if attr in TQ_DECORATORS and call.args:
                first = call.args[0]
                target = first.func if isinstance(first, ast.Call) else first
                if isinstance(target, ast.Name) and target.id in self.definitions and attr:
                    self.implied[target.id] = attr
        return {"type": "inline", "source": self.segment(node)}

    def _stages(self, node: ast.expr) -> list[dict[str, Any]]:
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.RShift):
            return self._stages(node.left) + self._stages(node.right)
        stage = self.tree(node)
        return list(stage["stages"]) if stage["type"] == "pipeline" else [stage]

    def _call_pipeline(self, node: ast.Call) -> dict[str, Any] | None:
        if node.keywords:
            return None
        stages: list[dict[str, Any]] = []
        for arg in node.args:
            stages.extend(self._stages(arg))
        return {"type": "pipeline", "stages": stages}

    def _call_comb(self, node: ast.Call) -> dict[str, Any] | None:
        if len(node.args) != 2 or node.keywords:
            return None
        return {"type": "comb", "first": self.tree(node.args[0]), "second": self.tree(node.args[1])}

    def _call_feedback(self, node: ast.Call) -> dict[str, Any] | None:
        if len(node.args) != 1:
            return None
        name: str | None = None
        for keyword in node.keywords:
            if keyword.arg != "name" or not isinstance(keyword.value, ast.Constant):
                return None
            name = str(keyword.value.value) if keyword.value.value is not None else None
        return {"type": "feedback", "inner": self.tree(node.args[0]), "name": name}

    def _call_all2all(self, node: ast.Call) -> dict[str, Any] | None:
        if len(node.args) != 2:
            return None
        out: dict[str, Any] = {
            "type": "all2all",
            "left": self.tree(node.args[0]),
            "right": self.tree(node.args[1]),
            "R": None,
            "G": None,
            "merge": False,
        }
        for keyword in node.keywords:
            if keyword.arg in ("R", "G"):
                out[keyword.arg] = self.tree(keyword.value)
            elif keyword.arg == "merge" and isinstance(keyword.value, ast.Constant):
                out["merge"] = bool(keyword.value.value)
            else:
                return None
        return out

    def _call_farm(self, node: ast.Call) -> dict[str, Any] | None:
        if not node.args or len(node.args) > 2:
            return None
        keywords: dict[str, ast.expr] = {}
        for keyword in node.keywords:
            if keyword.arg is None:
                return None
            keywords[keyword.arg] = keyword.value
        workers_node: ast.expr | None = node.args[1] if len(node.args) == 2 else None
        if workers_node is None and "workers" in keywords:
            workers_node = keywords.pop("workers")
        worker: Any
        first = node.args[0]
        if isinstance(first, ast.List | ast.Tuple):
            if workers_node is not None:
                return None
            worker = [self.tree(element) for element in first.elts]
            workers = len(worker)
        else:
            worker = self.tree(first)
            if workers_node is None:
                workers = 4
            elif isinstance(workers_node, ast.Constant) and isinstance(workers_node.value, int):
                workers = workers_node.value
            else:
                return None  # a farm sized by a name or an expression stays verbatim
        options = self._farm_options(keywords)
        if options is None:
            return None
        return {"type": "farm", "worker": worker, "workers": workers, "options": options}

    def _farm_options(self, keywords: dict[str, ast.expr]) -> dict[str, Any] | None:
        options = dict(model_codegen.FARM_DEFAULTS)
        for key, value in keywords.items():
            if key not in options:
                return None
            constant = value.value if isinstance(value, ast.Constant) else _MISSING
            if constant is None:
                if key == "capacity":
                    return None  # capacity=None means unbounded, not "left out"
                continue
            if key in TREE_OPTIONS:
                options[key] = False if constant is False else self.tree(value)
            elif isinstance(constant, str | bool | int):
                options[key] = constant
            else:
                return None
        return options


_MISSING = object()


def _is_plain_tolquane_import(statement: str) -> bool:
    return statement.split("\n", 1)[0].strip() in ("import tolquane as tq", "import tolquane")


def _tree_names(tree: Any) -> set[str]:
    """Every name a flow tree mentions, for the ``source`` leak check."""
    found: set[str] = set()
    if isinstance(tree, list):
        for item in tree:
            found |= _tree_names(item)
    elif isinstance(tree, dict):
        if tree.get("type") == "ref":
            found.add(str(tree["id"]))
        elif tree.get("type") == "inline":
            with contextlib.suppress(SyntaxError):
                found |= _names_in(ast.parse(str(tree["source"]), mode="eval"))
        for key, value in tree.items():
            if key not in ("type", "id", "source"):
                found |= _tree_names(value)
    return found


# --------------------------------------------------------------------------- the run pass

_counter = itertools.count(1)
_run_lock = threading.Lock()


class _Captured(BaseException):
    """Raised inside a stubbed ``tq.run`` to stop a flow file before it runs."""

    def __init__(self, block: Any) -> None:
        super().__init__("graph captured")
        self.block = block


@contextlib.contextmanager
def loaded(text: str, name: str, path: str | None = None) -> Iterator[types.ModuleType]:
    """Execute a flow file as a throw-away module and hand the module over."""
    modname = f"_tolquane_flow_{next(_counter)}_{name}"
    module = types.ModuleType(modname)
    module.__file__ = path or f"<{name}>"
    sys.modules[modname] = module
    added: str | None = None
    if path is not None:
        directory = str(Path(path).resolve().parent)
        if directory not in sys.path:
            sys.path.insert(0, directory)
            added = directory
    try:
        exec(compile(text, module.__file__, "exec"), module.__dict__)
        yield module
    finally:
        sys.modules.pop(modname, None)
        if added is not None and added in sys.path:
            sys.path.remove(added)


def graph_of_module(module: types.ModuleType, expr: str | None = None) -> Graph:
    """The expanded graph of a loaded flow file.

    ``build()`` when the file has one that takes no argument, otherwise the block the
    file's ``main()`` hands to ``tq.run``: stubbing ``run`` shows the graph of a file the
    model cannot represent without running it.
    """
    if expr is not None:
        block = eval(compile(expr, "<flow>", "eval"), module.__dict__)
    else:
        build = getattr(module, "build", None)
        if callable(build) and _takes_no_arguments(build):
            block = build()
        else:
            main = getattr(module, "main", None)
            if not callable(main):
                raise ValueError("the file has no build() and no main(), so it has no graph")
            block = _capture(main)
    return block if isinstance(block, Graph) else expand(block)


def _takes_no_arguments(fn: Any) -> bool:
    try:
        signature_of = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    optional = (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
    return all(
        p.default is not inspect.Parameter.empty or p.kind in optional
        for p in signature_of.parameters.values()
    )


def _capture(main: Any) -> Any:
    """Call ``main()`` with ``tq.run`` stubbed, to take the graph without running it."""
    with _run_lock:
        original = tq.run

        def stub(block: Any, *args: Any, **kwargs: Any) -> Any:
            raise _Captured(block)

        tq.run = stub
        try:
            main()
        except _Captured as captured:
            return captured.block
        finally:
            tq.run = original
    raise ValueError("main() never called tq.run(), so there is no graph to show")


def graph_of_source(
    text: str, name: str, expr: str | None = None, path: str | None = None
) -> Graph:
    """Execute a flow file and expand its graph."""
    with loaded(text, name, path) as module:
        return graph_of_module(module, expr)


def signature(graph: Graph) -> dict[str, Any]:
    """Everything about an expanded graph that a round trip has to preserve."""
    return {
        "nodes": [
            {
                "name": n.name,
                "kind": n.kind,
                "index": n.index,
                "group": n.group,
                "role": n.role,
                "is_sink": n.is_sink,
                "is_async": n.is_async,
                "tagged": n.tagged,
                "factory": n.factory,
                "generator": n.generator,
                "distribute": n.distribute,
                "collect": n.collect,
                "keyed": n.key is not None,
                "window": n.window,
                "remote": n.remote,
                "concurrency": n.concurrency,
                "ordered": n.ordered,
            }
            for n in graph.nodes
        ],
        "edges": [
            {
                "src": e.src,
                "dst": e.dst,
                "rule": e.rule,
                "feedback": e.feedback,
                "capacity": e.capacity,
                "batch": e.batch,
            }
            for e in graph.edges
        ],
        "loops": [
            {"name": loop.name, "nodes": list(loop.nodes), "heads": list(loop.heads)}
            for loop in graph.loops
        ],
        "windows": dict(graph.windows),
    }


def difference(left: dict[str, Any], right: dict[str, Any]) -> str | None:
    """The first difference between two graph signatures, in words."""
    for section in ("nodes", "edges", "loops"):
        first, second = left[section], right[section]
        if len(first) != len(second):
            return f"the generated file has {len(second)} {section}, the original {len(first)}"
        for one, two in zip(first, second, strict=True):
            if one != two:
                changed = ", ".join(k for k in one if one[k] != two.get(k))
                where = one.get("name") or f"{one.get('src')} -> {one.get('dst')}"
                return f"{section[:-1]} {where} differs in {changed}"
    if left["windows"] != right["windows"]:
        return f"windows differ: {left['windows']} against {right['windows']}"
    return None


def check_round_trip(
    model: dict[str, Any], text: str, name: str, expr: str | None, path: str | None = None
) -> str | None:
    """Build the file and the model's rendering of it, and compare the two graphs."""
    try:
        generated = model_codegen.render(model)
    except Exception as exc:
        return f"the model cannot be written back as Python: {exc}"
    try:
        original = signature(graph_of_source(text, name, expr, path))
    except Exception as exc:  # the file is the user's: anything can come out of it
        return f"the file's own graph could not be built: {type(exc).__name__}: {exc}"
    try:
        rebuilt = signature(graph_of_source(generated, name, None, path))
    except Exception as exc:
        return f"the generated file does not build: {type(exc).__name__}: {exc}"
    return difference(original, rebuilt)
