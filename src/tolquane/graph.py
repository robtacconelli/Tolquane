"""Graph description: blocks, node specs, edges, topology rules and validation.

Nothing in this module runs user code. A ``Block`` is a value that knows how to expand
itself into ``NodeSpec`` and ``EdgeSpec`` records; ``build()`` turns the outermost block
into a validated ``Graph`` that the runtimes execute.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal

from .errors import GraphError

NodeKind = Literal["source", "map", "flat", "ctx", "raw", "comb"]

EMIT_POLICIES = ("round_robin", "on_demand", "broadcast", "scatter", "key")
COLLECT_POLICIES = ("first_come", "round_robin", "ordered", "gather")

DEFAULT_CAPACITY = -1
"""Edge capacity placeholder resolved to ``run(capacity=...)``. ``None`` means unbounded."""


# --------------------------------------------------------------------------- specs


@dataclass(frozen=True)
class NodeSpec:
    """One node of the executable graph."""

    name: str
    kind: NodeKind
    target: Any
    factory: bool = False
    generator: bool = False
    is_sink: bool = False
    index: int = 0
    group: str | None = None
    role: str | None = None
    distribute: str = "round_robin"
    collect: str = "first_come"
    tagged: bool = False
    key: Callable[[Any], Any] | None = None
    window: str | None = None

    @property
    def label(self) -> str:
        return self.name


@dataclass(frozen=True)
class EdgeSpec:
    """A channel from one node's output to another node's input."""

    src: str
    dst: str
    rule: str
    capacity: int | None = DEFAULT_CAPACITY


@dataclass
class Graph:
    """The expanded, validated graph."""

    nodes: list[NodeSpec] = field(default_factory=list)
    edges: list[EdgeSpec] = field(default_factory=list)
    inlets: list[str] = field(default_factory=list)
    outlets: list[str] = field(default_factory=list)
    windows: dict[str, int] = field(default_factory=dict)

    def node(self, name: str) -> NodeSpec:
        for n in self.nodes:
            if n.name == name:
                return n
        raise KeyError(name)

    def incoming(self, name: str) -> list[EdgeSpec]:
        return [e for e in self.edges if e.dst == name]

    def outgoing(self, name: str) -> list[EdgeSpec]:
        return [e for e in self.edges if e.src == name]

    def merge(self, other: Graph) -> None:
        self.nodes.extend(other.nodes)
        self.edges.extend(other.edges)
        self.windows.update(other.windows)


class _Names:
    """Allocates unique node names inside one graph."""

    def __init__(self) -> None:
        self._used: set[str] = set()

    def unique(self, base: str) -> str:
        name = base
        n = 1
        while name in self._used:
            n += 1
            name = f"{base}#{n}"
        self._used.add(name)
        return name


# --------------------------------------------------------------------------- inference


def _positional_arity(fn: Any) -> int | None:
    """Number of required positional parameters, or None when it cannot be known."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    n = 0
    for p in sig.parameters.values():
        if p.kind is p.VAR_POSITIONAL:
            return None
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.default is p.empty:
            n += 1
    return n


def _has_call(cls: type) -> bool:
    return any("__call__" in vars(c) for c in cls.__mro__ if c is not object)


@dataclass(frozen=True)
class Described:
    arity: int | None
    generator: bool
    factory: bool
    name: str


def describe(target: Any) -> Described:
    """Inspect a callable, class or callable instance."""
    if inspect.isclass(target):
        if not _has_call(target):
            raise GraphError(
                f"class {target.__name__} has no __call__ method; a node class must define "
                "__call__(self, item) or __call__(self, item, ctx)"
            )
        call = target.__call__
        arity = _positional_arity(call)
        if arity is not None:
            arity -= 1  # self
        return Described(arity, inspect.isgeneratorfunction(call), True, target.__name__)
    if inspect.isfunction(target) or inspect.ismethod(target) or inspect.isbuiltin(target):
        name = str(getattr(target, "__name__", type(target).__name__))
        if name == "<lambda>":
            name = "lambda"
        return Described(
            _positional_arity(target), inspect.isgeneratorfunction(target), False, name
        )
    if callable(target):
        call = type(target).__call__
        return Described(
            _positional_arity(target),
            inspect.isgeneratorfunction(call),
            False,
            type(target).__name__,
        )
    raise GraphError(f"{target!r} is not callable, so it cannot be a node")


