# Tolquane design: rebuilding BBFlow in Python

Status: draft 1, 2026-09-05. Companion to `PREV_CLAUDE.md` (naming decision).
Decisions 1 to 5 in section 11 are settled; the liveness rules in section 6 are
the contract every phase must keep.
Sources studied: https://github.com/robtacconelli/BBFlow (Java 17, ~2.9k lines of
library code, last commit May 2022) and the thesis *BBFlow: a Java implementation of
FastFlow building blocks* (88 pages, May 2022, copy in `reference/`).

---

## 1. What BBFlow is, as built

### 1.1 The vocabulary

| BBFlow class | Role |
|---|---|
| `block<T,U>` | Abstract building block: `addInputChannel`, `addOutputChannel`, `start`, `join`. |
| `ff_node` | One Java `Thread` running one `defaultJob`. Every other block is built from these. |
| `defaultJob<T,U>` | User code plus runtime support. Holds `in`/`out` lists of channels. Hooks `init()` and `EOS()`. Helpers `sendOut` (round robin), `sendOutTo(i)`, `sendOutToAll`, `sendEOS`. Fields `id`, `position` (index of the input the current item came from). |
| `ff_comb` | Fuses two nodes into one thread. Result is always multi-input/multi-output. |
| `ff_farm` | Emitter + N workers + collector. Emitter policies ROUNDROBIN, SCATTER, BROADCAST. Collector policies FIRSTCOME, ROUNDROBIN, GATHER. Emitter/collector are public fields; `removeEmitter()`, `connectEmitterWorkers()` etc. rewire by hand. |
| `ff_pipeline` | Chain of blocks. Topologies 1-1, 1xN, Nx1, N-N, NxM, resolved by `instanceof` dispatch in `pipeline_generic`. |
| `ff_all2all` | `combine_farm(left, right, R, G, merge)`: the eight farm-fusion cases from the FastFlow docs. |
| `ff_queue<T>` | SPSC FIFO channel. Blocking/non-blocking x bounded/unbounded on `LinkedBlockingQueue`, `ConcurrentLinkedQueue`, `squeue`. EOS is a boolean flag on the queue; `take()` returns `null` once EOS is set and the queue is empty. Non-blocking waits spin with a 1 us backoff. |
| `ff_queue_TCP` | INPUT side: server thread + `ObjectInputStream` feeding a local queue. OUTPUT side: client with buffered `ObjectOutputStream` flushed every 1 ms. Port = `serverPort + channel id`. Reconnects forever. EOS is the string `"EOS"`. |
| `bb_settings` | Global static config: BLOCKING, BOUNDED, defaultBufferSize, backOff, serverPort, bufferedTCP. |
| `preloader`, `customWatch` | JVM warm-up, stopwatch. |

### 1.2 How a node runs

`defaultJob.run()` calls `init()`, then loops in one of three modes chosen at
construction time by reflection:

1. **CUSTOM**: user overrides `runJob()`; the body is called in a loop and the user
   reads channels, writes channels and handles EOS by hand.
2. **INLINE** (anonymous class overriding `U runJob(T)`): single input, single output.
   Return value is sent; `null` means "send nothing".
3. **INLINE_MULTI** (anonymous class overriding `runJobMulti(T, out)`): inputs are
   scanned round robin; user sends explicitly.

When all inputs have delivered EOS, `EOS()` is called and EOS is set on every output.
EOS is always broadcast to all outputs so the whole graph drains.

### 1.3 What the thesis measured, and what to carry over

- Buffering the TCP channel and flushing every 1 ms made network channels 4 to 5 times
  faster. With that, BBFlow's TCP pipeline beat Distributed FastFlow by about 3x
  beyond 100K items. Lesson: **batch by default on every expensive channel**.
- Farm and pipeline reached about 100x speedup on 123 workers (efficiency 0.81) on a
  128-thread box. The block model itself scales; the overhead is per-item cost.
- Working on boxed `Long` instead of primitive `long` cost 40% in tight loops.
  Lesson: **the framework must not force per-item object churn**; arrays and batches
  must flow through untouched.
- LinkedList-based queues degrade once the consumer lags (queue depth > 1K).
  Lesson: **ring buffers, bounded by default**.
- FIRSTCOME collection is a 50 ms poll loop over inputs; the SOM use case had to
  hand-pick which channels to listen on to stay efficient. Lesson: **a multi-input
  node needs one wait primitive, not a scan**.
- Ordered farm and feedback channels were manual and listed as future work.

### 1.4 What is wrong with it (the "way better" list)

