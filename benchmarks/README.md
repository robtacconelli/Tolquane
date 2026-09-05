# Benchmarks

Two scripts reproduce the shapes measured in the BBFlow thesis so the numbers can be
compared as the runtime evolves.

| Script | Thesis reference | What it measures |
|---|---|---|
| `pipeline2.py N [runtime] [capacity]` | Table 1, Figures 10 and 11 | Per-item channel overhead: producer to consumer, N items |
| `farm_scaling.py [items] [max_workers] [work]` | Figures 13 to 15 | Speedup and efficiency of a farm of CPU-bound workers |

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
