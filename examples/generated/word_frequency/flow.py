"""Count the words of a built-in text and print the ten most common with their counts."""

import re

import tolquane as tq

TEXT = """It was the best of times, it was the worst of times,
it was the age of wisdom, it was the age of foolishness,
it was the epoch of belief, it was the epoch of incredulity,
it was the season of Light, it was the season of Darkness,
it was the spring of hope, it was the winter of despair,
we had everything before us, we had nothing before us,
we were all going direct to Heaven, we were all going direct
the other way -- in short, the period was so far like the present
period, that some of its noisiest authorities insisted on its
being received, for good or for evil, in the superlative degree"""

WORD = re.compile(r"[a-z']+")


@tq.source
def lines():
    # One line per item; a real text would be `yield from open(path)`.
    yield from TEXT.splitlines()


@tq.node
def words(line: str):
    # Zero or many outputs per line: lowercase and drop punctuation.
    for word in WORD.findall(line.lower()):
        yield word.strip("'")


@tq.node
def keep_words(word: str) -> object:
    # Filter out the empty strings left by stripping quotes.
    return word if word else tq.SKIP


class Count:
    # Stateful, so a class: key= sends every occurrence of a word to the same
    # worker, so each partial count is already complete.
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def __call__(self, word: str) -> object:
        self.counts[word] = self.counts.get(word, 0) + 1
        return tq.SKIP  # nothing per word; totals go out at the end

    def on_end(self, ctx: tq.Context) -> None:
        for pair in self.counts.items():
            ctx.send(pair)


class TopTen:
    # Ranking needs to see every total, so it is one stateful node at the end.
    def __init__(self) -> None:
        self.totals: dict[str, int] = {}

    def __call__(self, pair: tuple[str, int]) -> object:
        word, n = pair
        self.totals[word] = self.totals.get(word, 0) + n
        return tq.SKIP

    def on_end(self, ctx: tq.Context) -> None:
        ranked = sorted(self.totals.items(), key=lambda kv: (-kv[1], kv[0]))
        for pair in ranked[:10]:
            ctx.send(pair)


@tq.sink
def show(pair: tuple[str, int]) -> None:
    word, n = pair
    print(f"{word:>12} {n}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else lines
    return (
        start
        >> tq.farm(words, 2)
        >> keep_words
        >> tq.farm(Count, 3, key=lambda w: w)
        >> tq.farm(TopTen, 1)
        >> show
    )


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
