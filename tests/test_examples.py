"""The examples run and do what their docstrings say."""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))

import som
import word_count

import tolquane as tq


def test_hello_runs(capsys: object) -> None:
    import hello

    hello.main()


def test_word_count_totals() -> None:
    out = tq.to_list()
    tq.run(
        word_count.lines
        >> tq.farm(word_count.words, 2)
        >> tq.farm(word_count.Count, 3, key=lambda w: w)
        >> out
    )
    counts = dict(out.items)
    assert counts["the"] == 4
    assert counts["fox"] == 3
    assert sum(counts.values()) == len(word_count.TEXT.split())


def test_som_moves_winners_towards_their_vectors() -> None:
    rng = random.Random(1)
    vectors = [[rng.random() for _ in range(som.DEPTH)] for _ in range(12)]
    results = som.train(vectors)
    assert len(results) == 12
    assert all(kind == "winner" for kind, _, _ in results)
    # Training the same vectors twice must bring the winners closer the second time.
    twice = som.train(vectors + vectors)
    first = [d for _, _, d in twice[:12]]
    second = [d for _, _, d in twice[12:]]
    assert sum(second) < sum(first)
