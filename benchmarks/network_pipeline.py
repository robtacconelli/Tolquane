"""Two nodes on two processes joined by a TCP channel over loopback (thesis Table 2).

    python benchmarks/network_pipeline.py [items] [batch]

Starts the two groups as subprocesses of this script and reports the receiver's time.
"""

import subprocess
import sys
import time

import tolquane as tq

PORTS = (7401, 7402)


def deployment() -> dict:  # type: ignore[type-arg]
    return {
        "groups": {
            "A": {"endpoint": f"127.0.0.1:{PORTS[0]}", "nodes": ["produce"]},
            "B": {"endpoint": f"127.0.0.1:{PORTS[1]}", "nodes": ["consume"]},
        },
        "options": {"connect_timeout": 30},
    }


class Consume:
    def __init__(self) -> None:
        self.total = 0

    def __call__(self, x: int) -> None:
        self.total += x * 2


def build(n: int) -> tq.Block:
    @tq.source
    def produce():  # type: ignore[no-untyped-def]
        yield from range(1, n + 1)

    return produce >> tq.sink(Consume, name="consume")


def main() -> None:
    if "--group" in sys.argv:
        n = int(sys.argv[1])
        batch = int(sys.argv[2])
        group = sys.argv[sys.argv.index("--group") + 1]
        t0 = time.perf_counter()
        report = tq.run(build(n), deploy=deployment(), group=group, batch=batch)
        dt = time.perf_counter() - t0
        got = report.nodes["consume"].items_in if group == "B" else n
        print(f"{group}: {got} items in {dt * 1000:.0f} ms ({got / dt / 1e6:.2f} M items/s)")
        return
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1_000_000
    batch = int(sys.argv[2]) if len(sys.argv) > 2 else 32
    procs = [
        subprocess.Popen([sys.executable, __file__, str(n), str(batch), "--group", g])
        for g in ("B", "A")
    ]
    for p in procs:
        p.wait()


if __name__ == "__main__":
    main()
