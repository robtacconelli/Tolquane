# Cookbook

Short recipes. Each is a complete idea; the [examples](https://github.com/robtacconelli/Tolquane/tree/main/examples)
directory has full files in the house style, ten of them written by the AI builder.

## Route items to specific workers

```python
@tq.node
def route(x, ctx):
    ctx.send(x, to=0 if x % 2 == 0 else 1)          # output index

tq.farm(work, 2, emitter=route)                     # your emitter replaces the default
```

## Keep results in input order

```python
tq.farm(work, 8, ordered=True)
```

The runtime tags items and reorders them at the collector, with a bounded window.
Workers that `SKIP` or yield several outputs still keep the order.

## Feedback: iterate until done

```python
@tq.node
def refine(state):
    n, x = state
    return n, 0.5 * (x + n / x)

@tq.node
def route(state, ctx):
    n, x = state
    if abs(x * x - n) < 1e-9:
        ctx.send(state)                             # leaves the loop
    else:
        ctx.feedback(state)                         # goes round again

tq.run(numbers >> tq.feedback(tq.farm(refine, 4, collector=route)) >> show)
```

The loop closes by itself when the outside input has ended and nothing is in flight.

## Scatter and gather arrays

```python
@tq.node
def normalize(chunk):                               # a slice of one row
    return [v / top for v in chunk]

tq.farm(normalize, 4, emit="scatter")               # split each row, gather it back in order
```

Numpy arrays are sliced as views; nothing is copied on the way out.

## A long-lived graph

```python
with tq.session(tq.farm(work, 4)) as s:
    s.put(item)
    print(s.get(timeout=5))
```

## Many concurrent requests

```python
async def fetch(url):
    async with session.get(url) as r:
        return url, r.status

tq.run(urls >> tq.farm(fetch, workers=200) >> save)
```

A farm of coroutines is one pool running two hundred of them at a time on one thread.

## CPU-bound work on a normal Python

```python
tq.run(graph, runtime="processes")                  # every farm worker in its own process
tq.farm(heavy, 8, runtime="processes")              # or just this farm
```

Workers must be importable (module-level, `if __name__ == "__main__":`); closures
need `pip install cloudpickle`.

## Two machines

```toml
[groups.A]
endpoint = "10.0.0.1:7000"
nodes = ["numbers", "work.emitter", "work.collector", "show"]
[groups.B]
endpoint = "10.0.0.2:7000"
nodes = ["work.[0-9]*"]
```

`tolquane run flow.py --deploy deploy.toml --group A` on one host, `--group B` on the
other. The edges that cross become TCP channels with backpressure and resend.

## Where does the time go

```python
tq.run(graph, trace="trace.json")                   # open in Perfetto or chrome://tracing
print(tq.run(graph))                                # items in and out per node, queue depths
```

## A topology the blocks cannot say

```python
from tolquane.graph import expand
g = expand(src >> tq.farm(tq.raw(Cell), 9, name="grid") >> out)
g.link("grid.0", "grid.1")                          # a channel between two workers
tq.run(g)
```

The MSOM example uses this for a grid of slices that train across their borders.