def _kind_for(desc: Described, *, declared: str | None) -> NodeKind:
    arity = 1 if desc.arity is None else desc.arity
    if declared == "source":
        if arity != 0:
            raise GraphError(
                f"source {desc.name!r} takes {arity} parameter(s); a source takes none and "
                "yields (or returns) the items"
            )
        return "source"
    if declared == "raw":
        if arity != 1:
            raise GraphError(f"raw node {desc.name!r} must take exactly one parameter: ctx")
        return "raw"
    if arity == 0:
        if declared == "sink":
            raise GraphError(f"sink {desc.name!r} takes no parameter; a sink takes the item")
        return "source"
    if arity == 1:
        return "flat" if desc.generator else "map"
    if arity == 2:
        return "ctx"
    raise GraphError(
        f"{desc.name!r} takes {arity} positional parameters; a node takes one (item) or two "
        "(item, ctx). Bind extra arguments with functools.partial or a class"
    )


# --------------------------------------------------------------------------- blocks


class Block:
    """Something that can be wired into a graph. Compose blocks with ``>>``."""

    def expand(self, names: _Names) -> Graph:
        raise NotImplementedError

    def __rshift__(self, other: Any) -> Pipeline:
        return Pipeline([self, as_block(other)])

    def __rrshift__(self, other: Any) -> Pipeline:
        return Pipeline([as_block(other), self])


class Node(Block):
    """A single node wrapping a function, a class or a callable instance."""

    def __init__(
        self,
        target: Any,
        *,
        declared: str | None = None,
        name: str | None = None,
        distribute: str = "round_robin",
    ) -> None:
        desc = describe(target)
        self.target = target
        self.kind: NodeKind = _kind_for(desc, declared=declared)
        self.factory = desc.factory
        self.generator = desc.generator
        self.is_sink = declared == "sink"
        self.name = name or desc.name
        if distribute not in EMIT_POLICIES:
            raise GraphError(
                f"unknown distribute policy {distribute!r}; use one of {EMIT_POLICIES}"
            )
        self.distribute = distribute
        # Keep the decorated function usable as a plain function.
        self.__doc__ = getattr(target, "__doc__", None)
        self.__wrapped__ = target

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.target(*args, **kwargs)

    def __repr__(self) -> str:
        return f"<tolquane.Node {self.name} ({self.kind})>"

    def spec(self, name: str, **overrides: Any) -> NodeSpec:
        base = {
            "name": name,
            "kind": self.kind,
            "target": self.target,
            "factory": self.factory,
            "generator": self.generator,
            "is_sink": self.is_sink,
            "distribute": self.distribute,
        }
        base.update(overrides)
        return NodeSpec(**base)

    def expand(self, names: _Names) -> Graph:
        name = names.unique(self.name)
        g = Graph(nodes=[self.spec(name)])
        if self.kind != "source":
            g.inlets = [name]
        if not self.is_sink:
            g.outlets = [name]
        return g


class Pipeline(Block):
    """Blocks connected left to right. ``a >> b >> c`` builds one."""

    blocks: list[Block]

    def __init__(self, blocks: Iterable[Any]) -> None:
        flat: list[Block] = []
        for b in blocks:
            b = as_block(b)
            if isinstance(b, Pipeline):
                flat.extend(b.blocks)
            else:
                flat.append(b)
        if not flat:
            raise GraphError("a pipeline needs at least one block")
        self.blocks = flat

    def __rshift__(self, other: Any) -> Pipeline:
        return Pipeline([*self.blocks, as_block(other)])

    def __repr__(self) -> str:
        return "<tolquane.Pipeline " + " >> ".join(repr(b) for b in self.blocks) + ">"

    def expand(self, names: _Names) -> Graph:
        g = Graph()
        prev: list[str] | None = None
        prev_block: Block | None = None
        for block in self.blocks:
            sub = block.expand(names)
            g.merge(sub)
            if prev is None:
                g.inlets = sub.inlets
            else:
                if not prev:
                    raise GraphError(
                        f"{describe_block(prev_block)} has no outputs, so nothing can follow it "
                        "in the pipeline"
                    )
                if not sub.inlets:
                    raise GraphError(
                        f"{describe_block(block)} has no inputs, so it cannot follow "
                        f"{describe_block(prev_block)} in the pipeline"
                    )
                g.edges.extend(connect(prev, sub.inlets))
            prev = sub.outlets
            prev_block = block
        g.outlets = prev or []
        return g


def describe_block(block: Block | None) -> str:
    if isinstance(block, Node):
        return f"{block.kind} node {block.name!r}"
    if isinstance(block, Farm):
        return f"farm {block.name!r}"
    return repr(block)


def connect(
    outs: list[str], ins: list[str], capacity: int | None = DEFAULT_CAPACITY
) -> list[EdgeSpec]:
    """Wire N outputs to M inputs with the same rules BBFlow's pipeline used."""
    n, m = len(outs), len(ins)
    if n == 1 and m == 1:
        return [EdgeSpec(outs[0], ins[0], "1-1", capacity)]
    if n == 1:
        return [EdgeSpec(outs[0], i, "1xN", capacity) for i in ins]
    if m == 1:
        return [EdgeSpec(o, ins[0], "Nx1", capacity) for o in outs]
    if n == m:
        return [EdgeSpec(o, i, "N-N", capacity) for o, i in zip(outs, ins, strict=True)]
    return [EdgeSpec(o, i, "NxM", capacity) for o in outs for i in ins]


