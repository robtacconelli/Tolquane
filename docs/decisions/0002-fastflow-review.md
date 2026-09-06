# 0002: What Tolquane takes from FastFlow

**Date:** 2026-09-06. **Status:** adopted in 1.1.

FastFlow (github.com/fastflow/fastflow, commit d476f66 of June 2026, LGPL-3 or MIT) is the
C++ library whose building blocks BBFlow ported to Java and Tolquane rebuilt in Python. This
record is the result of reading its headers, tests and distributed layer against Tolquane
1.0, and what was decided.

## Already covered

Node kinds; multi-input and multi-output nodes; `comb`; farms with round-robin, on-demand,
ordered and custom scheduling; `ff_send_out_to` and broadcast (`ctx.send(to=)`,
`ctx.broadcast`); all-to-all; feedback and master-worker; the accelerator mode (`session`);
`GO_OUT` (`ctx.stop`); groups with a config file for the distributed runtime; batching and an
in-flight window over TCP; per-node statistics. Tolquane's bounded channels with loop tokens
and a deadlock report are a deliberate departure from FastFlow's unbounded queues, and stay.

## Adopted

| Feature | FastFlow source | Tolquane 1.1 |
|---|---|---|
| Any block as a farm worker or all-to-all set | `farm.hpp`, tests `farm+pipe`, `farm+farm`, `all-to-all17` | `tq.farm(a >> b, 4)`; copies named `farm.<i>.<node>` |
| Static optimizer | `optimize.hpp`, `OptLevel` | `tq.optimize(block)`, `tolquane optimize`, `run --optimize` |
| One-command distributed launch | `distributed/loader/dff_run.cpp` | `tolquane launch deploy.toml flow.py`; `ssh`, `python`, `workdir` in the deploy file |
| Busy and wait time per node | `TRACE_FASTFLOW`, `ffStats` | `Report` columns `busy`, `wait-in`, `wait-out`; `report.busiest()` |
| Composition tests | `tests/` | `tests/test_fastflow_ports.py`, eleven programs |

Ordered and gather farms keep plain node workers: their tags travel through one worker
node. A farm of blocks with `runtime="processes"` is refused; the inner farm takes it.

## Deferred

- Divide and conquer (`dc.hpp`) and parallel-for, reduce and map helpers: a farm with
  feedback plus a pending-subtask count, and thin helpers over scatter and on-demand
  farms. Next when someone needs them.
- A per-input end hook (`eosnotify`), a byte cap on network batches (`batchByteSize`),
  thread pinning (`ff_mapThreadToCpu`), changing a farm's worker count while it runs
  (`run_then_freeze`, `thaw(nw)`), an MPI transport.

## Skipped

- Macro dataflow, `taskf`, pool evolution, graph search: other programming models over
  the same farm; `concurrent.futures` covers task DAGs in Python.
- OpenCL, CUDA, TPC, energy statistics: non-goals for now.
- Non-blocking spin mode: pointless under the GIL, and the condition hand-off on the
  free-threaded interpreter is already in the low microseconds.
