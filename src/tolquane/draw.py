"""Pure views of a graph: a Mermaid diagram and a plain-text explanation."""

from __future__ import annotations

import re
from typing import Any

from .graph import DEFAULT_CAPACITY, Graph, NodeSpec, build


def _graph(block: Any) -> Graph:
    return block if isinstance(block, Graph) else build(block)


def _nid(name: str) -> str:
    return "n_" + re.sub(r"\W", "_", name)


def _shape(n: NodeSpec) -> str:
    nid = _nid(n.name)
    if n.kind == "source":
        return f'{nid}(["{n.name}"])'
    if n.is_sink:
        return f'{nid}[["{n.name}"]]'
    if n.role in ("emitter", "collector"):
        return f'{nid}{{{{"{n.name}"}}}}'
    return f'{nid}["{n.name}"]'


def draw(block: Any) -> str:
    """Mermaid ``flowchart`` text of the wired graph, farms drawn as subgraphs."""
    g = _graph(block)
    lines = ["flowchart LR"]
    groups: dict[str, list[NodeSpec]] = {}
    loose: list[NodeSpec] = []
    for n in g.nodes:
        if n.group:
            groups.setdefault(n.group, []).append(n)
        else:
            loose.append(n)
    for n in loose:
        lines.append("  " + _shape(n))
    for group, nodes in groups.items():
        workers = sum(1 for n in nodes if n.role == "worker")
        lines.append(f'  subgraph {_nid(group)}["farm {group} ({workers} workers)"]')
        lines.extend("    " + _shape(n) for n in nodes)
        lines.append("  end")
    for e in g.edges:
        label = "" if e.rule in ("1-1", "farm") else f"|{e.rule}|"
        lines.append(f"  {_nid(e.src)} -->{label} {_nid(e.dst)}")
    return "\n".join(lines)


def explain(block: Any) -> str:
    """One line per node and per edge saying what was inferred and which rule wired it."""
    g = _graph(block)
    lines = []
    for n in g.nodes:
        n_in = len(g.incoming(n.name))
        n_out = len(g.outgoing(n.name))
        parts: list[str] = [n.kind if not n.is_sink else "sink"]
        if n.role == "emitter":
            parts.append(f"emit={n.distribute}")
        if n.role == "collector":
            parts.append(f"collect={n.collect}")
        if n.role == "worker" and n.tagged:
            parts.append("tagged")
        if n.factory:
            parts.append("one instance per node")
        lines.append(f"{n.name}: {', '.join(parts)}; {n_in} input(s), {n_out} output(s)")
    if g.edges:
        lines.append("edges:")
        for e in g.edges:
            cap = "" if e.capacity == DEFAULT_CAPACITY else f", capacity {e.capacity}"
            lines.append(f"  {e.src} -> {e.dst}  [{e.rule}{cap}]")
    if g.windows:
        for wid, limit in g.windows.items():
            lines.append(f"window {wid}: at most {limit} tagged items in flight")
    return "\n".join(lines)
