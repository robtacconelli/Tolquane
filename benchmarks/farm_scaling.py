"""Farm scalability: CPU-bound workers, 1..W workers (thesis Figure 13).

    python benchmarks/farm_scaling.py [items] [max_workers] [work_per_item]

On a GIL build only the free-threaded interpreter (3.14t) shows real speedup for pure
Python work; run it with both to see the difference.
"""

import sys
import time

import tolquane as tq


def work(x: int, iterations: int) -> int:
    y = x
    for _ in range(iterations):
        y = y * 1000 // 999
    return y


def main() -> None:
    items = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    max_workers = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    iterations = int(sys.argv[3]) if len(sys.argv) > 3 else 20_000

    t0 = time.perf_counter()
    for i in range(items):
        work(i, iterations)
    t_seq = time.perf_counter() - t0
    print(f"sequential: {t_seq:.2f}s")

    w = 1
    while w <= max_workers:
        out = tq.to_list()
        t0 = time.perf_counter()
        tq.run(tq.from_iterable(range(items)) >> tq.farm(lambda x: work(x, iterations), w) >> out)
        dt = time.perf_counter() - t0
        speedup = t_seq / dt
        print(f"workers={w:3d}: {dt:.2f}s  speedup {speedup:.2f}  efficiency {speedup / w:.2f}")
        w *= 2


if __name__ == "__main__":
    main()
