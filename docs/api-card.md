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
| `@tq.raw` on `def f(ctx)` | Full control: `for src, item in ctx.inputs(): ...`, `ctx.recv(source=i)`. |
| a class with `__call__(self, x)` | Stateful node, one instance per worker. Optional `on_start(self, ctx)` and `on_end(self, ctx)`. |

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
tq.comb(a, b)                     # fuse two nodes on one thread
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
tq.run(graph, capacity=64)                    # bound every edge (default 1024; None = unbounded)
print(report)                                 # items in/out per node, queue high-water marks
```

Errors: `tq.GraphError` (bad wiring, raised before anything runs), `tq.NodeError`
(user code raised; `.node`, `.index`, `__cause__`), `tq.DeadlockError` (every node
waiting; message names the cycle). Several failures come as an `ExceptionGroup`.

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
