"""Normalize each row of a fixed-seed 200x50 random matrix by its maximum, scattering
each row across four workers, and print the first three normalized rows."""

import random

import tolquane as tq

SEED = 12345
ROWS = 200
COLS = 50


@tq.source
def rows():
    # The matrix: 200 rows of 50 random floats, reproducible thanks to the fixed seed.
    rng = random.Random(SEED)
    for _ in range(ROWS):
        yield [rng.random() for _ in range(COLS)]


@tq.node
def with_max(row: list[float]) -> list[tuple[float, float]]:
    # The row maximum is a whole-row property, so it is computed before the split
    # and carried alongside every value.
    top = max(row)
    return [(v, top) for v in row]


@tq.node
def divide(chunk: list[tuple[float, float]]) -> list[float]:
    # One slice of a row, on one of the four workers: pure arithmetic, no state.
    return [v / top for v, top in chunk]


class Show:
    # Stateful (it counts rows), so it is a class: prints only the first three rows.
    def __init__(self) -> None:
        self.seen = 0

    def __call__(self, row: list[float]) -> None:
        self.seen += 1
        if self.seen <= 3:
            print(f"row {self.seen}: {[round(v, 3) for v in row]}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else rows
    # scatter splits each row over the 4 workers, gather concatenates the pieces back
    # in worker order, so the row comes out whole and in its original order.
    return start >> with_max >> tq.farm(divide, 4, emit="scatter", collect="gather") >> tq.sink(Show())


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
