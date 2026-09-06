# Tolquane API card

The whole public surface on one page. `import tolquane as tq`.

## Nodes: a function is a node

| Write | Meaning |
|---|---|
| `@tq.source` on `def f(): yield ...` | Produces items. No inputs. |
| `@tq.node` on `def f(x): return y` | Map. The return value is sent. `return tq.SKIP` sends nothing. `None` is a normal value. |
| `@tq.node` on `def f(x): yield ...` | Flat map. Each yielded value is sent. |
| `@tq.node` on `def f(x, ctx): ctx.send(y)` | Explicit sends: `ctx.send(y)`, `ctx.send(y, to=i)`, `ctx.broadcast(y)`, `ctx.stop()`. Must not return a value. |
| `@tq.sink` on `def f(x)` or `def f(x, ctx)` | Consumes items. No outputs. |
| `@tq.raw` on `def f(ctx)` | Full control: `for src, item in ctx.inputs(): ...`, `ctx.recv(source=i)` reads one input and returns `None` when it ends; call `ctx.flush()` before blocking on anything outside Tolquane. Raw nodes can be farm workers, emitters or collectors, except in ordered and gather farms. |
| a class with `__call__(self, x)` | Stateful node, one instance per worker. Optional `on_start(self, ctx)` and `on_end(self, ctx)`. |
| `async def f(x)` | A coroutine node: takes the item only (no `ctx`), returns or yields what to send. `tq.farm(f, workers=200)` is one pool running 200 coroutines at a time on one thread, for network-bound work; `ordered=True` keeps input order. Async classes may have async hooks. |

`ctx.index` is the worker number, `ctx.source` the input the current item came from,
`ctx.name` the node name. Decorated functions stay callable: `f(3)` works in tests.

## Blocks

```python
a >> b >> c                       # pipeline; tq.pipeline(a, b, c) is the same
tq.farm(work, workers=8)          # emitter -> 8 workers -> collector
tq.farm(work, 8, emit="round_robin" | "on_demand" | "broadcast" | "scatter", key=fn)
tq.farm(work, 8, collect="first_come" | "round_robin" | "gather")
tq.farm(work, 8, ordered=True)    # output order == input order
tq.farm(work, 8, emitter=my_router, collector=my_merge)   # custom ends
tq.farm(work, 8, emitter=False)   # expose the workers' inputs (1xN wiring)
tq.farm([f, g, h])                # one worker per callable
tq.farm(a >> b, 4)                # any block as a worker: pipeline, farm, feedback, all2all
tq.comb(a, b)                     # fuse two nodes on one thread
tq.all2all(left_farm, right_farm) # every left worker to every right worker
tq.all2all(left, right, R=r, G=g, merge=False)   # r after each left worker, g before each right one
tq.feedback(block)                # wire the block's outputs back to its inputs
```

Inside a `feedback` block the last stage sends back with `ctx.feedback(item)` and the
first stage sees `ctx.is_feedback`. The loop closes by itself when the outside input has
ended and nothing is in flight; `ctx.stop()` in the first stage ends it earlier.
A class node with `on_start` may have no inputs at all: it produces in the hook.

Topologies the blocks cannot say (a grid of workers talking to their neighbours):
expand, link by name, run.

```python
from tolquane.graph import expand
g = expand(src >> tq.farm(tq.raw(Cell), 9, name="grid") >> out)
g.link("grid.0", "grid.1")      # new last output of grid.0, new last input of grid.1
tq.run(g)
```

Scatter splits a sequence across workers; gather concatenates the results in order.
`emit="on_demand"` gives each worker one item at a time (`prefetch=` to change).
`key=lambda x: x.user` sends items with the same key to the same worker.

## Wiring rules for `>>`

1 output to 1 input: one channel. 1 to N: one channel per input, round robin.
N to 1: all into one inbox. N to N: pairwise. N to M: every pair.

## Running

