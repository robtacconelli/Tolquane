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
