"""Emitter and collector on one process, the workers on another, over loopback
(thesis Table 5).

    python benchmarks/network_farm.py [items] [workers] [batch]
"""

import subprocess
import sys
import time

import tolquane as tq

PORTS = (7403, 7404)


def deployment(workers: int) -> dict:  # type: ignore[type-arg]
    return {
        "groups": {
            "A": {
                "endpoint": f"127.0.0.1:{PORTS[0]}",
                "nodes": ["produce", "work.emitter", "work.collector", "consume"],
            },
            "B": {"endpoint": f"127.0.0.1:{PORTS[1]}", "nodes": ["work.[0-9]*"]},
        },
        "options": {"connect_timeout": 30},
    }


def add_index(x: int, ctx: tq.Context) -> None:
    ctx.send(x + ctx.index)


class Consume:
    def __init__(self) -> None:
        self.count = 0

    def __call__(self, x: int) -> None:
        self.count += 1


def build(n: int, workers: int) -> tq.Block:
    @tq.source
    def produce():  # type: ignore[no-untyped-def]
        yield from range(n)

    return produce >> tq.farm(add_index, workers, name="work") >> tq.sink(Consume, name="consume")


def main() -> None:
    if "--group" in sys.argv:
        n, workers, batch = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
        group = sys.argv[sys.argv.index("--group") + 1]
        t0 = time.perf_counter()
        report = tq.run(build(n, workers), deploy=deployment(workers), group=group, batch=batch)
        dt = time.perf_counter() - t0
        if group == "A":
            got = report.nodes["consume"].items_in
            rate = got / dt / 1e6
            print(
                f"farm x{workers} over TCP: {got} items in {dt * 1000:.0f} ms "
                f"({rate:.2f} M items/s)"
            )
        return
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300_000
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    batch = int(sys.argv[3]) if len(sys.argv) > 3 else 32
    procs = [
        subprocess.Popen([sys.executable, __file__, str(n), str(workers), str(batch), "--group", g])
        for g in ("B", "A")
    ]
    for p in procs:
        p.wait()


if __name__ == "__main__":
    main()