| # | Problem in BBFlow | Fix in Tolquane |
|---|---|---|
| 1 | Global mutable settings (`bb_settings` statics). | Options passed to `run()` or per channel; no globals. |
| 2 | Three overlapping ways to write a job, chosen by reflection on anonymous classes. | One way: a plain function or callable. Cardinality is inferred from the graph, not the class. |
| 3 | Workers cloned from one job via Java serialization (`uniqueJob`). | Pass a class or factory; it is instantiated once per worker. |
| 4 | Public mutable fields plus `removeEmitter()` / `connectEmitterWorkers()` index juggling (`removeInputChannel(0)`). | Immutable graph description; wiring is done by the runtime at `run()`. `farm(..., emitter=f, collector=g)` replaces the dance. |
| 5 | EOS as `null` sentinel and a flag on the queue; `poll` timeouts also return `null`; a forgotten `return` silently drops items. | EOS is a message in the channel; `None` is a legal item; `tq.SKIP` is the only way to drop. |
| 6 | Multi-input wait = round-robin scan with 50 ms polls; non-blocking = spin with sleep/yield. | Per-node inbox: all inputs feed one queue, node blocks on one condition variable. Policies (round robin, first come, ordered) are applied on top. |
| 7 | Network channel: port = base + id, manual id coordination on both ends, Java serialization (unsafe, Java-only), reconnect via `sleep(100)` loop, `"EOS"` string sentinel. | One listening port per process; channels multiplexed by name; length-prefixed frames; pluggable serializer (pickle p5 / msgpack); HMAC handshake; EOS is a control frame. Edges crossing hosts become TCP automatically from a deploy file. |
| 8 | Exceptions are `printStackTrace()`d and swallowed; a crashed worker hangs `join()` forever. | Any exception cancels the graph and re-raises in `run()` as an `ExceptionGroup` with node names. |
| 9 | No feedback channels, no ordered farm, no on-demand scheduling. | Built in: `ordered=True`, `feedback=`, emitter policy `on_demand`, `key=`. |
| 10 | `ff_comb` implemented through `combined`/`combined_side` back-pointers. | `comb(a, b)` composes two callables into one; no back-pointers. |
| 11 | Pipeline wiring is `instanceof` chains that mutate other nodes' channel lists. | Graph is a small typed data structure (nodes, ports, edges); wiring is a pure function of it. |
| 12 | Tests are `main()` programs printing to stdout; no packaging (`javac tests/*.java`). | `pip install tolquane`, pytest suite, CI matrix, benchmark script that reproduces the thesis tables. |
| 13 | Docs are a thesis PDF and javadoc. | mkdocs site: 5-minute tutorial, cookbook, "coming from FastFlow/BBFlow" page. |
| 14 | Hard to debug: everything is always multithreaded. | `runtime="sync"` runs the whole graph deterministically in the calling thread. |
| 15 | `LICENSE` file is GPLv3 but README badge says LGPL. | Clean-room rewrite; pick one license deliberately (see section 9). |

---

## 2. Goals for Tolquane

1. **Same vocabulary as FastFlow/BBFlow.** Node, combine, pipeline, farm, all-to-all,
   channels, emitter, collector. Thesis knowledge and FastFlow papers transfer directly.
2. **A function is a node.** Hello world is three lines. No base classes required.
3. **One graph, several runtimes.** Threads, processes, asyncio, TCP across machines,
   and a deterministic sync runtime for tests. The graph description never changes.
4. **Fail loudly.** No hangs, no swallowed exceptions.
5. **Zero required dependencies.** Pure Python, optional extras for msgpack, numpy,
   cloudpickle.
6. **Typed, tested, documented, benchmarked.** `py.typed`, generics `Node[In, Out]`,
   pytest, CI on 3.11 to 3.14 plus the free-threaded 3.14t build.

Non-goals for 1.0: GPU, cluster schedulers (Kubernetes, Slurm integration), exactly-once
delivery, persistence, dynamic graph rewriting at runtime.

---

## 3. The Python reality check

BBFlow is one thread per node. In CPython with the GIL, that gives parallel speedup only
when the work releases the GIL (numpy, I/O, C extensions). Tolquane must be honest
about this and make the runtime a one-word switch.

| Runtime | Node runs as | Channel | Use when |
|---|---|---|---|
| `sync` | Function calls in the caller's thread, lock-step scheduler | Python `deque` | Tests, debugging, tiny graphs. Deterministic. |
| `threads` (default) | One `threading.Thread` per node | `deque` + `Condition`, bounded | I/O-bound stages, numpy/C work, and **full parallelism on free-threaded CPython 3.14t**. Same model as BBFlow. |
| `processes` | Farm workers in child processes (spawned), everything else as threads in the parent; `tq.farm(..., runtime="processes")` for one farm | pickle protocol 5 over a `multiprocessing` pipe, batched; a completion marker per item keeps credits and loop tokens exact; shared-memory ring for fixed-size records later | CPU-bound pure Python on a GIL build. |
| async nodes | `async def` nodes run on an event loop inside the threads runtime; `tq.farm(coro, workers=N)` is one pool node running N coroutines at a time | The node's own inbox and outbox; the pool feeds and drains the loop | Network-heavy stages: hundreds of requests in flight on one thread. |
| `tcp` (distributed) | Any of the above per host; cross-host edges become TCP channels | Length-prefixed frames, batched, reconnecting | Two or more machines. |
| `interpreters` (experimental, later) | One subinterpreter per node (PEP 734, Python 3.14) | Interpreter channels | GIL-per-interpreter parallelism without process overhead. |

Free-threaded CPython became officially supported in 3.14 (PEP 779). Tolquane's thread
runtime is the natural fit for it, so the BBFlow benchmarks (farm scalability up to 128
workers) become a real target again, not just a Java memory.

The other lever is **batching**. A Python queue put/get pair costs a few microseconds,
so per-item channel traffic dominates any cheap stage. Channels carry batches
transparently (`batch=64` items or a time limit, flushed when the producer idles);
user code always sees single items. This is the in-process version of the 1 ms TCP
flush the thesis found so effective.

---

## 4. The user-facing API

### 4.1 Hello world

```python
import tolquane as tq

@tq.source
def numbers():
    yield from range(1, 101)          # a source is a generator

@tq.node
def double(x: int) -> int:
    return x * 2                       # return value is sent downstream

@tq.sink
def show(x: int) -> None:
    print(x)

graph = numbers >> tq.farm(double, workers=4) >> show
tq.run(graph)                          # threads by default
tq.run(graph, runtime="processes")     # same graph, multiprocess
```

`>>` builds a pipeline. Plain `tq.pipeline(a, b, c)` does the same without operators.

### 4.2 Node forms

