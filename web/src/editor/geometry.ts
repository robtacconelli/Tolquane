/**
 * How big every block is on the canvas.
 *
 * The card is the one in DESIGN.md ("The block card"): 208 wide, and 64 tall once it
 * carries a title and a subtitle. Containers are not a variant of the card -- they are a
 * panel with a header row shaped like the card's header and the child cards inside it --
 * so their sizes are built from the same paddings the design system uses.
 *
 * Measuring and placing read these together: `measure` says how big a sub-tree is,
 * `buildGraph` puts it somewhere, and both walk the tree the same way.
 */

/** The block card of DESIGN.md, with a title and a one-line subtitle. */
export const CARD_W = 208;
export const CARD_H = 64;

/** A comb is one card showing the two nodes it fuses. */
export const COMB_H = 92;

/** A farm's emitter and collector: small end cards inside the container. */
export const END_W = 124;
export const END_H = 48;

/** Between two top-level stages, where an edge has room to be seen. */
export const GAP_X = 56;
/** Inside a container, where the eye already knows what belongs together. */
export const GAP_IN = 28;
/** Between stacked cards: a heterogeneous farm's workers, an all-to-all's cross. */
export const GAP_Y = 20;

/** Inside a container: the header row, then the padding around its children. */
export const GROUP_HEADER = 42;
export const GROUP_PAD = 16;

/** Room under a feedback loop's inner block for the edge that goes back. */
export const LOOP_SPACE = 44;

/** How many worker cards an all-to-all draws per side before it says "and N more". */
export const MAX_REPS = 3;

export interface Box {
  w: number;
  h: number;
}

export function reps(workers: number): number {
  return Math.max(1, Math.min(MAX_REPS, Math.trunc(workers) || 1));
}
