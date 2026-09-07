# Backlog

Things decided worth doing and not done yet, so they are not forgotten. Each entry
says where the idea comes from and what the work is. Move an entry to `CHANGELOG.md`
when it ships; add a line here whenever a review or a phase defers something.

## From the FastFlow review (2026-09-06, `decisions/0002-fastflow-review.md`)

| Item | FastFlow source | The work |
|---|---|---|
| Divide and conquer pattern | `dc.hpp`, `tests/test_dc.cpp` | `tq.divide_and_conquer(divide, combine, base, is_base, workers)`: a farm with feedback whose collector counts pending subtasks per parent and combines when they are all back. Fibonacci and mergesort as tests. |
| Parallel-for, reduce and map helpers | `parallel_for.hpp`, `map.hpp` | `tq.map(fn, items, workers=8, ordered=True)` returning a list; `tq.parallel_for(n, body, workers, grain)`; `tq.parallel_reduce(...)`. Thin helpers over scatter and on-demand farms, for people who want a result, not a graph. A `session` keeps the threads between calls in a loop. |
| Per-input end hook | `ff_node::eosnotify(id)` | `on_input_end(self, ctx, source)` on class nodes, called when one input closes and allowed to send; today only raw nodes see it through `recv(source=i)` returning `None`. Joins emit partial results earlier. |
| Byte cap on network batches | `batchByteSize` in the DFF config | A size limit next to the item limit on TCP batches, per group in the deploy file, so big items do not build huge frames and small ones still batch. |
| Thread pinning | `ff_mapThreadToCpu`, `FF_MAPPING_STRING` | `tq.run(graph, pin="0,2,4")` or `pin=True` using `os.sched_setaffinity` for node threads and child processes on Linux. Benchmarks on 3.14t first, to see whether it pays. |
| Resize a farm while it runs | `run_then_freeze`, `thaw(nw)`, the manager channel | `session.set_workers(farm, n)`: the emitter stops feeding workers beyond `n`; they idle until raised again. Adaptivity and energy. |
| MPI transport | `ff_dsenderMPI`, MTCL | An `mpi4py` transport behind the same frames as TCP, launched through `mpirun` from the deploy file. Only if a cluster user asks. |
| Zero-copy check | June 2026 commit on owner-aware serialization | Confirm the pipe and TCP paths pass pickle protocol 5 out-of-band buffers for numpy arrays, and add a benchmark row. |

## From earlier phases

| Item | Where it came up | The work |
|---|---|---|
| Nested feedback loops | `Feedback.expand` refuses `feedback(feedback(...))` and a node in two loops | Loop tokens per loop with a stack of loop memberships; the head of an inner loop closes before the outer one can. |
| Subinterpreter runtime | DESIGN.md runtime table, Phase 6 | One subinterpreter per node (PEP 734, 3.14) behind `runtime="interpreters"`, channels through interpreter queues. |
| Farm of blocks with ordered or gather collection | 1.1 nested blocks | Tags would have to travel through every node of the copy; today ordered and gather farms keep plain node workers. |
| Distributed runtime on Windows | `tests/test_net.py` runs on loopback only | Verify sockets and the launcher on Windows and macOS; the CI matrix covers threads and processes there. |

## Tolquane Web

Deferred while the first release was built (`web.md`, "Later, not in the first
release", and the I3 hardening pass), and what 1.3 left for later.

| Item | Where it came up | The work |
|---|---|---|
| A workspace per user, and permissions per flow | `web.md`, one server one workspace; 1.3 U | Accounts with roles shipped in 1.3, but everybody who signs in shares the one workspace and may run anything in it, as the user who started the server. A workspace per user, or permissions per flow, is still a change of model rather than a setting. |
| HTTPS | I3 security review; 1.3 U | A `--tls-cert` and `--tls-key` pair, or a documented reverse proxy. Today a token on a shared machine travels in clear, and since 1.3 so do passwords and session tokens; the guide says to use an SSH tunnel instead. |
| Breakpoints that pause a node | `web.md` | Hold an item at a node until the user releases it, on the sync runtime first; needs a control channel into the run's child process, which the events stream does not have. |
| Deploy editor | `web.md` | Assign cards to groups on the canvas, write `deploy.toml`, launch every group with `tolquane launch` and watch them all in one page. |
| Gallery of templates | `web.md` | More than `empty` and `hello`: the examples, and the flows the AI builder wrote, offered as starting points from the New flow dialog. |
| Sharing a flow as a link | `web.md` | A read-only page for one flow and one run, addressable and safe to send; needs a signed link that carries its own token, or a read-only role beside admin and member. |
| Per-user rate limiting on the AI panel | I3 hardening | The chat spends the owner's key and has no limit of its own beyond the provider's; a request counter per hour would make an accident cheaper. |
| Events on disk for a long run | I3 hardening | Events are kept in memory and bounded (`MAX_EVENTS`), so a very long run loses its middle. Writing them to a file under `.tolquane-web/` would let the drawer scroll the whole run back. |
| Retries and notifications that survive a restart | 1.3 B3 | A pending retry is a `threading.Timer` and a delivery is a daemon thread, so a server that stops between two attempts drops the chain and a message in flight is lost. A queue in the store, drained at startup, would make both survive. |
| Notifications beyond a webhook and email | 1.3 B3 | Slack, Teams and the like go through the webhook today, in Tolquane's own JSON shape; per-target templates, or first-class integrations, if anybody asks. |

## Platforms

| Item | Where it came up | The work |
|---|---|---|
| Cancel on Windows | `tolquane run --events` and the run supervisor | Windows has no SIGTERM: a cancel kills the child, which ends as failed rather than cancelled. A control pipe or a file flag would let the child stop cleanly. |
