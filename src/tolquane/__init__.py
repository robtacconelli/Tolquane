"""Tolquane: parallel programming with composable building blocks.

Nodes speak on channels. Pipelines, farms and all-to-all blocks compose them, and the
same graph runs on threads, processes or across a network. The design lives in
``DESIGN.md`` at the repository root.

    import tolquane as tq

    @tq.source
    def numbers():
        yield from range(1, 101)

    @tq.node
    def double(x):
        return x * 2

    out = tq.to_list()
    tq.run(numbers >> tq.farm(double, workers=4) >> out)
    print(sorted(out.items))
"""

from __future__ import annotations

from ._sentinels import EOS, SKIP
from .api import (
    ListSink,
    comb,
    farm,
    from_iterable,
    node,
    pipeline,
    raw,
    sink,
    source,
    to_list,
)
from .draw import draw, explain
from .errors import (
    ChannelClosed,
    DeadlockError,
    GraphError,
    NodeError,
    TolquaneError,
)
from .graph import Block, Comb, Farm, Graph, Node, Pipeline
from .run import check, run
from .runner import Context
from .runtime import NodeStats, Report

__version__ = "0.1.0.dev0"

__all__ = [
    "EOS",
    "SKIP",
    "Block",
    "ChannelClosed",
    "Comb",
    "Context",
    "DeadlockError",
    "Farm",
    "Graph",
    "GraphError",
    "ListSink",
    "Node",
    "NodeError",
    "NodeStats",
    "Pipeline",
    "Report",
    "TolquaneError",
    "__version__",
    "check",
    "comb",
    "draw",
    "explain",
    "farm",
    "from_iterable",
    "node",
    "pipeline",
    "raw",
    "run",
    "sink",
    "source",
    "to_list",
]