| You write | Tolquane treats it as |
|---|---|
| `def f(x) -> y` | Stateless map node. The return value is always sent, `None` included. Return `tq.SKIP` to send nothing. A returned list is one item, never unpacked. |
| `def f(x): yield ...` (generator function) | Zero-or-many node (flat map). Each yielded value is sent; yielding nothing drops the item. |
| `def f(x, ctx)` | Node with explicit sends: `ctx.send(y)`, `ctx.send(y, to=i)`, `ctx.broadcast(y)`, `ctx.stop()`. `ctx.source` tells which input the item came from (BBFlow's `position`), `ctx.index` is the worker id (BBFlow's `id`). |
| A class with `__call__` | Stateful node; one instance per worker. Optional `on_start(ctx)` and `on_end(ctx)` map to BBFlow's `init()` and `EOS()`. |
| `def f(ctx)` decorated with `@tq.raw` | Full control: `for src, item in ctx.inputs(): ...` and manual sends. BBFlow's CUSTOM mode, without the hazards. |
| A no-argument generator function | Source. `@tq.sink` marks a node that must have no outputs; both are checked at build time. |
| `async def` | A coroutine pool: takes the item only, returns or yields what to send. A farm of one coroutine is one pool node with `workers` in flight; `ordered=True` keeps input order. Async classes may have async hooks. |

### 4.3 Blocks

```python
tq.farm(work, workers=8,
        emit="round_robin",      # or "broadcast", "scatter", "on_demand", key=lambda x: x.id
        collect="first_come",    # or "round_robin", "gather"
        ordered=False,           # True = built-in ordered farm (sequence tags)
        emitter=None,            # custom emitter callable replaces the default
        collector=None)          # custom collector callable replaces the default

tq.comb(a, b)                    # fuse two nodes into one thread (BBFlow ff_comb)
tq.pipeline(a, b, c)             # or a >> b >> c
tq.all2all(left_farm, right_farm, R=None, G=None, merge=False)   # the eight FastFlow cases
tq.feedback(farm, from_=collector, to=emitter)                    # loop edge, explicit
tq.farm(a >> b, 4)               # any block as a worker (1.1): pipeline, farm, feedback, all2all
tq.optimize(block)               # fewer threads (1.1): fused ends, dropped collectors, normal form
```

Scatter/gather expect sequences; numpy arrays are split with views, no copies.

A block used as a worker is copied per worker under the name `<farm>.<i>.<node>`, must
have one input and at most one output, and its plain stages count as the farm's workers
for the processes runtime and for deploy files. Ordered and gather farms keep plain node
workers, since their tags travel through one worker node. `optimize()` rewrites the
block tree, never the expanded graph, with FastFlow's `optimize_static` rules: fuse the
stage before a farm into its emitter, drop a default collector when the next stage reads
the workers first come, fuse the next stage into an ordered farm's collector, flatten a
farm of farms, and, opt-in, join two farms into an all-to-all. It never touches raw
nodes, sources, coroutine pools, or the ends a feedback loop wires back.

### 4.4 Running, results, errors

```python
report = tq.run(graph, runtime="threads", stats=True)
report.items_per_second["double"]
report.queue_high_water[("numbers", "double")]

with tq.session(graph) as s:      # long-lived graph: push items, pull results
    s.put(42)
    print(s.get())
```

An exception in any node cancels the graph and `run()` raises an `ExceptionGroup`
whose sub-exceptions carry the node name and worker index.

### 4.5 Introspection

```python
tq.check(graph)         # validate wiring without running; raises GraphError with a fix
tq.draw(graph)          # Mermaid text of the wired graph (cardinalities resolved)
tq.explain(graph)       # which topology rule applied to each edge: 1-1, 1xN, Nx1, N-N, NxM
```

Test helpers: `tq.from_iterable(items)` is a source, `tq.to_list()` a sink whose
`.items` holds what arrived. Decorated functions stay callable, so `double(3)` still
returns 6 in a unit test.

### 4.6 Distributed

```toml
# deploy.toml
[groups.G1]
endpoint = "10.0.0.1:7000"
nodes = ["numbers", "double"]      # farm name covers emitter, workers, collector

[groups.G2]
endpoint = "10.0.0.2:7000"
nodes = ["show"]
```

```
host1$ tolquane run app.py --deploy deploy.toml --group G1
host2$ tolquane run app.py --deploy deploy.toml --group G2
```

Edges that cross a group boundary become TCP channels. Nothing changes in `app.py`.
This is the FastFlow `dff` groups model that BBFlow's `benchmark_network.json` already
sketched.

---

## 5. Architecture

### 5.1 Package layout

```
tolquane/
  __init__.py          public API: node, source, sink, raw, SKIP, farm, comb, pipeline,
                       all2all, feedback, run, session, draw, explain, EOS, Context
  core/
    graph.py           Graph, NodeSpec, Port, Edge; validation; topology resolution
    node.py            Node runner loop, Context, EOS handling, lifecycle hooks
    channel.py         Channel protocol, Inbox, batching wrapper
    policies.py        emit: RoundRobin, Broadcast, Scatter, OnDemand, KeyHash
                       collect: FirstCome, RoundRobin, Gather, Ordered
    farm.py  comb.py  pipeline.py  all2all.py
  runtimes/
    base.py            Runtime protocol: build channels, spawn nodes, join, cancel
    sync.py  threads.py  processes.py  asyncio_.py
  net/
    framing.py         length-prefixed frames, control frames (HELLO, EOS, PING)
    serializers.py     pickle5 (default), msgpack, json; out-of-band buffers for numpy
    channel.py         TcpChannel (client side sends, server side owns the inbox)
    deploy.py          deploy.toml parsing, group assignment, edge cutting
    launcher.py        `tolquane run` for one group
  observe/
    stats.py           per-node and per-edge counters, report object
    trace.py           optional Perfetto/Chrome-trace export
    diagram.py         Mermaid rendering
  cli.py               tolquane run | draw | bench
```

### 5.2 Core abstractions