@dataclass(frozen=True)
class _Parts:
    kind: NodeKind
    factory: bool
    generator: bool
    target: Any
    name: str
    comb: Comb | None = None
    is_sink: bool = False

    def spec(self, name: str, **overrides: Any) -> NodeSpec:
        target = self.target
        is_sink = self.is_sink
        if self.comb is not None:
            target = (self.comb.first.spec(f"{name}.a"), self.comb.second.spec(f"{name}.b"))
            is_sink = self.comb.second.is_sink
        fields: dict[str, Any] = {
            "name": name,
            "kind": self.kind,
            "target": target,
            "factory": self.factory,
            "generator": self.generator,
            "is_sink": is_sink,
        }
        fields.update(overrides)
        return NodeSpec(**fields)


def _parts(obj: Any) -> _Parts:
    """Kind, factory flag, generator flag, target and name of a Node, Comb or bare callable."""
    if isinstance(obj, Node):
        return _Parts(
            obj.kind, obj.factory, obj.generator, obj.target, obj.name, is_sink=obj.is_sink
        )
    if isinstance(obj, Comb):
        return _Parts("comb", False, False, obj, obj.name, comb=obj)
    if isinstance(obj, Block):
        raise GraphError(
            f"{obj!r} cannot be used as a single node; use a function, class or comb()"
        )
    desc = describe(obj)
    return _Parts(_kind_for(desc, declared=None), desc.factory, desc.generator, obj, desc.name)


def forward(item: Any, ctx: Any) -> None:
    """Default emitter and collector body: pass the item on. Policies live on the ports."""
    ctx.send(item)


class Farm(Block):
    """Emitter, N workers and a collector."""

    def __init__(
        self,
        worker: Any,
        workers: int = 4,
        *,
        emit: str = "round_robin",
        collect: str | None = None,
        ordered: bool = False,
        emitter: Any = None,
        collector: Any = None,
        key: Callable[[Any], Any] | None = None,
        prefetch: int = 1,
        window: int | None = None,
        name: str | None = None,
        capacity: int | None = DEFAULT_CAPACITY,
    ) -> None:
        raw_workers: list[Any]
        if isinstance(worker, list | tuple):
            if not worker:
                raise GraphError("farm() got an empty list of workers")
            raw_workers = list(worker)
            workers = len(raw_workers)
        else:
            if not isinstance(workers, int) or workers < 1:
                raise GraphError(f"workers must be a positive integer, got {workers!r}")
            raw_workers = [worker] * workers
        parts = [_parts(w) for w in raw_workers]
        for part in parts:
            if part.kind in ("source", "raw"):
                raise GraphError(
                    f"farm worker {part.name!r} must take an item: def {part.name}(item) or "
                    f"def {part.name}(item, ctx)"
                )
        if key is not None:
            if emit not in ("round_robin", "key"):
                raise GraphError(
                    "key= selects workers by key; it cannot be combined with emit=" + repr(emit)
                )
            emit = "key"
        if emit not in EMIT_POLICIES:
            raise GraphError(f"unknown emit policy {emit!r}; use one of {EMIT_POLICIES}")
        if emit == "key" and key is None:
            raise GraphError("emit='key' needs key=<function of the item>")
        if collect is None:
            collect = "ordered" if ordered else ("gather" if emit == "scatter" else "first_come")
        if collect not in COLLECT_POLICIES:
            raise GraphError(f"unknown collect policy {collect!r}; use one of {COLLECT_POLICIES}")
        if ordered and collect != "ordered":
            raise GraphError("ordered=True already means collect='ordered'; drop one of them")
        if collect == "gather" and emit != "scatter":
            raise GraphError("collect='gather' pairs with emit='scatter'")
        tagged = collect in ("ordered", "gather")
        if tagged and (emitter is False or collector is False):
            raise GraphError(f"collect={collect!r} needs both an emitter and a collector")
        if prefetch < 1:
            raise GraphError("prefetch must be at least 1")
        self.parts = parts
        self.workers = workers
        self.emit = emit
        self.collect = collect
        self.ordered = ordered
        self.emitter = emitter
        self.collector = collector
        self.key = key
        self.prefetch = prefetch
        self.window = window
        names = {part.name for part in parts}
        self.name = name or (parts[0].name if len(names) == 1 else "farm")
        self.capacity = capacity
        self.tagged = tagged

    def __repr__(self) -> str:
        return (
            f"<tolquane.Farm {self.name} x{self.workers} emit={self.emit} collect={self.collect}>"
        )

    def expand(self, names: _Names) -> Graph:
        base = names.unique(self.name)
        g = Graph()
        window_id: str | None = None
        if self.tagged:
            window_id = f"{base}.window"
            g.windows[window_id] = self.window or self.workers * 64
        worker_names: list[str] = []
        for i in range(self.workers):
            wname = f"{base}.{i}"
            worker_names.append(wname)
            g.nodes.append(
                self.parts[i].spec(wname, index=i, group=base, role="worker", tagged=self.tagged)
            )
        in_cap = self.prefetch if self.emit == "on_demand" else self.capacity
        if self.emitter is False:
            g.inlets = list(worker_names)
        else:
            ename = f"{base}.emitter"
            g.nodes.insert(0, self._end_spec(self.emitter, ename, "emitter", base, window_id))
            g.inlets = [ename]
            g.edges.extend(EdgeSpec(ename, w, "farm", in_cap) for w in worker_names)
        if self.collector is False:
            g.outlets = list(worker_names)
        else:
            cname = f"{base}.collector"
            g.nodes.append(self._end_spec(self.collector, cname, "collector", base, window_id))
            g.outlets = [cname]
            g.edges.extend(EdgeSpec(w, cname, "farm", self.capacity) for w in worker_names)
        return g

    def _end_spec(
        self, custom: Any, name: str, role: str, group: str, window_id: str | None
    ) -> NodeSpec:
        part = _parts(forward if custom is None else custom)
        if part.kind == "source":
            raise GraphError(
                f"custom {role} {part.name!r} must take an item: def {part.name}(item, ctx)"
            )
        return part.spec(
            name,
            group=group,
            role=role,
            distribute=self.emit if role == "emitter" else "round_robin",
            collect=self.collect if role == "collector" else "first_come",
            tagged=self.tagged,
            key=self.key if role == "emitter" else None,
            window=window_id,
        )


