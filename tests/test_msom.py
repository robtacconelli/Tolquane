"""The MSOM port must reproduce the sequential SOM exactly, across slice borders."""

import copy
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))

import msom

import tolquane as tq


def _case(size: int, split: int, n_vectors: int, seed: int):  # type: ignore[no-untyped-def]
    rng = random.Random(seed)
    depth = 3
    initial = msom.random_map(size, depth, rng)
    vectors = [msom.normalize([rng.random() * 255 for _ in range(depth)]) for _ in range(n_vectors)]
    reference = copy.deepcopy(initial)
    winners = [msom.sequential_search_and_learn(reference, v) for v in vectors]
    return depth, initial, vectors, reference, winners


def test_parallel_map_equals_sequential_across_borders() -> None:
    size, split = 36, 3  # slices of 12 with radius 5: every learn step crosses a border
    depth, initial, vectors, reference, winners = _case(size, split, 15, seed=7)
    som, events = msom.train(size, depth, split, initial, vectors)
    assert som == reference
    searches = [e for e in events if e[0] == "search"]
    assert len(searches) == len(vectors)
    for (_, _pid, (bi, bj, dist, slice_idx)), (ri, rj, rdist) in zip(
        searches, winners, strict=True
    ):
        side = size // split
        x, y = divmod(slice_idx, split)
        assert (x * side + bi, y * side + bj) == (ri, rj)
        assert abs(dist - rdist) < 1e-9
    assert sum(1 for e in events if e[0] == "learned") == len(vectors)


def test_single_slice_and_two_by_two_grids() -> None:
    for size, split in ((12, 1), (16, 2)):
        depth, initial, vectors, reference, _ = _case(size, split, 6, seed=size)
        som, _ = msom.train(size, depth, split, initial, vectors)
        assert som == reference


def test_thesis_test_msom_shape_repeats_one_vector() -> None:
    """test_MSOM.java trains the same vector many times; the winner must stay put."""
    depth, initial, vectors, reference, _ = _case(24, 2, 1, seed=3)
    repeated = vectors * 30
    som, events = msom.train(24, depth, 2, initial, repeated)
    for v in repeated[1:]:
        msom.sequential_search_and_learn(reference, v)
    assert som == reference
    winners = {e[2][:2] for e in events if e[0] == "search"}
    assert len(winners) == 1


def test_graph_shape() -> None:
    depth, initial, vectors, _, _ = _case(12, 2, 1, seed=1)
    g, _ = msom.build(12, depth, 2, initial, [msom.Packet(msom.SEARCH, 0, neuron=vectors[0])])
    links = [e for e in g.edges if e.rule == "link"]
    assert len(links) == 8  # 2x2 grid: 4 undirected neighbour pairs, two directions each
    text = tq.explain(g)
    assert "som.0 -> som.1  [link]" in text
    assert "loop loop:" in text
