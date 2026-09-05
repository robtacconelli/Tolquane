"""Train a self-organizing map on a farm whose slices talk back to the emitter.

This is the use case of the BBFlow thesis (chapter 6), simplified: the map is split in
horizontal slices, one per worker; a search is broadcast to every slice; the collector
picks the winner and feeds it back; the emitter then broadcasts the learn step and waits
for every slice to acknowledge before taking the next input vector. Neighbourhoods
across slice borders are ignored here.
"""

import math
import random
from collections import deque

import tolquane as tq

SIDE = 16  # map is SIDE x SIDE cells
DEPTH = 3  # each cell holds a vector of this length
SLICES = 4


class Slice:
    """One horizontal band of the map. Answers search and learn commands."""

    def __init__(self) -> None:
        self.rows = SIDE // SLICES
        self.cells: list[list[list[float]]] = []

    def on_start(self, ctx: tq.Context) -> None:
        rng = random.Random(ctx.index)
        self.top = ctx.index * self.rows
        self.cells = [
            [[rng.random() for _ in range(DEPTH)] for _ in range(SIDE)] for _ in range(self.rows)
        ]

    def __call__(self, command: tuple, ctx: tq.Context) -> None:
        kind = command[0]
        if kind == "search":
            _, vec = command
            best = min(
                (
                    (_dist(self.cells[r][c], vec), (self.top + r, c))
                    for r in range(self.rows)
                    for c in range(SIDE)
                ),
            )
            ctx.send(("best", best[1], best[0]))
        elif kind == "learn":
            _, vec, (wr, wc), rate = command
            for r in range(self.rows):
                for c in range(SIDE):
                    d = math.hypot(self.top + r - wr, c - wc)
                    if d <= 2:
                        cell = self.cells[r][c]
                        for k in range(DEPTH):
                            cell[k] += rate * (vec[k] - cell[k])
            ctx.send(("learned",))


class Emitter:
    """Sequences the protocol: one input vector at a time, search then learn."""

    def __init__(self) -> None:
        self.pending: deque = deque()
        self.busy = False
        self.current = None

    def __call__(self, item: tuple, ctx: tq.Context) -> None:
        if not ctx.is_feedback:
            # A new input vector; queue it if a cycle is in progress.
            self.pending.append(item)
            if not self.busy:
                self._start(ctx)
            return
        kind = item[0]
        if kind == "best":
            _, pos, _ = item
            ctx.broadcast(("learn", self.current, pos, 0.3))
        elif kind == "learned":
            self.busy = False
            if self.pending:
                self._start(ctx)

    def _start(self, ctx: tq.Context) -> None:
        self.busy = True
        self.current = self.pending.popleft()
        ctx.broadcast(("search", self.current))


class Collector:
    """Merges the slices' answers: best of the bests, and one ack once all have learned."""

    def __init__(self) -> None:
        self.bests: list = []
        self.acks = 0

    def __call__(self, reply: tuple, ctx: tq.Context) -> None:
        if reply[0] == "best":
            self.bests.append(reply)
            if len(self.bests) == SLICES:
                winner = min(self.bests, key=lambda b: b[2])
                self.bests = []
                ctx.feedback(winner)
                ctx.send(("winner", winner[1], round(winner[2], 3)))
        else:
            self.acks += 1
            if self.acks == SLICES:
                self.acks = 0
                ctx.feedback(("learned",))


def _dist(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b, strict=True)))


def train(vectors: list[list[float]]) -> list[tuple]:
    out = tq.to_list()
    som = tq.farm(Slice, SLICES, emit="broadcast", emitter=Emitter, collector=Collector, name="som")
    tq.run(tq.from_iterable(vectors) >> tq.feedback(som) >> out)
    return out.items


def main() -> None:
    rng = random.Random(0)
    vectors = [[rng.random() for _ in range(DEPTH)] for _ in range(50)]
    for i, (_, pos, dist) in enumerate(train(vectors)):
        print(f"vector {i:2d}: winner {pos} at distance {dist}")


if __name__ == "__main__":
    main()