class Comb(Block):
    """Two nodes fused into one: the first node's outputs feed the second directly."""

    def __init__(self, first: Any, second: Any) -> None:
        a = as_block(first)
        b = as_block(second)
        if not isinstance(a, Node) or not isinstance(b, Node):
            raise GraphError("comb() fuses two plain nodes; farms and pipelines cannot be combined")
        for n in (a, b):
            if n.kind in ("source", "raw", "comb"):
                raise GraphError(
                    f"comb() cannot fuse {describe_block(n)}; use map, flat or ctx nodes"
                )
        if a.is_sink:
            raise GraphError(f"comb(): {describe_block(a)} is a sink, nothing can follow it")
        self.first = a
        self.second = b
        self.name = f"{a.name}+{b.name}"

    def __repr__(self) -> str:
        return f"<tolquane.Comb {self.name}>"

    def expand(self, names: _Names) -> Graph:
        name = names.unique(self.name)
        spec_a = self.first.spec(f"{name}.a")
        spec_b = self.second.spec(f"{name}.b")
        node = NodeSpec(
            name=name, kind="comb", target=(spec_a, spec_b), is_sink=self.second.is_sink
        )
        g = Graph(nodes=[node], inlets=[name])
        if not node.is_sink:
            g.outlets = [name]
        return g


def as_block(obj: Any) -> Block:
    if isinstance(obj, Block):
        return obj
    if callable(obj):
        return Node(obj)
    raise GraphError(f"{obj!r} is not a block or a callable")


# --------------------------------------------------------------------------- build


def build(block: Any) -> Graph:
    """Expand and validate. Raises ``GraphError`` with a fix for anything wrong."""
    g = as_block(block).expand(_Names())
    validate(g)
    return g


def validate(g: Graph) -> None:
    names = {n.name for n in g.nodes}
    for e in g.edges:
        if e.src not in names or e.dst not in names:
            raise GraphError(f"edge {e.src} -> {e.dst} refers to an unknown node")
    for n in g.nodes:
        inc = g.incoming(n.name)
        out = g.outgoing(n.name)
        if n.kind == "source":
            if inc:
                raise GraphError(
                    f"source {n.name!r} has an input from {inc[0].src!r}; a source starts a "
                    "pipeline and takes no input"
                )
        elif not inc and n.kind != "raw":
            raise GraphError(
                f"node {n.name!r} has no input; put a source before it, or make it a source "
                "with @tq.source"
            )
        if n.is_sink:
            if out:
                raise GraphError(
                    f"sink {n.name!r} is followed by {out[0].dst!r}; a sink ends a pipeline"
                )
        elif n.kind in ("map", "flat", "comb") and not out:
            raise GraphError(
                f"node {n.name!r} returns values but nothing reads them; add a stage after "
                "it or mark it @tq.sink"
            )
        elif n.kind == "source" and not out:
            raise GraphError(f"source {n.name!r} has no output; add a stage after it")
