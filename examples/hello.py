"""Double the numbers 1 to 100 on four workers and print them in order."""

import tolquane as tq


@tq.source
def numbers():
    # The stream to process: any generator works.
    yield from range(1, 101)


@tq.node
def double(x: int) -> int:
    # Pure function, so it can run on several workers at once.
    return x * 2


@tq.sink
def show(x: int) -> None:
    print(x)


def main() -> None:
    # ordered=True makes the farm deliver results in input order.
    tq.run(numbers >> tq.farm(double, workers=4, ordered=True) >> show)


if __name__ == "__main__":
    main()
