# Tolquane

Parallel programming with composable building blocks, in Python.

Nodes speak on channels. Pipelines, farms and all-to-all blocks compose them, and the
same graph runs on threads, in child processes, across machines, or on one thread for
debugging. Tolquane is the successor of BBFlow, a Java implementation of the FastFlow
building blocks, rebuilt from scratch to be simple to use and impossible to hang.

```python
import tolquane as tq

@tq.source
def numbers():
    yield from range(1, 101)

@tq.node
def double(x: int) -> int:
    return x * 2

@tq.sink
def show(x: int) -> None:
    print(x)

tq.run(numbers >> tq.farm(double, workers=4, ordered=True) >> show)
```

A function is a node. `>>` builds a pipeline. A farm runs copies of a node in parallel.
Return `tq.SKIP` to drop an item; `None` is an ordinary value; a generator yields many.

## What you get

- **Blocks**: sources, nodes, sinks, farms with round-robin, on-demand, broadcast,
  scatter and keyed emitters and first-come, round-robin, gather and ordered
  collectors, node fusion, all-to-all, feedback loops that terminate by rule.
- **Runtimes**: threads (full parallelism on free-threaded Python), processes for
  CPU-bound work on GIL builds, TCP between hosts from a deploy file, coroutine pools
  for network-bound stages, and a deterministic single-thread runtime for tests.
- **No hangs**: every edge is bounded, every node waits on one inbox, errors cancel the
  run and name the node, and a watchdog reports deadlocks by name.
- **An AI builder**: `tolquane build "..."` writes, checks and runs a flow from a
  sentence with your own Claude or GPT key.
- **A GUI**: `tolquane web` opens a canvas of the blocks with the Python beside it,
  live runs, a history and schedules.

Install with `pip install tolquane`. Pure Python, 3.11 or newer, no required
dependencies. Then read the [tutorial](tutorial.md), keep the [API card](api-card.md)
open, and pick a [runtime](runtimes.md).

## Tolquane Web

`pip install "tolquane[web]"` and `tolquane web` open a local page for the flows in one
directory: the blocks on a canvas, the Python one click away and editable both ways,
runs with per-node counts and tapped items as they happen, a run history, cron schedules
and the AI builder in a side panel. The file is still a plain `flow.py`, so anything
made there runs with `python flow.py` wherever Tolquane is installed. The
[user guide](web-user.md) is the tour.
