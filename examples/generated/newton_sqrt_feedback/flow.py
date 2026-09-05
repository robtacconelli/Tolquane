"""Compute square roots of 2, 3, 5, 7 and 11 by Newton's method, one iteration per pass
through a feedback loop, printing each root and its iteration count."""

import math

import tolquane as tq

TOLERANCE = 1e-9

# State travelling through the loop: (n, estimate, last change, iterations).


@tq.source
def numbers():
    # The numbers to take the square root of.
    yield from (2, 3, 5, 7, 11)


@tq.node
def seed(n: int) -> tuple:
    # Turns a bare number into the loop's state, starting the estimate at n itself.
    return (n, float(n), math.inf, 0)


@tq.node
def refine(state: tuple) -> tuple:
    # One Newton iteration; pure and stateless, so several workers can run it at once.
    n, x, _, i = state
    nxt = 0.5 * (x + n / x)
    return (n, nxt, abs(nxt - x), i + 1)


@tq.node
def route(state: tuple, ctx: tq.Context) -> None:
    # The loop's last stage: converged results go out, the rest go round again.
    if state[2] < TOLERANCE:
        ctx.send(state)
    else:
        ctx.feedback(state)


@tq.sink
def show(state: tuple) -> None:
    n, x, _, i = state
    print(f"sqrt({n}) = {x:.12f} after {i} iterations")


def build(source=None):
    src = tq.from_iterable(source) if source is not None else numbers
    # The farm refines five estimates in parallel; its collector decides who loops.
    loop = tq.feedback(tq.farm(refine, workers=5, collector=route))
    return src >> seed >> loop >> show


def main() -> None:
    print(tq.run(build()))


if __name__ == "__main__":
    main()