```python
report = tq.run(graph)                        # threads
report = tq.run(graph, runtime="sync")        # deterministic, single-threaded
tq.run(graph, runtime="processes")   # every farm worker in its own process, the rest here
tq.farm(work, 8, runtime="processes")   # only this farm's workers in processes
tq.run(graph, deploy="deploy.toml", group="G1")   # this host's share; other hosts run their group
#   tolquane launch deploy.toml flow.py         # shell: start every group, here or over ssh
tq.run(tq.optimize(graph))                    # fewer threads: stages fused into farm ends, default collectors dropped
tq.run(graph, capacity=64)                    # bound every edge (default 1024; None = unbounded)
tq.run(graph, batch=1)                        # hand over every item alone (default 32, flushed within 1 ms)
tq.run(graph, trace="trace.json")             # Chrome trace of every node's runs and waits (Perfetto, chrome://tracing)
#   tolquane run flow.py --trace trace.json     # shell: the same file
#   tolquane run flow.py --param threshold=0.5 --param name=fast   # keywords for build(); the value is a Python literal, a plain word stays a string (also on check, explain, draw)
#   tolquane run flow.py --env TZ=UTC --env API_HOST=localhost     # variables set before the flow is imported, and put back afterwards
print(report)                                 # items in/out, busy and wait time per node; report.busiest() names the bottleneck

with tq.session(tq.farm(work, 4)) as s:       # keep a graph running
    s.put(item)                               # feed it
    result = s.get(timeout=5)                 # read results as they come (or iterate s)
```

Errors: `tq.GraphError` (bad wiring, raised before anything runs), `tq.NodeError`
(user code raised; `.node`, `.index`, `__cause__`), `tq.DeadlockError` (every node
waiting; message names the cycle), `tq.WorkerDied` (a worker process crashed),
`tq.RunCancelled` (the run's `stop` event was set). Several failures come as an
`ExceptionGroup`.

Distributed: a deploy file (TOML) names groups, gives each an `endpoint = "host:port"`
and lists the `nodes` it runs (node names, farm names or glob patterns such as
`"work.[0-9]*"`); edges between groups become TCP channels with backpressure, resend
after a dropped connection, and an optional `secret` under `[options]`. A feedback loop
and an ordered farm's emitter and collector stay in one group. `tolquane run flow.py
--deploy deploy.toml --group G1` on every host.

Processes: workers must be importable (module-level functions or classes, a
`if __name__ == "__main__":` guard); lambdas and closures need `pip install cloudpickle`.
Worker state lives in the child; send results out in `on_end`. Send rows, chunks or
arrays rather than scalars, since each hand-off now crosses a pipe.

## Watching a run

```python
tq.run(graph, on_progress=show, progress_interval=0.5, tap=5, stop=threading.Event())
#   tolquane run flow.py --events [--progress-interval 0.5] [--tap 5]
```

`show(p)` is called from the run's watchdog thread every `progress_interval` seconds and
once more at the end, where `p.phase` turns from `"running"` into `"done"`, `"failed"`,
`"cancelled"` or `"deadlock"`. `p.nodes[name]`: `state` (`new`, `running`, `waiting`,
`done`, `failed`), `reason` (`input`, `output`, `window`, `loop`), `detail`, `items_in`,
`items_out`, `dropped`, `busy`, `wait_in`, `wait_out`. `p.edges["src->dst"]`: `queued`,
`high_water`, `capacity`, `taps` (the last `tap` items as `repr` cut to 200 characters;
none by default). Snapshots take no channel lock, so watching costs the run nothing.
Setting `stop` cancels the run the way an error does and `run` then raises
`tq.RunCancelled`; a failure is still reported ahead of the cancellation it caused.
`p.to_dict()` and `report.to_dict()` are JSON-ready. `--events` prints one JSON object
per line (`start` with the expanded graph, `progress`, `stdout`, `stderr`, `report`,
`error`, `deadlock`, `done`), turning the flow's own output into events; `SIGTERM` and
`SIGINT` cancel the run, and it exits 0, 1 or 130.

## Looking before running

```python
tq.check(graph)     # validate; raises GraphError with a fix
tq.explain(graph)   # one line per node and edge: kinds, policies, wiring rule
tq.draw(graph)      # Mermaid flowchart text
```

## Test helpers

```python
out = tq.to_list()
tq.run(tq.from_iterable(range(10)) >> double >> out)
assert out.items == [0, 2, 4, ...]
```

## Tolquane Web

```
pip install "tolquane[web]"
tolquane web [--host 127.0.0.1] [--port 8765] [--workspace DIR] [--token T] [--no-browser]
```

A local page for the flows in one directory: a canvas of the blocks, the Python beside
it, runs with live per-node counts, schedules and the AI builder. The file is still a
plain `flow.py`; the canvas is a view of it. Flows run in child processes, so a hung or
crashing flow cannot take the server down. `--token` is needed for any host other than
`127.0.0.1`; `--check` starts the server, asks `/api/health` and stops, for CI.
