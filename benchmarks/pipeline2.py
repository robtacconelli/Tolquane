"""Two-node pipeline: a producer streams N integers to a consumer (thesis Table 1).

python benchmarks/pipeline2.py 1000000 [threads|sync] [capacity]
"""

import sys
import time

import tolquane as tq


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1_000_000
    runtime = sys.argv[2] if len(sys.argv) > 2 else "threads"
    capacity = int(sys.argv[3]) if len(sys.argv) > 3 else 1024

    @tq.source
    def produce():  # type: ignore[no-untyped-def]
        yield from range(1, n + 1)

    class Consume:
        def __init__(self) -> None:
            self.total = 0

        def __call__(self, x: int) -> None:
            self.total += x * 2

    consume = tq.sink(Consume)
    t0 = time.perf_counter()
    report = tq.run(produce >> consume, runtime=runtime, capacity=capacity)
    dt = time.perf_counter() - t0
    rate = n / dt / 1e6
    print(f"{n} items, {runtime}, capacity {capacity}: {dt * 1000:.0f} ms, {rate:.2f} M items/s")
    print(report)


if __name__ == "__main__":
    main()
