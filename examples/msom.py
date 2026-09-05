"""The thesis use case, ported faithfully from BBFlow's tests/MSOM.

A self-organizing map is cut into a grid of slices, one per worker. Adjacent slices
are linked so that a learning step near a border trains cells across it, diagonal
neighbours reached by redirecting through a side neighbour, with acknowledgements
routed back the same way. An emitter sequences the protocol (search on every slice,
learn on the winner, wait for the acknowledgement) through a feedback loop from the
collector. `sequential_search_and_learn` is the single-map reference the parallel
version must match exactly.
"""

from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass

import tolquane as tq
from tolquane.graph import expand

TOP, LEFT, BOTTOM, RIGHT = 0, 1, 2, 3
OPPOSITE = {TOP: BOTTOM, BOTTOM: TOP, LEFT: RIGHT, RIGHT: LEFT}
CIRC = 5  # neighbourhood radius (Chebyshev)

SEARCH, LEARN, SEARCH_AND_LEARN, FINISHED, LEARN_FINISHED, LEARN_NEIGHBOURS, SEARCH_FINISHED = (
    range(1, 8)
)
LISTEN_NEIGHBOURS, LISTEN_COMMAND = 0, 1
SLAVE, LEARNING = 0, 1

Map = list[list[list[float]]]


@dataclass
class Packet:
    kind: int
    packet_id: int = -1
    neuron: list[float] | None = None
    train_i: int = 0
    train_j: int = 0
    curve: float = 0.0
    result: tuple[int, int, float, int] | None = None  # best_i, best_j, distance, slice
    redirect: int | None = None
    reply_redirect: int | None = None
    listen: int = LISTEN_COMMAND


@dataclass
class Config:
    size: int
    depth: int
    split: int
    initial: Map
    links_out: dict[int, dict[int, int]]  # slice -> direction -> output index
    links_in: dict[int, dict[int, int]]  # slice -> input index -> direction it comes from

    @property
    def parts(self) -> int:
        return self.split * self.split

    @property
    def side(self) -> int:
        return self.size // self.split


_CFG: Config | None = None


# --------------------------------------------------------------------------- the math


def java_round2(v: float) -> float:
    """BBFlow does Math.round(v * 100) / 100."""
    return math.floor(v * 100 + 0.5) / 100


def normalize(vector: list[float]) -> list[float]:
    n_min = min(vector[:-1])
    return [v - n_min for v in vector]


def search(som: Map, neuron: list[float]) -> tuple[int, int, float]:
    best_i = best_j = 0
    best = float("inf")
    for i, row in enumerate(som):
        for j, cell in enumerate(row):
            distance = 0.0
            for c, n in zip(cell, neuron, strict=True):
                distance += (c - n) * (c - n)
                if distance > best:
                    break
            if distance < best:
                best, best_i, best_j = distance, i, j
    return best_i, best_j, best


def train_cell(som: Map, i: int, j: int, neuron: list[float], curve: float) -> None:
    cell = som[i][j]
    for d, n in enumerate(neuron):
        cell[d] = java_round2(cell[d] * (1 - curve) + n * curve)


def sequential_search_and_learn(som: Map, neuron: list[float]) -> tuple[int, int, float]:
    """SOM_sequential.searchAndLearn on one whole map."""
    best_i, best_j, best = search(som, neuron)
    size = len(som)
    for i in range(max(0, best_i - CIRC), min(size - 1, best_i + CIRC) + 1):
        for j in range(max(0, best_j - CIRC), min(size - 1, best_j + CIRC) + 1):
            flat = max(abs(i - best_i), abs(j - best_j))
            train_cell(som, i, j, neuron, 0.2 / 1.3**flat)
    return best_i, best_j, best


# --------------------------------------------------------------------------- the nodes


