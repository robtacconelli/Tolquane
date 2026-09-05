# Tolquane

[![CI](https://github.com/robtacconelli/Tolquane/actions/workflows/ci.yml/badge.svg)](https://github.com/robtacconelli/Tolquane/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Parallel programming with composable building blocks, in Python.

Nodes speak on channels. Pipelines, farms and all-to-all blocks compose them, and the
same graph runs on threads, processes or across a network. Tolquane is the successor of
[BBFlow](https://github.com/robtacconelli/BBFlow), a Java implementation of the
[FastFlow](https://github.com/fastflow/fastflow) building blocks, rebuilt from scratch
to be simple to use and impossible to hang.

> **Status: design phase.** The package on PyPI is a placeholder that reserves the
> name. The API below is the target; see [DESIGN.md](DESIGN.md) for the full design,
> the liveness rules and the roadmap.

## What it will look like

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
tq.run(graph, runtime="processes")     # same graph, multiprocess
```

A function is a node. Return `tq.SKIP` to drop an item; `None` is an ordinary value.
A generator function yields zero or many items. Farms come with round-robin, broadcast,
scatter, on-demand and key-based emitters, first-come, round-robin, gather and ordered
collectors, and feedback loops that terminate by rule.

## Runtimes

| Runtime | Use when |
|---|---|
| `sync` | Tests and debugging: the whole graph runs deterministically in the calling thread. |
| `threads` | I/O-bound stages, numpy and C work, and full parallelism on free-threaded CPython 3.14t. |
| `processes` | CPU-bound pure Python on a GIL build. |
| `asyncio` | Network-heavy stages and `async def` nodes. |
| distributed | Two or more machines: edges crossing a host boundary become TCP channels from a deploy file. |

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
