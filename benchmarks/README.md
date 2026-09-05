# Benchmarks

Two scripts reproduce the shapes measured in the BBFlow thesis so the numbers can be
compared as the runtime evolves.

| Script | Thesis reference | What it measures |
|---|---|---|
| `pipeline2.py N [runtime] [capacity]` | Table 1, Figures 10 and 11 | Per-item channel overhead: producer to consumer, N items |
| `farm_scaling.py [items] [max_workers] [work]` | Figures 13 to 15 | Speedup and efficiency of a farm of CPU-bound workers |
| `farm_throughput.py [items] [workers] [batch]` | Table 5 in spirit | Hand-off cost through emitter, workers and collector with trivial work |

## Baseline, 2026-09-05 (Phase 1, no batching yet)

Machine: 16 hardware threads, Linux. Interpreters installed with uv.

Two-node pipeline, 1,000,000 integers:

| Interpreter | Runtime | Time | Rate |
|---|---|---|---|
| 3.13 | threads | 2.40 s | 0.42 M items/s |
| 3.13 | sync | 2.52 s | 0.40 M items/s |
| 3.14t | threads | 3.06 s | 0.33 M items/s |
| 3.14t | sync | 4.35 s | 0.23 M items/s |

For scale, the thesis measured 159 ms for the same 1M items in BBFlow (Java, with
class preloading) and 76 ms in FastFlow (C++). Python's per-item cost is about 2.4 µs
here, almost all of it condition-variable traffic per item. Transparent batching on
channels (Phase 2) is the lever that changes this.

Farm of CPU-bound pure Python workers, 800 items, 20,000 loop iterations each:

| Interpreter | 1 worker | 2 | 4 | 8 |
|---|---|---|---|---|
| 3.13 (GIL) speedup | 0.97 | 0.97 | 0.89 | 0.90 |
| 3.14t (free-threaded) speedup | 0.96 | 1.79 | 2.95 | 4.52 |
| 3.14t efficiency | 0.96 | 0.90 | 0.74 | 0.57 |

The GIL build shows none, as it must for pure Python work; the free-threaded build
shows the farm scaling the way the thesis's Java farm did. The processes runtime
(Phase 4) is the answer on GIL builds.

## Phase 2, batching (2026-09-05)

Channels now carry up to `batch` items per hand-off (default 32), flushed when the
batch is full, after one millisecond, or before the producer blocks on anything.

Two-node pipeline, 1,000,000 integers, threads:

| Interpreter | batch 1 | batch 32 |
|---|---|---|
| 3.13 | 2.54 s | 2.10 s |
| 3.14t | 3.27 s | 2.32 s |

Farm of four trivial workers (emitter, workers, collector: three hops), 300,000 integers:

| Interpreter | batch 1 | batch 32 |
|---|---|---|
| 3.13 (GIL) | 3377 ms | 2788 ms |
| 3.14t | 3311 ms | 684 ms |

The two-node case is bounded by interpreter work in the producer and consumer loops
(about 2 µs per item: a dozen Python calls and attribute loads). Batching removes the
lock and condition traffic per item, which is why the three-hop farm gains 5x on the
free-threaded build while the pipeline gains 20%. On the GIL build the six threads of
the farm still serialize on the interpreter, so the gain is small; the processes
runtime (Phase 4) is the answer there, and for array work it is sending arrays, not
scalars.

Farm scaling (800 items of 20,000 loop iterations) on 3.14t with the default batch:
speedup 1.34, 2.86 and 3.88 with 2, 4 and 8 workers.
