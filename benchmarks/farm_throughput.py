"""Channel overhead through a farm: trivial workers, so hand-off cost is all there is.

    python benchmarks/farm_throughput.py [items] [workers] [batch]

Compare batch 1 with the default to see what batching buys on a multi-hop graph.
"""

import sys
import time

import tolquane as tq


def main() -> None:
    items = int(sys.argv[1]) if len(sys.argv) > 1 else 300_000
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    batches = [int(sys.argv[3])] if len(sys.argv) > 3 else [1, 32]
    for batch in batches:
        out = tq.to_list()
        t0 = time.perf_counter()
        tq.run(
            tq.from_iterable(range(items)) >> tq.farm(lambda x: x + 1, workers) >> out, batch=batch
        )
        dt = time.perf_counter() - t0
        rate = items / dt / 1e6
        print(
            f"farm x{workers}, {items} items, batch {batch}: "
            f"{dt * 1000:.0f} ms, {rate:.2f} M items/s"
        )


if __name__ == "__main__":
    main()
