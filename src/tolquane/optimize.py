"""Graph rewrites that cut threads without changing what a flow computes.

Tolquane runs one thread per node. A flow written the natural way, stage by stage,
often has stages that only feed a farm or only read from one; each costs a thread and
a channel. ``optimize(block)`` rewrites the block tree the way FastFlow's
``optimize_static`` does:

- ``fuse_emitter``: a plain stage right before a farm becomes that farm's emitter.
- ``remove_collector``: a farm's default collector goes when the next stage can read the
  workers directly (a node reads every input first come, a farm's emitter too).
- ``fuse_collector``: an ordered or gather farm keeps its collector, so the stage after
  it is fused into the collector instead.
- ``merge_farms``: a farm of farms with default policies becomes one farm of all the
  workers (FastFlow's normal form).
- ``all2all``: two farms in a row become an all-to-all, dropping a collector and an
  emitter at once. Off by default: every left worker then distributes on its own, which
  changes which worker gets which item (not the results of an unordered farm).

Nothing here touches ordered or gather farms' ends, coroutine pools, raw nodes, sources,
or the ends of a feedback loop that the loop wires back.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .graph import (
    AllToAll,
    Block,
    Comb,
    Farm,
    Feedback,
    Node,
    Pipeline,
    as_block,
    expand,
)

__all__ = ["Rules", "optimize"]


@dataclass(frozen=True)
class Rules:
    fuse_emitter: bool = True
    remove_collector: bool = True
    fuse_collector: bool = True
    merge_farms: bool = True
    all2all: bool = False


def optimize(
    block: Any,
    *,
    fuse_emitter: bool = True,
    remove_collector: bool = True,
    fuse_collector: bool = True,
    merge_farms: bool = True,
    all2all: bool = False,
    verbose: bool = False,
    notes: list[str] | None = None,
) -> Block:
    """Return an equivalent block with fewer nodes. See the module docstring for the rules.

    ``verbose=True`` prints one line per rewrite and the node count before and after;
    ``notes`` collects the same lines. The result is a new block; the argument is not
    changed, and its nodes are shared, not copied.
    """
    rules = Rules(fuse_emitter, remove_collector, fuse_collector, merge_farms, all2all)
    log: list[str] = [] if notes is None else notes
    before = len(expand(block).nodes)
    result = _optimize(as_block(block), rules, log.append, in_loop=False)
    after = len(expand(result).nodes)
    log.append(f"optimize: {before} nodes -> {after} nodes")
    if verbose:
        for line in log:
            print(line, file=sys.stderr)
    return result


# --------------------------------------------------------------------------- predicates


def _fusable(block: Block, *, sink_ok: bool) -> bool:
    """A stage that can run inside a farm's end: map, flat or ctx nodes and combs."""
    if isinstance(block, Comb):
        return sink_ok or not block.nodes[-1].is_sink
    if not isinstance(block, Node):
        return False
    if block.kind not in ("map", "flat", "ctx") or block.is_async:
        return False
    return sink_ok or not block.is_sink


def _is_pool(farm: Farm) -> bool:
    return any(p.is_async for p in farm.parts)


def _default_ends(farm: Farm) -> bool:
    return farm.emitter is None and farm.collector is None


def _plain(farm: Farm) -> bool:
    """Round robin in, first come out, no key, no ordering: what a merge may assume."""
    return (
        farm.emit == "round_robin"
        and farm.collect == "first_come"
        and farm.key is None
        and not farm.tagged
    )


def _reads_first_come(block: Block) -> bool:
    """True when the block's single input takes items from many producers as they come."""
    if isinstance(block, Node):
        return block.kind != "source"
    if isinstance(block, Comb):
        return True
    if isinstance(block, Farm):
        return block.emitter is not False
    return False


# --------------------------------------------------------------------------- rewriting


def _optimize(block: Block, rules: Rules, note: Callable[[str], None], *, in_loop: bool) -> Block:
    if isinstance(block, Pipeline):
        stages = [_optimize(b, rules, note, in_loop=False) for b in block.blocks]
        stages = _rewrite(stages, rules, note, in_loop=in_loop)
        return stages[0] if len(stages) == 1 else Pipeline(stages)
    if isinstance(block, Farm):
        return _optimize_farm(block, rules, note)
    if isinstance(block, Feedback):
        inner = _optimize(block.inner, rules, note, in_loop=True)
        return block if inner is block.inner else Feedback(inner, name=block.name)
    if isinstance(block, AllToAll):
        left = _optimize_farm(block.left, rules, note)
        right = _optimize_farm(block.right, rules, note)
        if left is block.left and right is block.right:
            return block
        return AllToAll(left, right, R=block.R, G=block.G, merge=block.merge)
    return block


