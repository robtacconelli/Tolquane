# Tolquane

[![CI](https://github.com/robtacconelli/Tolquane/actions/workflows/ci.yml/badge.svg)](https://github.com/robtacconelli/Tolquane/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Parallel programming with composable building blocks, in Python.

Nodes speak on channels. Pipelines, farms and all-to-all blocks compose them, and the
same graph runs on threads, processes or across a network. Tolquane is the successor of
[BBFlow](https://github.com/robtacconelli/BBFlow), a Java implementation of the
[FastFlow](https://github.com/fastflow/fastflow) building blocks, rebuilt from scratch
to be simple to use and impossible to hang.

> **1.1.** Nodes, pipelines, farms with every emitter and collector policy and any block
> as a worker, ordered farms, node fusion, all-to-all, feedback loops that terminate by
> rule, batching, sessions, deadlock detection, an optimizer that cuts threads; threads,
> processes, coroutine pools, a distributed runtime over TCP with a one-command launcher,
> and a deterministic sync runtime; a run report that names the bottleneck; an AI builder
> that writes, checks and runs flows from a sentence; and Tolquane Web, a local GUI with
> the blocks on a canvas, live runs and schedules. See [DESIGN.md](DESIGN.md) for the
> design and the liveness rules, [docs/api-card.md](docs/api-card.md) for the whole API
> on one page, [examples/](examples/) for flows in the house style, and
> [CHANGELOG.md](CHANGELOG.md).

## What it looks like

```python
import tolquane as tq

@tq.source
def numbers():
    yield from range(1, 101)          # a source is a generator

@tq.node
def double(x: int) -> int:
    return x * 2                       # the return value is sent downstream

@tq.sink
def show(x: int) -> None:
    print(x)

graph = numbers >> tq.farm(double, workers=4) >> show
tq.run(graph)                          # threads by default
tq.run(graph, runtime="processes")     # same graph, farm workers in child processes
tq.run(graph, runtime="sync")          # same graph, one thread, deterministic
tq.run(graph, deploy="deploy.toml", group="G1")   # same graph, this host's share of it
```

```toml
# deploy.toml: each host runs `tolquane run flow.py --deploy deploy.toml --group <name>`
[groups.G1]
endpoint = "10.0.0.1:7000"
nodes = ["numbers", "double.emitter", "double.collector", "show"]
[groups.G2]
endpoint = "10.0.0.2:7000"
nodes = ["double.[0-9]*"]           # the workers, on the other machine
```

A function is a node. Return `tq.SKIP` to drop an item; `None` is an ordinary value.
A generator function yields zero or many items. Farms come with round-robin, broadcast,
scatter, on-demand and key-based emitters, first-come, round-robin, gather and ordered
collectors. `tq.all2all` joins two farms worker to worker, `tq.feedback` wires a block
back onto itself with a loop that closes when nothing is left in flight, and
`tq.session` keeps a graph running while you push items in and read results out.

## Runtimes

| Runtime | Use when |
|---|---|
| `sync` (available) | Tests and debugging: one node runs at a time in a fixed order, and a deadlock is reported the moment it happens. |
| `threads` (available) | I/O-bound stages, numpy and C work, and full parallelism on free-threaded CPython 3.14t. |
| `processes` (available) | CPU-bound pure Python on a GIL build: farm workers in child processes, everything else in the parent. |
| async nodes (available) | Network-heavy stages: `async def` nodes run on an event loop, and a farm of them is one pool running `workers` coroutines at a time on one thread. |
| distributed (available) | Two or more machines: a deploy file cuts the graph into groups, and edges crossing a group become TCP channels with backpressure, resend and an optional shared secret. |

## The AI builder

```
pip install "tolquane[ai]"
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY with --provider openai
tolquane build "read urls.txt, fetch each with 8 workers, write url, status and size to status.csv"
```

The builder writes one short, commented `flow.py` in the house style, checks its wiring,
runs it on the deterministic runtime with a sample it makes up (or `--sample file`),
fixes what fails, then asks you what to change. Claude Opus 5 is the default; GPT works
through `--provider openai`. Ten flows it wrote, unedited, with their transcripts, are in
[examples/generated/](examples/generated/); none of the ten needed a correction.
The same loop is a function: `tolquane.ai.build(description, workdir=".")`.

Generated code runs on your machine, in a subprocess, with a timeout. Keys are read
from the environment and never stored. `tolquane check`, `run`, `explain` and `draw`
work on any file that defines `build(source=None)`.

## Tolquane Web

```
pip install "tolquane[web]"
tolquane web
```

A local page for the flows in one directory: the blocks on a canvas, the Python beside
it and editable both ways, runs with live per-node counts and tapped items, a run
history, cron schedules and the AI builder in a side panel. Flows run in child
processes, so a hung or crashing flow cannot take the server down, and the file stays a
plain `flow.py` that runs with `python flow.py` anywhere Tolquane is installed. The tour,
with screenshots, is [docs/web-user.md](docs/web-user.md).

## Principles

- No hangs. EOS is a message, every edge is bounded, every node waits on one inbox,
  errors cancel the graph, and a watchdog reports deadlocks by name.
- No magic. One way to write a node; cardinality is checked at build time, not guessed.
- No dependencies. Pure Python 3.11+, optional extras for msgpack, numpy and cloudpickle.

## Development

```
uv venv .venv --python 3.13
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest
```

## License

Apache-2.0. See [LICENSE](LICENSE).
