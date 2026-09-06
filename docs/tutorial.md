# Tutorial

Five minutes from install to a flow that runs on threads, on processes and on two
machines without changing a line of it.

## 1. Install and run

```
pip install tolquane
```

```python
import tolquane as tq

@tq.source
def lines():
    with open("access.log") as f:
        yield from f

@tq.node
def status(line: str) -> int:
    return int(line.split()[8])

@tq.sink
def count(code: int) -> None:
    print(code)

tq.run(lines >> status >> count)
```

Three kinds of node: a *source* yields items, a *node* turns one item into another, a
*sink* consumes. `>>` connects them with bounded channels; `tq.run` runs each on its own
thread and returns a report.

## 2. Filter, fan out, keep state

```python
@tq.node
def errors(code: int) -> int:
    return code if code >= 500 else tq.SKIP        # SKIP sends nothing; None would be sent

@tq.node
def words(line: str):
    yield from line.split()                        # a generator yields zero or many

class Tally:                                        # a class holds state, one per worker
    def __init__(self):
        self.counts = {}
    def __call__(self, word: str):
        self.counts[word] = self.counts.get(word, 0) + 1
        return tq.SKIP
    def on_end(self, ctx):                          # flush when the stream ends
        for pair in self.counts.items():
            ctx.send(pair)
```

## 3. Farms

```python
tq.farm(status, workers=8)                          # 8 copies, round robin, first come
tq.farm(status, 8, ordered=True)                    # results in input order
tq.farm(status, 8, emit="on_demand")                # one item at a time per worker
tq.farm(Tally, 8, key=lambda w: w)                  # same key, same worker
tq.farm(chunk_sum, 8, emit="scatter")               # split a sequence, gather the parts
```

Put the farm where the time goes: `lines >> tq.farm(status, 8) >> count`.

## 4. Look before running, and read the errors

```python
tq.check(graph)      # validates the wiring; a GraphError says the fix
tq.explain(graph)    # kinds, policies and the rule that wired each edge
tq.draw(graph)       # Mermaid diagram
```

A node that raises stops the run with a `NodeError` naming it. A graph that cannot make
progress raises `DeadlockError` naming the nodes and what each waits for. Nothing hangs.

## 5. Pick a runtime

```python
tq.run(graph)                                       # threads
tq.run(graph, runtime="processes")                  # farm workers in child processes
tq.run(graph, runtime="sync")                       # one thread, deterministic, for tests
tq.run(graph, deploy="deploy.toml", group="G1")     # this host's share of the graph
tq.run(tq.optimize(graph))                          # same graph, fewer threads
```

Same graph every time. See [Runtimes](runtimes.md) for which one to pick, and
`print(tq.run(graph))` for the busy time of every stage: the stage that is busy while
its neighbours wait is the one to farm.

## 6. Test a flow

```python
out = tq.to_list()
tq.run(tq.from_iterable(["... 200 ...", "... 503 ..."]) >> status >> out, runtime="sync")
assert out.items == [200, 503]
```

Decorated functions stay callable, so `status("... 200 ...")` still works in a unit test.
