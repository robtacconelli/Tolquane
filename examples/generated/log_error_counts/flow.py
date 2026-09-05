"""Count ERROR lines per module in app.log and print the modules, highest count first."""

from collections import Counter

import tolquane as tq

LOG_PATH = "app.log"


@tq.source
def log_lines():
    # The stream to process: one line of app.log per item.
    with open(LOG_PATH, encoding="utf-8") as f:
        yield from f


@tq.node
def error_module(line: str):
    # Parse "timestamp level module message" and keep only ERROR lines.
    parts = line.split(maxsplit=3)
    if len(parts) < 3 or parts[1].upper() != "ERROR":
        return tq.SKIP
    return parts[2]


class Report:
    # Stateful and must see every module, so it is one class instance at the end:
    # it tallies the modules and prints the ranking once the stream is done.
    def __init__(self) -> None:
        self.counts: Counter[str] = Counter()

    def __call__(self, module: str) -> None:
        self.counts[module] += 1

    def on_end(self, ctx: tq.Context) -> None:
        for module, n in sorted(self.counts.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"{n:>6}  {module}")


def build(source=None):
    # Parsing is cheap but a farm keeps it off the reader's thread; the sink stays single.
    start = tq.from_iterable(source) if source is not None else log_lines
    return start >> tq.farm(error_module, workers=4) >> tq.sink(Report)


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
