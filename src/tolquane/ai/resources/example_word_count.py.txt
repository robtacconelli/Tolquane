"""Count words in a text: split lines in parallel, count per word on a keyed farm."""

import sys

import tolquane as tq

TEXT = """the quick brown fox jumps over the lazy dog
the dog sleeps and the fox runs
a quick brown dog and a lazy fox"""


@tq.source
def lines():
    # One line per item; a file would be `yield from open(path)`.
    yield from TEXT.splitlines()


@tq.node
def words(line: str):
    # Zero or many outputs per input: yield instead of return.
    for w in line.split():
        yield w.lower()


class Count:
    # Stateful, so it is a class: one instance per worker, and key= sends every
    # occurrence of a word to the same worker, so each count is complete.
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def __call__(self, word: str) -> object:
        self.counts[word] = self.counts.get(word, 0) + 1
        return tq.SKIP  # nothing per word; totals go out at the end

    def on_end(self, ctx: tq.Context) -> None:
        for word, n in self.counts.items():
            ctx.send((word, n))


@tq.sink
def show(pair: tuple[str, int]) -> None:
    word, n = pair
    print(f"{word:>8} {n}")


def main() -> None:
    tq.run(lines >> tq.farm(words, 2) >> tq.farm(Count, 3, key=lambda w: w) >> show)


if __name__ == "__main__":
    sys.exit(main())
