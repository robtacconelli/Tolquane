# Runtimes

One graph, several ways to run it. The graph never changes; only the `runtime` argument
does.

| Runtime | Nodes run as | Pick it when |
|---|---|---|
| `threads` (default) | one thread per node | I/O-bound stages, numpy and C extensions, and full parallelism on free-threaded CPython 3.14t |
| `processes` | farm workers in spawned child processes, the rest as threads here | CPU-bound pure Python on a GIL build |
| async nodes | coroutines on an event loop, a farm of them as one pool | hundreds of concurrent network requests |
| distributed | each group as threads or processes on its host, TCP between groups | two or more machines |
| `sync` | one node at a time in a fixed order, in the calling thread | tests, debugging, deterministic runs; deadlocks reported at once |

## The numbers behind the table

Measured on a 16-thread machine, a farm of eight CPU-bound pure-Python workers, 2.4 s
of sequential work:

| | speedup |
|---|---|
| 3.13 threads (GIL) | 0.9x |
| 3.13 processes | 5.5x |
| 3.14t threads | 5.6x |

Processes on a GIL build match the free-threaded interpreter. The remaining gap to 8x
is process startup, pickling each item, and the parent's own threads.

## Threads

Every node is a thread waiting on one inbox. Channels are bounded (default 1024 items)
and carry batches (default 32 items per hand-off, flushed after one millisecond or when
the producer would block), which removes most lock traffic. On the free-threaded
interpreter this runtime scales like the Java original; on a GIL build it parallelizes
only work that releases the GIL.

## Processes

`runtime="processes"` puts every farm worker in its own spawned child; `tq.farm(...,
runtime="processes")` does it for one farm. In the parent the worker keeps its inbox,
outbox and edges as a proxy; in the child it runs unchanged, so tags, ordered and
gather collection, on-demand scheduling and feedback loops all work. A completion
marker per item keeps credits exact across the pipe. A crashed child is `WorkerDied`;
an exception is the same `NodeError`. Send rows, chunks or arrays rather than scalars.

## Async nodes

An `async def` node runs on an event loop; `tq.farm(coro, workers=N)` runs N coroutines
at a time on one thread. Coroutines take the item only (no `ctx`) and return or yield
what to send; `ordered=True` keeps input order; async classes may have async
`on_start` and `on_end`. Other emitter and collector policies do not apply to a pool.

## Distributed

A deploy file cuts the graph into named groups with an endpoint each. Every host runs
the same flow with its group name. Edges between groups become TCP channels: numbered
batches, acknowledgements that return the producer's credits, resend after a dropped
connection, an optional shared secret. A failing group tells its peers (`PeerFailed`);
an unreachable one is `PeerLost`. Loops and an ordered farm's ends stay in one group.

## Sync

One node runs at a time and hands over when it blocks, in graph order. The same graph
gives the same interleaving every run, a deadlock is detected the instant it happens,
and a debugger steps through it. Process placement is ignored, so a process flow can be
debugged here first.
