"""Compute fibonacci(n) for n from 1 to 60 on four workers and print each n with its value in input order."""

import tolquane as tq


@tq.source
def indices():
    # The stream to process: the numbers 1 to 60.
    yield from range(1, 61)


@tq.node
def fibonacci(n: int) -> tuple[int, int]:
    # Pure function, so it can run on several workers at once.
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return n, a


@tq.sink
def show(pair: tuple[int, int]) -> None:
    n, value = pair
    print(f"fib({n:>2}) = {value}")


def build(source=None):
    # ordered=True makes the farm deliver results in input order.
    start = tq.from_iterable(source) if source is not None else indices
    return start >> tq.farm(fibonacci, workers=4, ordered=True) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