def _optimize_farm(farm: Farm, rules: Rules, note: Callable[[str], None]) -> Farm:
    workers: list[Any] = []
    changed = False
    for w in farm.raw_workers:
        if isinstance(w, Block) and not isinstance(w, Node | Comb):
            new = _optimize(w, rules, note, in_loop=False)
            if isinstance(new, Pipeline) and len(new.blocks) == 1:
                new = new.blocks[0]
            changed |= new is not w
            workers.append(new)
        else:
            workers.append(w)
    if changed:
        farm = farm.clone(worker=workers)
    if (
        rules.merge_farms
        and _default_ends(farm)
        and _plain(farm)
        and all(isinstance(w, Farm) for w in workers)
        and all(_default_ends(w) and _plain(w) and not _is_pool(w) for w in workers)
    ):
        inner: list[Farm] = workers
        runtimes = {w.runtime for w in inner}
        if len(runtimes) == 1:
            flat = [x for w in inner for x in w.raw_workers]
            note(
                f"merge_farms: farm {farm.name!r} of {len(inner)} farms becomes one farm of "
                f"{len(flat)} workers"
            )
            return farm.clone(worker=flat, runtime=runtimes.pop() or farm.runtime)
    return farm


def _rewrite(
    stages: list[Block], rules: Rules, note: Callable[[str], None], *, in_loop: bool
) -> list[Block]:
    """Apply the pipeline rules until nothing changes."""
    while True:
        new = _rewrite_once(stages, rules, note, in_loop=in_loop)
        if new is None:
            return stages
        stages = new


def _rewrite_once(
    stages: list[Block], rules: Rules, note: Callable[[str], None], *, in_loop: bool
) -> list[Block] | None:
    for i in range(len(stages) - 1):
        a, b = stages[i], stages[i + 1]
        # A plain stage before a farm runs as its emitter.
        if (
            rules.fuse_emitter
            and isinstance(b, Farm)
            and b.emitter is None
            and not _is_pool(b)
            and _fusable(a, sink_ok=False)
        ):
            note(f"fuse_emitter: {_name(a)} becomes the emitter of farm {b.name!r}")
            return [*stages[:i], b.clone(emitter=a), *stages[i + 2 :]]
        if not isinstance(a, Farm) or a.collector is not None or _is_pool(a):
            continue
        last_in_loop = in_loop and i + 1 == len(stages) - 1
        # Two farms in a row become an all-to-all: no collector, no emitter between them.
        if (
            rules.all2all
            and isinstance(b, Farm)
            and _default_ends(b)
            and not _is_pool(b)
            and _plain(b)
            and a.collect == "first_come"
            and not a.tagged
            and not last_in_loop
        ):
            note(f"all2all: farms {a.name!r} and {b.name!r} join worker to worker")
            return [*stages[:i], AllToAll(a, b), *stages[i + 2 :]]
        # The default collector only forwards first come; the next stage can read the
        # workers itself. A farm at the end of a feedback loop keeps it: the loop's
        # feedback edges start there.
        if (
            rules.remove_collector
            and a.collect == "first_come"
            and not a.tagged
            and _reads_first_come(b)
        ):
            note(
                f"remove_collector: farm {a.name!r} sends straight to {_name(b)}, "
                "which reads every worker first come"
            )
            return [*stages[:i], a.clone(collector=False), *stages[i + 1 :]]
        # An ordered or gather farm needs its collector; fuse the next stage into it.
        if rules.fuse_collector and a.tagged and _fusable(b, sink_ok=True) and not last_in_loop:
            note(f"fuse_collector: {_name(b)} runs inside the collector of farm {a.name!r}")
            return [*stages[:i], a.clone(collector=b), *stages[i + 2 :]]
    return None


def _name(block: Block) -> str:
    if isinstance(block, Node):
        return f"node {block.name!r}"
    if isinstance(block, Comb):
        return f"comb {block.name!r}"
    if isinstance(block, Farm):
        return f"farm {block.name!r}"
    return repr(block)