**Graph** is data. `NodeSpec(name, callable, kind, n_in, n_out, options)`,
`Edge(src_port, dst_port, channel_options)`. Building blocks are functions that return
subgraphs; `>>` concatenates. Nothing runs until `run()`. Validation happens at build
time: unconnected required ports, type hints that disagree across an edge (warning),
async nodes with a `ctx` parameter, in `comb()`, or in a farm with any policy but the
default.

**Channel** is a protocol with `put(item)`, `put_many(batch)`, `close()`, and a
`Subscriber` that the inbox registers. Implementations differ per runtime. A channel is
SPSC, as in BBFlow, but the consumer side always goes through an **Inbox**.

**Inbox** is the one queue a node waits on. Every input channel delivers
`(source_index, item)` into it. This removes BBFlow's round-robin scanning and 50 ms
polls: a multi-input node blocks once and wakes on any input. Collector policies are
Inbox strategies: `first_come` is the raw inbox order; `round_robin` re-orders by
source index; `ordered` re-orders by sequence tag. Bounded per-source credits keep one
fast producer from starving the others.

Credits come back at delivery, not at pop. An item a strategy pops but holds back
(a `round_robin` collector waiting for another source, a raw node doing
`recv(source=1)` while source 0 keeps arriving) keeps its producer's credit, so a
held-back source blocks after `capacity` items instead of growing a buffer without
bound. The price is that a node which refuses to read one source while the emitter
must feed it can deadlock; that is a real cycle in the user's topology, and the stall
detector reports it by name (`tests/liveness/` has the case). Ordered and gather
collectors release at pop, because their window already bounds what they hold.

Batching keeps that rule. A channel entry may carry up to `batch` items; a batch takes
its credits when it is pushed and gives them back one by one as items are delivered,
or all at once when the fast path hands a whole batch to a node that holds nothing
back. A partial batch is sent when it is full, when one millisecond has passed since
the last flush, or before the producer blocks on anything (input, output credit, an
ordered window). The sync runtime never uses the clock, so its interleaving stays
deterministic. Raw nodes that block outside Tolquane call `ctx.flush()` first.

**Node runner** is the loop: `on_start`, then consume the inbox until every source has
delivered EOS, then `on_end`, then close all outputs. EOS is a distinct object, never
`None`. The same loop serves every runtime; runtimes only supply channels and a way to
spawn.

**Runtime** builds channels for each edge, spawns each node, joins, and cancels on
error. It is the only layer that knows about threads, processes or sockets.

### 5.3 Termination and feedback

Acyclic graphs terminate the BBFlow way: EOS propagates forward, every node drains and
closes. Feedback edges create cycles, so EOS cannot flow naturally. Tolquane offers
two mechanisms, both explicit: `ctx.stop()` from the node that owns the loop (usually
the emitter), and an in-flight counter on the loop that closes it when the external
input has ended and no item is circulating. The second is the FastFlow farm-with-feedback
rule and is the default for `tq.feedback` on a farm.

### 5.4 Farm details

- Workers are instantiated from a class or factory once each; stateless functions are
  shared. No serialization cloning.
- `on_demand` emit: each worker has a credit of one (or `prefetch=k`) item; the emitter
  sends to whoever has credit. This is the FastFlow scheduling BBFlow lacked and it
  beats round robin whenever item costs vary.
- `key=` emit: consistent hashing of a key to a worker, so items with the same key
  land on the same worker (stateful per-key processing).
- `ordered=True`: emitter tags items with a sequence number, collector releases in
  order with a bounded reorder buffer. The thesis's `ordered_farm_labeling` example
  becomes one keyword.
- Custom emitter/collector: any node callable with the right cardinality; the farm
  wires it. No `removeEmitter()`.

### 5.5 All-to-all

`all2all(left, right, R=None, G=None, merge=False)` reproduces the eight cases of the
thesis (section 3, "ff_all2all") as a pure graph transformation: it returns a new
subgraph and never mutates `left` or `right`. `tq.explain` prints which case fired.

### 5.6 Network channel

- One listening socket per group; a HELLO frame names the channel, so many channels
  share one port. No port arithmetic.
- Frames: 4-byte length + 1-byte kind + payload. Kinds: DATA (a batch), EOS, PING.
- Serializer per channel: pickle protocol 5 by default (fast, arbitrary objects,
  out-of-band buffers for numpy and bytes). msgpack for cross-language or when
  peers are not fully trusted. pickle is documented as trusted-network only.
- Handshake with a shared secret (HMAC challenge, like `multiprocessing.connection`).
  Optional TLS via `ssl` context in the deploy file.
