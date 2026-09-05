"""Read JSON records from records.jsonl, drop later duplicates of the same id, and write the survivors to unique.jsonl in order."""

import json

import tolquane as tq

IN_PATH = "records.jsonl"
OUT_PATH = "unique.jsonl"


@tq.source
def read_lines():
    # One raw line per item; the file is read lazily so it never sits in memory.
    with open(IN_PATH, encoding="utf-8") as f:
        yield from f


@tq.node
def parse(line: str):
    # Text to record; blank lines are dropped rather than sent on.
    line = line.strip()
    if not line:
        return tq.SKIP
    return json.loads(line)


@tq.node
class KeepFirstById:
    # Stateful and order-sensitive, so it is a class on a single worker:
    # the first record for an id wins, later ones are skipped.
    def __init__(self) -> None:
        self.seen: set = set()

    def __call__(self, record: dict):
        key = record["id"]
        if key in self.seen:
            return tq.SKIP
        self.seen.add(key)
        return record


@tq.sink
class WriteJsonl:
    # Holds the output file handle, so it is a class with on_start/on_end.
    def on_start(self, ctx: tq.Context) -> None:
        self.out = open(OUT_PATH, "w", encoding="utf-8")
        self.written = 0

    def __call__(self, record: dict) -> None:
        self.out.write(json.dumps(record) + "\n")
        self.written += 1

    def on_end(self, ctx: tq.Context) -> None:
        self.out.close()
        print(f"wrote {self.written} unique records to {OUT_PATH}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else read_lines
    return start >> parse >> KeepFirstById >> WriteJsonl


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
