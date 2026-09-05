"""Generate 100 seeded random temperatures and print each reading with its 5-reading moving average."""

import random
from collections import deque

import tolquane as tq

SEED = 42
COUNT = 100
WINDOW = 5


@tq.source
def readings():
    # Fixed seed so the run is reproducible; its own generator, no state elsewhere.
    rng = random.Random(SEED)
    for _ in range(COUNT):
        yield round(rng.uniform(10.0, 30.0), 2)


class MovingAverage:
    # Stateful and order-sensitive, so it is a class on a single node (no farm):
    # it holds the last WINDOW readings and emits nothing until the window is full.
    def __init__(self) -> None:
        self.window: deque[float] = deque(maxlen=WINDOW)

    def __call__(self, value: float) -> object:
        self.window.append(value)
        if len(self.window) < WINDOW:
            return tq.SKIP  # window not full yet
        return (value, sum(self.window) / WINDOW)


@tq.sink
def show(pair: tuple[float, float]) -> None:
    value, avg = pair
    print(f"{value:6.2f}  avg{WINDOW}={avg:6.2f}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else readings
    return start >> MovingAverage >> show


def main() -> None:
    # Threads: one stage is inherently sequential, so a single worker each.
    print(tq.run(build()))


if __name__ == "__main__":
    main()
