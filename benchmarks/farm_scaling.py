"""Farm scalability: CPU-bound workers, 1..W workers (thesis Figure 13).

    python benchmarks/farm_scaling.py [items] [max_workers] [work_per_item] [threads|processes]

On a GIL build only the processes runtime (or the free-threaded interpreter) shows
real speedup for pure Python work; run both to see the difference.
"""

import sys
import time

import tolquane as tq

ITERATIONS = 20_000


def work(x: int) -> int:
    y = x
    for _ in range(ITERATIONS):
        y = y * 1000 // 999
    return y


def main() -> None:
    global ITERATIONS
    items = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    max_workers = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    ITERATIONS = int(sys.argv[3]) if len(sys.argv) > 3 else 20_000
    runtime = sys.argv[4] if len(sys.argv) > 4 else "threads"

    t0 = time.perf_counter()
    for i in range(items):
        work(i)
    t_seq = time.perf_counter() - t0
    print(f"sequential: {t_seq:.2f}s   ({runtime} runtime below)")

    w = 1
    while w <= max_workers:
        out = tq.to_list()
        t0 = time.perf_counter()
        tq.run(tq.from_iterable(range(items)) >> tq.farm(work, w) >> out, runtime=runtime)
        dt = time.perf_counter() - t0
        speedup = t_seq / dt
        print(f"workers={w:3d}: {dt:.2f}s  speedup {speedup:.2f}  efficiency {speedup / w:.2f}")
        w *= 2


if __name__ == "__main__":
    main()