class Slice:
    """One slice of the map: answers searches, learns, and trains its neighbours' edges."""

    def __call__(self, ctx: tq.Context) -> None:
        cfg = _CFG
        assert cfg is not None
        idx = ctx.index
        x, y = divmod(idx, cfg.split)
        side = cfg.side
        som = copy.deepcopy(
            [row[y * side : (y + 1) * side] for row in cfg.initial[x * side : (x + 1) * side]]
        )
        links_out = cfg.links_out[idx]
        links_in = cfg.links_in[idx]
        command_in, collector_out = 0, 0
        mode = SLAVE
        waiting = 0
        learning_id = -1

        def request_neighbour(i: int, j: int, neuron: list[float], curve: float) -> bool:
            """Ask the slice that owns cell (i, j) to train it. Returns True if sent."""
            if i < 0:
                d1, d2, ti = TOP, None, side + i
            elif i >= side:
                d1, d2, ti = BOTTOM, None, i - side
            else:
                d1, d2, ti = None, None, i
            if j < 0:
                d2, tj = LEFT, side + j
            elif j >= side:
                d2, tj = RIGHT, j - side
            else:
                tj = j
            if d1 is None:
                d1, d2 = d2, None
            assert d1 is not None
            out = links_out.get(d1)
            if out is None:
                return False  # outside the whole map
            pkt = Packet(
                LEARN_NEIGHBOURS,
                neuron=neuron,
                curve=curve,
                train_i=ti,
                train_j=tj,
                redirect=d2,
                listen=LISTEN_NEIGHBOURS,
            )
            ctx.send(pkt, to=out)
            return True

        while True:
            r = ctx.recv(source=command_in) if mode == SLAVE else ctx.recv()
            if r is None:
                break
            src, pkt = r
            direction = links_in.get(src)
            if pkt.listen == LISTEN_NEIGHBOURS:
                mode = LEARNING
            elif pkt.listen == LISTEN_COMMAND:
                mode = SLAVE
            kind = pkt.kind
            if kind in (SEARCH, SEARCH_AND_LEARN):
                assert pkt.neuron is not None
                bi, bj, dist = search(som, pkt.neuron)
                reply = Packet(kind, pkt.packet_id, neuron=pkt.neuron, result=(bi, bj, dist, idx))
                ctx.send(reply, to=collector_out)
            elif kind == LEARN:
                assert pkt.neuron is not None
                learning_id = pkt.packet_id
                bi, bj = pkt.train_i, pkt.train_j
                for i in range(bi - CIRC, bi + CIRC + 1):
                    for j in range(bj - CIRC, bj + CIRC + 1):
                        curve = 0.2 / 1.3 ** max(abs(i - bi), abs(j - bj))
                        if 0 <= i < side and 0 <= j < side:
                            train_cell(som, i, j, pkt.neuron, curve)
                        elif request_neighbour(i, j, pkt.neuron, curve):
                            waiting += 1
                if waiting == 0:
                    ctx.send(Packet(LEARN_FINISHED, learning_id), to=collector_out)
                    mode = SLAVE
            elif kind == LEARN_NEIGHBOURS:
                assert direction is not None
                if pkt.redirect is not None:
                    onward = links_out.get(pkt.redirect)
                    pkt.redirect = None
                    if onward is not None:
                        pkt.reply_redirect = direction
                        ctx.send(pkt, to=onward)
                        continue
                    ctx.send(
                        Packet(LEARN_FINISHED, listen=LISTEN_NEIGHBOURS), to=links_out[direction]
                    )
                    continue
                assert pkt.neuron is not None
                train_cell(som, pkt.train_i, pkt.train_j, pkt.neuron, pkt.curve)
                ack = Packet(
                    LEARN_FINISHED, reply_redirect=pkt.reply_redirect, listen=LISTEN_NEIGHBOURS
                )
                ctx.send(ack, to=links_out[direction])
            elif kind == LEARN_FINISHED:
                if pkt.reply_redirect is not None:
                    back = pkt.reply_redirect
                    pkt.reply_redirect = None
                    ctx.send(pkt, to=links_out[back])
                    continue
                waiting -= 1
                if waiting == 0:
                    ctx.send(Packet(LEARN_FINISHED, learning_id), to=collector_out)
                    mode = SLAVE
            # FINISHED only carries the listen flag handled above.
        ctx.send(("map", idx, som), to=collector_out)


class Emitter:
    """Sequences tasks: broadcast a command, then wait for the collector's answer."""

    def __call__(self, ctx: tq.Context) -> None:
        cfg = _CFG
        assert cfg is not None
        feedback_in = ctx.feedback_inputs[0]
        command_in = next(i for i in range(ctx.n_inputs) if i != feedback_in)
        running = False
        while True:
            if running:
                r = ctx.recv(source=feedback_in)
                if r is None:
                    return
                _, pkt = r
                running = False
                if pkt.kind == LEARN:
                    running = True
                    assert pkt.result is not None
                    bi, bj, _, winner = pkt.result
                    learn = Packet(
                        LEARN,
                        pkt.packet_id,
                        neuron=pkt.neuron,
                        train_i=bi,
                        train_j=bj,
                        listen=LISTEN_NEIGHBOURS,
                    )
                    ctx.send(learn, to=winner)
                    x, y = divmod(winner, cfg.split)
                    for i in range(max(0, x - 1), min(cfg.split - 1, x + 1) + 1):
                        for j in range(max(0, y - 1), min(cfg.split - 1, y + 1) + 1):
                            if i * cfg.split + j != winner:
                                ctx.send(
                                    Packet(FINISHED, listen=LISTEN_NEIGHBOURS), to=i * cfg.split + j
                                )
            else:
                r = ctx.recv(source=command_in)
                if r is None:
                    # BBFlow broadcast an EOS command here: every slice goes back to
                    # listening on its command input, sees it close, and finishes.
                    ctx.broadcast(Packet(FINISHED, listen=LISTEN_COMMAND))
                    return
                _, pkt = r
                running = True
                ctx.broadcast(pkt)


