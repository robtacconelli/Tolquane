"""Sum sales.csv amounts per region on a keyed farm and print one line per region, sorted."""

import csv
import pathlib

import tolquane as tq

PATH = pathlib.Path("sales.csv")


@tq.source
def rows():
    # I/O: reads the CSV once and yields one dict per data row.
    with PATH.open(newline="") as f:
        yield from csv.DictReader(f)


@tq.node
def parse(row: dict) -> object:
    # Turns a raw row into (region, amount); drops rows without a usable amount.
    region = (row.get("region") or "").strip()
    amount = (row.get("amount") or "").strip()
    if not region or not amount:
        return tq.SKIP
    return (region, float(amount))


class SumRegion:
    # Stateful, so it is a class: key= sends every row of a region to the same
    # worker, so each total is complete; totals go out at the end of the stream.
    def __init__(self) -> None:
        self.totals: dict[str, float] = {}

    def __call__(self, pair: tuple[str, float]) -> object:
        region, amount = pair
        self.totals[region] = self.totals.get(region, 0.0) + amount
        return tq.SKIP

    def on_end(self, ctx: tq.Context) -> None:
        for region, total in self.totals.items():
            ctx.send((region, total))


class Report:
    # Sorting needs every total in one place, so the sink buffers and prints on_end.
    def __init__(self) -> None:
        self.totals: list[tuple[str, float]] = []

    def __call__(self, pair: tuple[str, float]) -> None:
        self.totals.append(pair)

    def on_end(self, ctx: tq.Context) -> None:
        for region, total in sorted(self.totals):
            print(f"{region:<12} {total:>12.2f}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else rows
    return start >> parse >> tq.farm(SumRegion, 4, key=lambda p: p[0]) >> tq.sink(Report)


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