- Sender batches by count or time (default 1 ms, the thesis's number) and flushes on
  idle and on EOS. Receiver unpacks into the inbox.
- Reconnect with exponential backoff; the sender buffers while disconnected up to a
  bound, then applies backpressure. At-least-once within a connection; no cross-restart
  guarantees (non-goal).

### 5.7 Observability

Every node counts items in/out, busy time and wait time; every edge tracks depth
high-water and blocked-put time. `stats=True` returns a report; `tq.draw` can annotate
the diagram with throughput. `trace=True` writes a Chrome trace file to open in Perfetto.
This replaces `customWatch` and answers the thesis's "where is the bottleneck"
questions directly.

---

## 6. Liveness: how Tolquane avoids the BBFlow hangs

BBFlow's structure allows deadlocks, silent drops and stalls that look like deadlocks.
Appendix A lists twenty concrete cases found in the code. The rules below are the
contract that closes them; each rule names the appendix items it covers and is
enforced by a test with a timeout in `tests/liveness/`.

**R1. EOS is a message, not a flag.** `close()` enqueues a sentinel after the last
item, so consumers see it in order after all data. `put()` after `close()` raises
`ChannelClosed`. No visibility race, no silent post-EOS drops. (A1, A2)

**R2. Every node waits on exactly one thing: its inbox.** All inputs deliver into it,
so a node never blocks on one empty input while another is full. Policies that need a
specific source next (`round_robin`, `ordered`) take from the inbox into a bounded
reorder buffer instead of blocking the inbox. (A4, A20)

**R3. Bounded everywhere, explicit otherwise.** Every edge has a capacity (default
1024 items). Unbounded requires writing `capacity=None`. Backpressure is the only
flow control, so memory never grows silently. (A13, A18)

**R4. Nothing is timed-polled.** All waits are condition variables or events with a
cancellation token. No 50 ms polls, no sleep/yield spinning. Idle costs zero CPU and
wake-up latency is the only latency. (A10)

**R5. Closing is complete and happens once.** When a node finishes, for any reason
(all inputs ended, `ctx.stop()`, exception, cancellation), the runtime closes every
output port. `on_end` runs exactly once. User code cannot skip or duplicate it. (A3, A8)

**R6. Unconnected ports fail at build time.** An input nobody feeds, or an output
nobody reads on a node not marked `@tq.sink`, makes `run()` raise before any thread
starts. There are no dummy queues. (A5, A11)

**R7. Errors cancel, never hang.** An exception in any node sets the graph's cancel
token; every blocking wait checks it; all nodes unwind; `run()` re-raises an
`ExceptionGroup` naming the node and worker index. SIGINT does the same. Every join
has a timeout and a diagnostic. (A11, A17)

**R8. Stall detection is built in.** The runtime tracks each node's state: running,
waiting on inbox, blocked on edge, done. A watchdog raises `DeadlockError` naming the
wait cycle when every live node is blocked and no I/O is pending. Distributed runtimes
warn instead of raising, because a remote peer may just be slow. (A20)

**R9. Ordered and gather policies use tags, not counting.** Items entering a farm are
tagged with a sequence number; `SKIP` becomes a tombstone so sequences still advance;
a generator node produces `(seq, sub_seq, end)` markers. Gather and ordered collection
never wait for an item that will not come. (A9)

**R10. Feedback loops terminate by rule.** A loop carries an in-flight counter
(incremented when an item enters the loop, decremented when an item is consumed
without producing a successor). When the external input has ended and the counter is
zero, the loop closes. `ctx.stop()` is the explicit alternative. A loop that cannot
terminate is reported by R8, not by an infinite hang. (A19)

**R11. Composition is pure.** `farm`, `comb`, `pipeline`, `all2all` and `feedback`
return new graph values and never mutate their arguments. Ports are objects, never
positional indices, so "remove channel 0" bugs cannot exist. `comb` is function
composition over one node interface, with no mode branching. (A7, A12, A13)

**R12. Cardinality is declared or inferred, never guessed from a class.** A node's
kind comes from its signature (`f(x)`, `f(x, ctx)`, generator, `raw`), a source may have
no inputs, a sink no outputs, and a map node at the end of a pipeline is a build-time
error with a hint. Several inputs into a plain function merge first-come through the
inbox, which is well defined; nothing is silently ignored. No reflection on class
names, no busy loops on an empty default method. (A4, A6)

**R13. Network control is out of band.** HELLO, WELCOME, CHALLENGE, ACK, END and
ERROR are frame kinds, never payload values. Items travel in numbered batches; the
receiver acknowledges a batch once its node has it, and only then does the sender give
the producer's credits back, so the capacity window holds across the wire. After a
dropped connection the receiver states the position it expects and the sender resends
from there, so nothing is lost or duplicated within a run. `SO_REUSEADDR` is set. A
failed bind, a peer that never connects, or one that stays gone past the reconnect
budget surfaces as `PeerLost`; a peer that fails says why in an ERROR frame and the
others stop with `PeerFailed`. As built: one listening socket per group, one TCP
connection per cut edge, pickle protocol 5 frames, an HMAC challenge when a secret is
set. Loops and ordered farms' ends stay inside one group. (A14, A15, A16)

**R14. Processes always spawn.** Never fork with threads alive. Child death is detected
through the broken pipe and raised as `WorkerDied`; a child whose parent dies sees its
pipe close and exits; SIGINT is ignored in children and handled by the parent. Pipes,
not `multiprocessing.Queue`, so there is no feeder-thread join hang. As built: a remote
worker keeps its inbox, outbox and edges in the parent as a proxy whose two threads
forward across the pipe; in the child the worker runs unchanged between a pipe source
and a pipe sink, so tags, batching, hooks and policies apply as on threads. The child
sends a completion marker after each item, in order after its outputs, and only then
does the parent release the producer's credit and the loop token, so `capacity` and
`on_demand` mean the same across the pipe. The stall detector counts a proxy with
items in flight as running, so a slow child is never reported as a deadlock; a stalled
child is reported as the proxy waiting on it.

**R15. Work outside the channels counts as busy.** A pool's coroutines and a remote
worker's items are work no channel can see. Each node reports how much of it is in
flight (`in_flight`, changed only through the scheduler), and the deadlock detectors
wait for it: the thread watchdog treats such a node as running, and the sync
scheduler leaves the baton on the table until the thread that finishes the work hands
it back or, if nothing can run then, reports the deadlock itself. A pool node stays one
thread: the event loop posts results into the node's own inbox, so the node waits in one
place for either input or a result and its state is never shared between threads. The
sync scheduler parks a node on a private condition, never on a channel lock, so handing
the baton over never waits on a lock another node holds.

**R16. Every rule has a test.** `tests/liveness/` and `tests/test_async.py` run under a
pytest timeout and cover: put after close, multi-output close, gather with dropped
items, slow consumer under broadcast, feedback termination, cycle deadlock detection,
exception inside `on_end`, SIGINT during `run()`, child process crash, network peer
disappearing, a pool inside a jammed loop.

---

## 7. BBFlow to Tolquane mapping

<!-- --8<-- [start:mapping] -->

| BBFlow | Tolquane |
|---|---|
| `defaultJob` with `U runJob(T)` | `@tq.node def f(x)` |
| `return null` to drop | `return tq.SKIP` |
| `runJobMulti(T, out)` + `sendOutTo` | `def f(x, ctx)` + `ctx.send(y, to=i)` |
| `runJob()` manual loop | `@tq.raw def f(ctx)` with `ctx.inputs()` |
| `init()` / `EOS()` | `on_start(ctx)` / `on_end(ctx)` on a class node |
| `sendOut` / `sendOutToAll` / `sendEOS` | `ctx.send` / `ctx.broadcast` / `ctx.stop` |
| `position` / `id` | `ctx.source` / `ctx.index` |
| `ff_node(job)` | the function itself |
| `ff_comb(a, b)` | `tq.comb(a, b)` |
| `ff_farm(n, job, EMIT, COLLECT)` | `tq.farm(job, workers=n, emit=..., collect=...)` |
| `defaultJob.uniqueJob(job, i)` | pass a class; instances are made for you |
| `ff_pipeline(a, b)` + `appendBlock` | `a >> b >> c` |
| `TYPE_1_1 ... TYPE_NxM` | inferred; `tq.explain` shows which |
| `ff_all2all.combine_farm(...)` | `tq.all2all(...)` |
| `ff_queue(blocking, bounded, size)` | `tq.channel(capacity=..., batch=...)` on an edge; blocking always, bounded by default |
| `ff_queue_TCP(INPUT/OUTPUT, id, host)` | deploy file; edges become TCP automatically |
| `bb_settings.*` | `tq.run(..., options=tq.Options(...))` |
| `preloader` | not needed |
| `customWatch` | `stats=True` report, `trace=True` |
| manual feedback via `addInputChannel` | `tq.feedback(...)` |
| `ordered_farm_labeling` example | `ordered=True` |

<!-- --8<-- [end:mapping] -->

---

## 8. Roadmap

Each phase ends with tests green in CI and a runnable example. The AI builder sits
right after the core so that the API is shaped by what generated code needs.

**Phase 0: bootstrap (done 2026-09-05).**
`pyproject.toml` (hatchling), `src/tolquane`, ruff + mypy strict, pytest, GitHub
Actions matrix (3.11, 3.12, 3.13, 3.14, 3.14t), README with the hello world,
placeholder `tolquane 0.0.1` on PyPI (from the `PREV_CLAUDE.md` to-do list), license
decided.

**Phase 1: core on threads (0.1, done 2026-09-05).**
Graph, Channel, Inbox, node runner, EOS, `sync` and `threads` runtimes, `pipeline`,
`comb`, `farm` with round_robin/broadcast/scatter and first_come/round_robin/gather,
`ordered=True`, `on_demand`, error propagation, stall detector, `run()`, `draw()`.
The `tests/liveness/` suite from section 6 (in-process cases). Port these BBFlow
tests as pytest cases: `combine2`, `all2all3` (as a farm with router workers),
`ordered_farm_labeling`, `pipeline_farm_node`, `sumTest`. Benchmark script for the
two-node pipeline (thesis Table 1) and farm scalability (Figure 13).

**Phase 2: composition (0.2, done 2026-09-05).**
`all2all` with all eight cases, `feedback` with both termination rules, `key=` emit,
`session()` for long-lived graphs, batching on channels, `explain()`, stats report.
Port the remaining `ff_tests` and the SOM use case as an example (it exercises feedback,
custom emitter/collector and worker-to-worker edges).

**Phase 3: AI builder (0.3, done 2026-09-05).**
`tolquane[ai]` extra, `tolquane build` command and `tolquane.ai.build()`, Anthropic
provider first, OpenAI second, the four tools, the API card and `docs/style.md`, a
recorded-fixture test suite so the loop is tested without a key, and ten end-to-end
examples with their generated flows checked into `examples/generated/`.

**Phase 4: processes (0.4, done 2026-09-05).**
`processes` runtime with spawn, pickle protocol 5 channels, cloudpickle fallback for
lambdas, per-farm process pools, numpy zero-copy on scatter/gather. Benchmarks:
farm on a GIL build, pure Python CPU work, compared with threads on 3.14t.

**Phase 5: distributed (0.5, done 2026-09-05).**
Framing, serializers, HMAC handshake, `TcpChannel`, `deploy.toml`, `tolquane run`,
reconnect and backpressure. Reproduce thesis Tables 2 to 5 (pipeline and farm over
loopback and Ethernet).

**Phase 6: async nodes, docs, 1.0 (done 2026-09-05).**
`async def` nodes as coroutine pools on an event loop inside the threads runtime (a
separate asyncio runtime was not needed: a pool node gives network-bound stages the
concurrency, and every other node keeps its thread), Chrome trace export
(`tq.run(..., trace="trace.json")`), mkdocs site (tutorial, cookbook, "coming from
FastFlow/BBFlow", runtime decision table), API reference from docstrings, 1.0 built as
sdist and wheel. The subinterpreter runtime is left for a later release.

**1.1: the FastFlow review (done 2026-09-06).** `docs/decisions/0002-fastflow-review.md`
records what a reading of FastFlow's headers, tests and distributed layer showed was
missing. Taken: any block as a farm worker, the static optimizer, `tolquane launch`
(FastFlow's `dff_run`), busy and wait time per node in the report, eleven composition
tests ported. Deferred: divide and conquer, parallel-for helpers, per-input end hooks, a
byte cap on network batches, thread pinning, changing a farm's size while it runs, MPI.

---

## 9. The AI builder

Tolquane ships with a builder: a command and a library call that turns a plain-language
description into a runnable flow, tests it, and improves it with the user, using the
user's own Claude or GPT key. The target user has never read the FastFlow papers. The
output must be short, readable Python with a few blocks and comments, not a wall of
generated code.

### 9.1 What it does

```
$ tolquane build "read urls from urls.txt, fetch each with 8 workers, keep the ones
                  that return 200, write the titles to titles.csv"
```

1. **Plan.** The model reads the API card (section 9.3) and writes a short plan: which
   blocks, which runtime, what each node does.
2. **Write.** It emits one file, `flow.py`, in the house style: sources, nodes and sinks
   as small named functions, the graph as one `>>` line, a `main()` that calls `tq.run`.
   Every node carries a one-line comment saying what it does and why it is a node.
3. **Check.** `tq.check(graph)` validates wiring without running: unconnected ports,
   sources with inputs, sinks with outputs, bad cardinality. Errors go back to the model
   verbatim; they are written for this purpose (node name, what is wrong, how to fix it).
4. **Test.** The builder runs the flow on the `sync` runtime with a small sample
   (the first 20 items, a generated fixture, or a user-provided sample file) and shows
   the model the output, the stats report and any `NodeError`. Deadlocks surface as a
   `DeadlockError` naming the cycle, never as a hang, so the loop always terminates.
5. **Improve.** The user says what is wrong or what to add; the model edits the same
   file. `tq.explain` and `tq.draw` output are available to the model so it can reason
   about topology instead of guessing.

The same loop is available in Python (`tolquane.ai.build(description, ...)`) so people
can embed it in notebooks and internal tools.

### 9.2 Provider and model

- Claude through the official `anthropic` SDK, model `claude-opus-5` by default with
  adaptive thinking (the model's default) and `output_config.effort` set to `high`,
  streamed, with `fallbacks="default"` so a declined request is re-run on Anthropic's
  recommended fallback instead of failing. The key comes from the environment
  (`ANTHROPIC_API_KEY`) or an `ant auth login` profile; the builder never stores it.
- GPT through the official `openai` SDK's Responses API, `gpt-5.5` by default,
  selected with `--provider openai`.
- Both are optional extras: `pip install "tolquane[ai]"`. The core library never
  imports either SDK.
- One provider-neutral loop drives both: a provider turns a user message and tool
  results into the model's text plus tool calls, and the builder executes the four
  tools `write_flow`, `check_flow`, `run_flow`, `read_docs`. A recording provider
  writes every turn to JSON and a replay provider plays it back, so the loop is tested
  without a key; the tools still run for real during replay.
- As built, the plan is plain text in the model's first message rather than a
  structured-output block; the check and run tools make the plan verifiable anyway.

### 9.3 What the library must provide for the builder to be good

These are Phase 1 and 2 deliverables, because generated code is only as good as the
API it targets.

- **One way to do each thing.** A function is a node; `>>` is a pipeline; a farm is one
  call with keyword options. Fewer choices means fewer wrong choices.
- **An API card**, `docs/api-card.md`: the whole public surface on one page with one
  example per block, kept under 2K tokens, and shipped inside the package so the builder
  can read it at runtime. It doubles as the human cheat sheet.
- **Errors written for a reader with no context.** Every `GraphError` and `NodeError`
  names the node, states the problem in one sentence, and ends with a fix.
- **`tq.check`, `tq.explain`, `tq.draw`** as pure functions of the graph, callable
  without running anything.
- **The `sync` runtime**: deterministic, single-threaded, exact deadlock detection, so a
  test run costs nothing and cannot hang the builder.
- **`tq.to_list()` and `tq.from_iterable()`** so any flow can be tested with a sample in
  three lines.
- **A house style** documented in `docs/style.md` and followed by every example in the
  repository, because the model imitates what it reads.

### 9.4 Generated output, the standard to hit

```python
"""Fetch a list of URLs in parallel and save the page titles."""
import csv
import tolquane as tq
import urllib.request

@tq.source
def urls():
    # One URL per line; blank lines are skipped.
    with open("urls.txt") as f:
        yield from (line.strip() for line in f if line.strip())

@tq.node
def fetch(url: str):
    # Network-bound, so a farm of threads is the right runtime.
    with urllib.request.urlopen(url, timeout=10) as r:
        return (url, r.status, r.read().decode("utf-8", "replace"))

@tq.node
def keep_ok(page):
    url, status, body = page
    return page if status == 200 else tq.SKIP

@tq.sink
def write_title(page):
    url, _, body = page
    title = body.split("<title>")[1].split("</title>")[0] if "<title>" in body else ""
    writer.writerow([url, title])

def main():
    global writer
    with open("titles.csv", "w", newline="") as f:
        writer = csv.writer(f)
        tq.run(urls >> tq.farm(fetch, workers=8) >> keep_ok >> write_title)

if __name__ == "__main__":
    main()
```

Twenty lines of logic, every block visible, nothing to learn beyond `source`, `node`,
`sink`, `farm` and `>>`.

---

## 10. Definition of "easily usable by anyone"

- `pip install tolquane`, no compiler, no dependencies.
- The hello world in the README runs unchanged on threads, processes and two machines.
- Every error names the node and says what to do ("async node `fetch` takes (item,
  ctx); coroutines take the item only and return (or yield) what to send").
- `runtime="sync"` makes any graph steppable in a debugger.
- `tq.draw` shows what will be wired before anything runs.
- One page explains which runtime to pick and why, with the GIL stated plainly.
- The thesis benchmarks are a script in the repo, so claims are reproducible.

---

## 11. Decisions (recorded 2026-09-05)

| # | Decision | Choice | Note |
|---|---|---|---|
| 1 | License | **Apache-2.0** | BBFlow's `LICENSE` is GPLv3 while its README badge says LGPL. Tolquane is a clean-room rewrite and you hold BBFlow's copyright, so no conflict. |
| 2 | Minimum Python | **3.11** | `ExceptionGroup`, `TaskGroup`, `typing.Self`. Tested through 3.14 and 3.14t. |
| 3 | Operator syntax | **`>>`** for pipeline | `tq.pipeline(a, b, c)` always available for people who dislike operators. |
| 4 | Default collector | **`first_come`** | Best throughput. `collect="round_robin"` or `ordered=True` when order matters. |
| 5 | Dropping items | **explicit `tq.SKIP`**; `None` is a normal value; generator functions yield zero or many | See rationale below. |

**Why `tq.SKIP` and not "None drops".** Forgetting `return` is the most common silent
mistake in Python. Under BBFlow's rule that mistake drops every item and the
pipeline looks stuck with no error, which is exactly the class of failure this project
must eliminate. With `SKIP`, a forgotten `return` sends `None` downstream, the next
stage fails on it immediately, and the error names the node. Filters cost one explicit
token (`return tq.SKIP`), and `None` stays a first-class value that can travel through
channels and over the network. Generator functions cover "zero or many" without any
wrapper, so there is exactly one way to do each thing.

Still open: repository home (GitHub organization `tolquane` per `PREV_CLAUDE.md`, or
under your user with a rename later).

---

## Appendix A. Bugs and traps found in the BBFlow code

Each item is a failure the current Java code can produce, with the file and line in
the repository at commit `6675536`. They are listed here because each one becomes a
liveness rule in section 6 and a regression test in Phase 1.

| # | Where | What happens | Rule |
|---|---|---|---|
| A1 | `bbflow/ff_queue.java:15` | `boolean EOS` is not `volatile`; the non-blocking consumer loop reads it unsynchronized. The Java memory model allows the read to be hoisted, so a consumer may never observe EOS. | R1 |
| A2 | `bbflow/ff_queue.java:72` | `put()` returns silently once EOS is set. Any item sent after `sendEOS()` vanishes without error. | R1 |
| A3 | `bbflow/defaultJob.java:203-210` | INLINE mode sets EOS only on output 0. A `runJob(T)` node with N outputs (1xN topology) leaves outputs 1..N-1 open forever; downstream nodes hang. | R5 |
| A4 | `bbflow/defaultJob.java:202` | INLINE mode reads only input 0. Extra inputs are ignored; their producers block (bounded) or grow without limit (unbounded). | R2, R12 |
| A5 | `bbflow/defaultJob.java:186` | A node with no output channel gets an unbounded dummy queue that is filled and never read. Memory grows until the process dies, which looks like a stall. | R6 |
| A6 | `bbflow/ff_node.java:30` | Run mode is detected only for anonymous classes. A named subclass that overrides `runJob(T)` runs the empty `runJob()` in `while(true)`: 100% CPU, no item ever consumed. | R12 |
| A7 | `bbflow/ff_comb.java:48-59` | The combiner checks `node1.runType` twice where the second check must be `node2`; if the second node is multi-output its `runJobMulti` is never called and the item is dropped. Line 59 passes `null` as the outputs list. | R11 |
| A8 | `bbflow/ff_comb.java:76,115` | `node2.EOS()` can run twice (from `sendEOS(side)` and from the combined `EOS()`). | R5 |
| A9 | `bbflow/defaultCollector.java:106` | GATHER drops the partial vector when the last channel scanned returns EOS, and blocks forever if any worker filters an item (one-item-per-channel assumption). | R9 |
| A10 | `bbflow/defaultCollector.java:42` | FIRSTCOME is a 50 ms timed poll per input channel; idle latency and CPU scale with worker count. | R4 |
| A11 | `bbflow/ff_farm.java:105-116` | Workers are cloned by Java serialization; on failure the stack trace is printed and the farm is built with zero workers, which then drains into a dummy queue (A5). | R6, R7 |
| A12 | `bbflow/ff_farm.java:237,247` | `removeEmitter()`/`removeCollector()` remove channel index 0 of every worker, assuming the emitter/collector edge is first. A manually added channel (feedback) is removed instead. | R11 |
| A13 | `bbflow/pipeline_generic.java:158` | The NxM branch creates `new ff_queue<>()` ignoring the BLOCKING/BOUNDED arguments it was given. | R3, R11 |
| A14 | `bbflow_network/objectClient.java:68-69` | On `IOException` the client calls `start()` on an already started `Thread` (`IllegalThreadStateException`) and may dereference a null socket. Buffered but unflushed items are lost on reconnect, so "guaranteed to arrive" does not hold. `ObjectOutputStream` is never `reset()`, so it keeps a reference to every object written. | R13 |
| A15 | `bbflow/ff_queue_TCP.java:62`, `bbflow_network/objectServer.java:74` | End of stream is the in-band string `"EOS"`; a user sending that string ends the stream. | R13 |
| A16 | `bbflow_network/objectServer.java:104` | `ServerSocket` without `SO_REUSEADDR`; a restart inside TIME_WAIT fails, the server thread dies with a `RuntimeException`, and the input channel never opens. | R13 |
| A17 | `bbflow/ff_node.java:98` | `join()` swallows `InterruptedException`; there is no cancellation anywhere. Ctrl-C leaves non-daemon threads alive and the JVM never exits. | R7 |
| A18 | `bbflow/bb_settings.java:15` | `BOUNDED = false` by default: any producer/consumer speed mismatch grows memory without bound. | R3 |
| A19 | Feedback (thesis ch. 3) | Documented as "just remember to send EOS". There is no termination rule, so every loop needs hand-written protocol code, as in the SOM example. | R10 |
| A20 | Multi-input round-robin `take()` (`defaultJob.java`, `defaultCollector.java`) | A node blocks on one specific input while another input is full; with bounded queues and any cycle in the topology this is a deadlock. The SOM example works around it by hand-picking which channel to listen on. | R2, R8 |