class Collector:
    """Merges search results into one winner; turns the winner's ack into FINISHED."""

    def __init__(self) -> None:
        self.count = 0
        self.best: tuple[int, int, float, int] | None = None

    def __call__(self, item: object, ctx: tq.Context) -> None:
        cfg = _CFG
        assert cfg is not None
        if isinstance(item, tuple):  # ("map", slice, cells) at the end
            ctx.send(item)
            return
        assert isinstance(item, Packet)
        if item.kind in (SEARCH, SEARCH_AND_LEARN):
            assert item.result is not None
            self.count += 1
            if self.best is None or item.result[2] < self.best[2]:
                self.best = item.result
            if self.count == cfg.parts:
                best = self.best
                self.count, self.best = 0, None
                if item.kind == SEARCH_AND_LEARN:
                    ctx.feedback(Packet(LEARN, item.packet_id, neuron=item.neuron, result=best))
                else:
                    ctx.feedback(Packet(SEARCH_FINISHED, item.packet_id, result=best))
                ctx.send(("search", item.packet_id, best))
        elif item.kind == LEARN_FINISHED:
            ctx.feedback(Packet(FINISHED, item.packet_id))
            ctx.send(("learned", item.packet_id))


# --------------------------------------------------------------------------- building


def build(
    size: int, depth: int, split: int, initial: Map, packets: list[Packet]
) -> tuple[tq.Graph, tq.ListSink]:
    """The farm, wrapped in a feedback loop, plus the grid links between slices."""
    global _CFG
    if size % split or size // split < CIRC:
        raise ValueError("size must be a multiple of split and each slice at least CIRC wide")
    out = tq.to_list()
    som = tq.farm(
        tq.raw(Slice), split * split, emitter=tq.raw(Emitter), collector=Collector, name="som"
    )
    g = expand(tq.from_iterable(packets) >> tq.feedback(som) >> out)
    links_out: dict[int, dict[int, int]] = {i: {} for i in range(split * split)}
    links_in: dict[int, dict[int, int]] = {i: {} for i in range(split * split)}
    outs = {i: 1 for i in range(split * split)}  # output 0 is the collector
    ins = {i: 1 for i in range(split * split)}  # input 0 is the emitter
    for x in range(split):
        for y in range(split):
            idx = x * split + y
            for direction, nx, ny in (
                (TOP, x - 1, y),
                (LEFT, x, y - 1),
                (BOTTOM, x + 1, y),
                (RIGHT, x, y + 1),
            ):
                if 0 <= nx < split and 0 <= ny < split:
                    nidx = nx * split + ny
                    g.link(f"som.{idx}", f"som.{nidx}")
                    links_out[idx][direction] = outs[idx]
                    outs[idx] += 1
                    links_in[nidx][ins[nidx]] = OPPOSITE[direction]
                    ins[nidx] += 1
    _CFG = Config(size, depth, split, initial, links_out, links_in)
    return g, out


def train(
    size: int, depth: int, split: int, initial: Map, vectors: list[list[float]]
) -> tuple[Map, list[tuple]]:
    """Search-and-learn every vector in turn; return the trained map and the events."""
    packets = [Packet(SEARCH_AND_LEARN, i, neuron=v) for i, v in enumerate(vectors)]
    g, out = build(size, depth, split, initial, packets)
    tq.run(g)
    side = size // split
    som: Map = [[[] for _ in range(size)] for _ in range(size)]
    events = []
    for item in out.items:
        if item[0] == "map":
            _, idx, cells = item
            x, y = divmod(idx, split)
            for i in range(side):
                for j in range(side):
                    som[x * side + i][y * side + j] = cells[i][j]
        else:
            events.append(item)
    return som, events


def random_map(size: int, depth: int, rng: random.Random) -> Map:
    """SOM.randomize(0, 255, 3): random values in [0, 85)."""
    return [
        [[rng.random() * 255 / 3 for _ in range(depth)] for _ in range(size)] for _ in range(size)
    ]


def main() -> None:
    rng = random.Random(0)
    size, depth, split = 24, 3, 2
    initial = random_map(size, depth, rng)
    vectors = [normalize([rng.random() * 255 for _ in range(depth)]) for _ in range(20)]
    som, events = train(size, depth, split, initial, vectors)
    reference = copy.deepcopy(initial)
    for v in vectors:
        sequential_search_and_learn(reference, v)
    print(f"{len(events)} events; parallel map equals the sequential one: {som == reference}")


if __name__ == "__main__":
    main()
