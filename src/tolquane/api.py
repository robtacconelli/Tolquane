"""The decorators and constructors people use. Everything here returns a ``Block``."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from .graph import Comb, Farm, Node, Pipeline


def _decorator(declared: str | None, fn: Any, name: str | None, **kw: Any) -> Any:
    def wrap(f: Any) -> Node:
        return Node(f, declared=declared, name=name, **kw)

    return wrap if fn is None else wrap(fn)


def node(fn: Any = None, *, name: str | None = None, distribute: str = "round_robin") -> Any:
    """A processing node: ``def f(item)`` returns what to send, ``def f(item, ctx)`` sends."""
    return _decorator(None, fn, name, distribute=distribute)


def source(fn: Any = None, *, name: str | None = None) -> Any:
    """A node with no inputs that yields (or returns an iterable of) items."""
    return _decorator("source", fn, name)


def sink(fn: Any = None, *, name: str | None = None) -> Any:
    """A node with no outputs. Its return value is ignored."""
    return _decorator("sink", fn, name)


def raw(fn: Any = None, *, name: str | None = None) -> Any:
    """Full control: ``def f(ctx)`` reads with ``ctx.recv()``/``ctx.inputs()`` and sends itself."""
    return _decorator("raw", fn, name)


def farm(worker: Any, workers: int = 4, **options: Any) -> Farm:
    """Emitter, ``workers`` copies of ``worker`` and a collector. See ``Farm`` for options."""
    return Farm(worker, workers, **options)


def comb(first: Any, second: Any) -> Comb:
    """Fuse two nodes into one so they run on one thread with no channel between them."""
    return Comb(first, second)


def pipeline(*blocks: Any) -> Pipeline:
    """Connect blocks left to right; the same thing as ``a >> b >> c``."""
    return Pipeline(blocks)


class _ListSink:
    def __init__(self) -> None:
        self.items: list[Any] = []

    def __call__(self, item: Any) -> None:
        self.items.append(item)


class ListSink(Node):
    """A sink that keeps every item it receives in ``.items``."""

    def __init__(self, name: str) -> None:
        self._collector = _ListSink()
        super().__init__(self._collector, declared="sink", name=name)

    @property
    def items(self) -> list[Any]:
        return self._collector.items


def to_list(name: str = "to_list") -> ListSink:
    """A sink for tests and quick scripts: run the graph, then read ``sink.items``."""
    return ListSink(name)


def from_iterable(items: Iterable[Any], name: str = "from_iterable") -> Node:
    """A source that yields the given items."""

    def produce() -> Iterable[Any]:
        return items

    return Node(produce, declared="source", name=name)


__all__ = [
    "Callable",
    "ListSink",
    "comb",
    "farm",
    "from_iterable",
    "node",
    "pipeline",
    "raw",
    "sink",
    "source",
    "to_list",
]
