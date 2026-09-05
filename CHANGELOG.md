# Changelog

## 1.0.0, 2026-09-05

The first release, built from the design in `DESIGN.md` on the vocabulary of the
FastFlow building blocks and the lessons of BBFlow, its Java predecessor.

### Blocks
- A function is a node: `def f(x)` returns what to send, `tq.SKIP` sends nothing,
  `None` is a value, a generator yields many, `def f(x, ctx)` sends explicitly, a class
  holds state with `on_start` and `on_end`, `@tq.raw` has full control.
- `>>` pipelines with the five FastFlow wiring rules; farms with round-robin, on-demand,
  broadcast, scatter and keyed emitters and first-come, round-robin, gather and
  ordered collectors, custom or absent ends, lists of different workers; `comb()`
  fusion; `all2all()` with its eight cases; `feedback()` with a termination rule;
  `session()`; `Graph.link()` for topologies the blocks cannot say.

### Runtimes
- Threads, with one inbox per node, bounded edges, batching, EOS as a message, errors
  that cancel the run and name the node, and a deadlock detector that names the cycle.
- Processes: farm workers in spawned children, everything else in the parent, credits
  kept exact by a completion marker per item; 5.5x on eight workers on a GIL build.
- Async nodes: `async def` nodes on an event loop, and a farm of them as one pool
  running `workers` coroutines at a time on one thread.
- Distributed: a deploy file cuts the graph into groups; edges between groups are TCP
  channels with backpressure, resend after a drop, and an optional shared secret.
- Sync: deterministic, one node at a time, exact deadlock detection, for tests.

### Tools
- `tq.check`, `tq.explain`, `tq.draw`, `trace=` for Chrome trace files, `tq.to_list`
  and `tq.from_iterable` for tests.
- The AI builder: `tolquane build "..."` and `tolquane.ai.build()`, Claude Opus 5 by
  default or GPT, writes, checks and runs a flow and takes change requests; ten flows it
  wrote are in `examples/generated`.
- `tolquane check | run | explain | draw` on any file that defines `build(source=None)`.

### Provenance
- Every BBFlow program has a counterpart test, including the MSOM use case with grid
  links, whose parallel map equals the sequential one exactly.
