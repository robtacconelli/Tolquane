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
    all2all,
    comb,
    farm,
    feedback,
    from_iterable,
    node,
    pipeline,
    raw,
    session,
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
    WorkerDied,
)
from .graph import AllToAll, Block, Comb, Farm, Feedback, Graph, Node, Pipeline
from .net import PeerFailed, PeerLost, load_deployment
from .run import check, run
from .runner import Context
from .runtime import NodeStats, Report
from .session import Session, SessionClosed

__version__ = "0.5.0.dev0"

__all__ = [
    "EOS",
    "SKIP",
    "AllToAll",
    "Block",
    "ChannelClosed",
    "Comb",
    "Context",
    "DeadlockError",
    "Farm",
    "Feedback",
    "Graph",
    "GraphError",
    "ListSink",
    "Node",
    "NodeError",
    "NodeStats",
    "PeerFailed",
    "PeerLost",
    "Pipeline",
    "Report",
    "Session",
    "SessionClosed",
    "TolquaneError",
    "WorkerDied",
    "__version__",
    "all2all",
    "check",
    "comb",
    "draw",
    "explain",
    "farm",
    "feedback",
    "from_iterable",
    "load_deployment",
    "node",
    "pipeline",
    "raw",
    "run",
    "session",
    "sink",
    "source",
    "to_list",
]
