"""Test the numbers 2 to 20000 for primality on eight workers and print the primes in order, then their count."""

import tolquane as tq


@tq.source
def numbers():
    # The candidates to test, in increasing order.
    yield from range(2, 20001)


@tq.node
def keep_primes(n: int) -> int:
    # Trial division: CPU work, so it runs on the farm; non-primes are dropped.
    if n < 2 or (n > 2 and n % 2 == 0):
        return tq.SKIP
    d = 3
    while d * d <= n:
        if n % d == 0:
            return tq.SKIP
        d += 2
    return n


@tq.sink
class Report:
    # Stateful: it prints each prime as it arrives and the total in on_end.
    def __init__(self) -> None:
        self.count = 0

    def __call__(self, n: int) -> None:
        self.count += 1
        print(n)

    def on_end(self, ctx: tq.Context) -> None:
        print(f"{self.count} primes")


def build(source=None):
    src = tq.from_iterable(source) if source is not None else numbers
    # ordered=True so the primes come out in increasing order despite 8 workers.
    return src >> tq.farm(keep_primes, workers=8, ordered=True) >> Report


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
