/**
 * Keeping the layout sidecar honest across an edit.
 *
 * Positions are keyed by tree path (`stages.1`, `stages.1.worker`), so inserting a stage
 * at the front renames every card behind it. The contract puts that job on the frontend.
 * Rather than have each edit describe its own renames, this reads them off the trees:
 * the edits keep untouched sub-trees by identity, so a block that is the same object at
 * a different path is a block that moved.
 */

import { children, joinPath, ROOT } from './tree';
import type { Layout, Position, Tree } from './types';

function index(tree: Tree, base = ROOT, into = new Map<Tree, string>()): Map<Tree, string> {
  into.set(tree, base);
  for (const child of children(tree)) index(child.tree, joinPath(base, child.key), into);
  return into;
}

function pathSet(tree: Tree, base = ROOT, into = new Set<string>()): Set<string> {
  into.add(base);
  for (const child of children(tree)) pathSet(child.tree, joinPath(base, child.key), into);
  return into;
}

/**
 * Where each block of `before` ended up in `after`: `{ 'stages.1': 'stages.2' }`. Only
 * blocks that actually moved appear; a block that was replaced or removed does not.
 */
export function pathRenames(before: Tree, after: Tree): Record<string, string> {
  const was = index(before);
  const renames: Record<string, string> = {};
  for (const [node, path] of index(after)) {
    const old = was.get(node);
    if (old !== undefined && old !== path) renames[old] = path;
  }
  return renames;
}

/**
 * The layout positions re-keyed for a tree that has just been edited. A card that moved
 * takes its position with it; one whose path no longer names anything is dropped, so the
 * sidecar does not fill up with the ghosts of deleted stages.
 */
export function pathsAfterEdit(
  before: Tree,
  after: Tree,
  positions: Record<string, Position>,
): Record<string, Position> {
  const renames = pathRenames(before, after);
  const alive = pathSet(after);
  const out: Record<string, Position> = {};
  for (const [path, position] of Object.entries(positions)) {
    const moved = renames[path];
    // Wrapping a stage pushes it down into the container that now stands in its place on
    // the canvas, so the position stays where it was rather than following the block in.
    const swallowed = moved !== undefined && alive.has(path) && moved.startsWith(`${path}.`);
    if (moved !== undefined && !swallowed) out[moved] = position;
    else if (alive.has(path)) out[path] = position;
  }
  return out;
}

/** The same, for a whole sidecar. */
export function layoutAfterEdit(layout: Layout, before: Tree, after: Tree): Layout {
  return { ...layout, positions: pathsAfterEdit(before, after, layout.positions) };
}
