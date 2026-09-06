/**
 * The edits the canvas makes to a flow tree.
 *
 * Every function is pure: it takes a tree and gives a new one, keeping the sub-trees it
 * did not touch by identity so `pathsAfterEdit` can follow the cards that moved. None of
 * them validates -- `validateModel` says what is wrong, and it says it about a tree that
 * exists, so a half-finished edit is still visible on the canvas.
 */

import { children, farmOptions, getAt, isTree, joinPath, ROOT, splitPath, updateAt } from './tree';
import type { FarmOptions, FarmTree, PipelineTree, Tree } from './types';

/* ------------------------------------------------------------------- new blocks */

export function refBlock(id: string): Tree {
  return { type: 'ref', id };
}

export function inlineBlock(source: string): Tree {
  return { type: 'inline', source };
}

export function farmBlock(worker: Tree, workers = 4, options: Partial<FarmOptions> = {}): FarmTree {
  return { type: 'farm', worker, workers, options: farmOptions(options) };
}

export function combBlock(first: Tree, second: Tree): Tree {
  return { type: 'comb', first, second };
}

export function feedbackBlock(inner: Tree, name: string | null = null): Tree {
  return { type: 'feedback', inner, name };
}

export function all2allBlock(left: Tree, right: Tree): Tree {
  return { type: 'all2all', left, right, R: null, G: null, merge: false };
}

export function pipelineBlock(stages: Tree[]): PipelineTree {
  return { type: 'pipeline', stages };
}

/* ------------------------------------------------------------ inserting and moving */

/** Insert `child` into the pipeline at `path`, at `index` (the end when out of range). */
export function insertStage(tree: Tree, path: string, index: number, child: Tree): Tree {
  return updateAt(tree, path, (node) => {
    if (node.type !== 'pipeline') return node;
    const stages = node.stages.slice();
    stages.splice(clamp(index, stages.length), 0, child);
    return { ...node, stages };
  });
}

/**
 * Put `child` straight after the block at `path`. When that block is not a stage of a
 * pipeline (a farm's worker, say) the two become a pipeline in its place, which is what
 * `worker >> child` means anyway.
 */
export function insertAfter(tree: Tree, path: string, child: Tree): Tree {
  const { parent, key } = splitPath(path);
  const holder = getAt(tree, parent);
  if (path !== ROOT && holder?.type === 'pipeline' && key.startsWith('stages.')) {
    const index = Number(key.slice('stages.'.length));
    return insertStage(tree, parent, index + 1, child);
  }
  return updateAt(tree, path, (node) =>
    node.type === 'pipeline'
      ? { ...node, stages: [...node.stages, child] }
      : pipelineBlock([node, child]),
  );
}

/** Put `child` before the block at `path`. */
export function insertBefore(tree: Tree, path: string, child: Tree): Tree {
  const { parent, key } = splitPath(path);
  const holder = getAt(tree, parent);
  if (path !== ROOT && holder?.type === 'pipeline' && key.startsWith('stages.')) {
    return insertStage(tree, parent, Number(key.slice('stages.'.length)), child);
  }
  return updateAt(tree, path, (node) =>
    node.type === 'pipeline'
      ? { ...node, stages: [child, ...node.stages] }
      : pipelineBlock([child, node]),
  );
}

/** Append to the flow's top level, making a pipeline of the root when it is a single block. */
export function appendStage(tree: Tree, child: Tree): Tree {
  if (tree.type === 'pipeline') return { ...tree, stages: [...tree.stages, child] };
  return pipelineBlock([tree, child]);
}

/**
 * Remove the block at `path`. A pipeline left with nothing goes too, unless it is the
 * root: an empty flow is a canvas to drop the first block on, not an error to fix.
 */
export function removeAt(tree: Tree, path: string): Tree {
  if (path === ROOT) return pipelineBlock([]);
  const next = updateAt(tree, path, () => null);
  const { parent } = splitPath(path);
  const holder = getAt(next, parent);
  if (parent !== ROOT && holder?.type === 'pipeline' && holder.stages.length === 0) {
    return removeAt(next, parent);
  }
  return next;
}

/** Move a stage inside its own pipeline. Indices are the ones before the move. */
export function moveStage(tree: Tree, path: string, toIndex: number): Tree {
  const { parent, key } = splitPath(path);
  if (!key.startsWith('stages.')) return tree;
  const from = Number(key.slice('stages.'.length));
  return updateAt(tree, parent, (node) => {
    if (node.type !== 'pipeline') return node;
    const stages = node.stages.slice();
    const [moved] = stages.splice(from, 1);
    if (!moved) return node;
    stages.splice(clamp(toIndex, stages.length), 0, moved);
    return { ...node, stages };
  });
}

function clamp(index: number, max: number): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), max);
}

/* --------------------------------------------------------------- wrap and unwrap */

/**
 * Wrap the block at `path` in a farm; the block becomes the farm's worker. A farm of
 * farms is a real thing in Tolquane, so this wraps whatever is there and `unwrap` is
 * exactly its inverse.
 */
export function wrapInFarm(tree: Tree, path: string, workers = 4): Tree {
  return updateAt(tree, path, (node) => farmBlock(node, workers));
}

/** Wrap the block at `path` in a feedback loop. */
export function wrapInFeedback(tree: Tree, path: string, name: string | null = null): Tree {
  return updateAt(tree, path, (node) => feedbackBlock(node, name));
}

/**
 * Replace a container with what it holds: a farm with its worker, a loop with its inner
 * block, a one-stage pipeline with that stage, a comb with `first >> second`.
 */
export function unwrap(tree: Tree, path: string): Tree {
  return updateAt(tree, path, (node) => {
    switch (node.type) {
      case 'farm':
        return Array.isArray(node.worker) ? (node.worker[0] ?? node) : node.worker;
      case 'feedback':
        return node.inner;
      case 'comb':
        return pipelineBlock([node.first, node.second]);
      case 'pipeline':
        return node.stages.length === 1 ? (node.stages[0] as Tree) : node;
      case 'all2all':
        return pipelineBlock([node.left, node.right]);
      default:
        return node;
    }
  });
}

/* ----------------------------------------------------------------- farm options */

/** Change some of a farm's options, leaving the rest alone. */
export function setFarmOptions(tree: Tree, path: string, patch: Partial<FarmOptions>): Tree {
  return updateAt(tree, path, (node) =>
    node.type === 'farm' ? { ...node, options: { ...node.options, ...patch } } : node,
  );
}

/** Change a farm's worker count. A heterogeneous farm counts its workers itself. */
export function setWorkers(tree: Tree, path: string, workers: number): Tree {
  return updateAt(tree, path, (node) => {
    if (node.type !== 'farm' || Array.isArray(node.worker)) return node;
    return { ...node, workers: Math.max(1, Math.trunc(workers)) };
  });
}

/** Replace the block at `path` outright (the properties panel's node picker). */
export function replaceAt(tree: Tree, path: string, block: Tree): Tree {
  return updateAt(tree, path, () => block);
}

/** Rename a feedback loop, or a farm (its `name=` option). */
export function setBlockName(tree: Tree, path: string, name: string | null): Tree {
  return updateAt(tree, path, (node) => {
    if (node.type === 'feedback') return { ...node, name };
    if (node.type === 'farm') return { ...node, options: { ...node.options, name } };
    return node;
  });
}

/** Set `merge=` on an all-to-all. */
export function setMerge(tree: Tree, path: string, merge: boolean): Tree {
  return updateAt(tree, path, (node) => (node.type === 'all2all' ? { ...node, merge } : node));
}

/** Set the `R` or `G` block of an all-to-all, or clear it. */
export function setCrossBlock(
  tree: Tree,
  path: string,
  which: 'R' | 'G',
  block: Tree | null,
): Tree {
  return updateAt(tree, path, (node) =>
    node.type === 'all2all' ? { ...node, [which]: block } : node,
  );
}

/* --------------------------------------------------------------------- reading */

/** The paths of every block that is a card on the canvas, in drawing order. */
export function cardPaths(tree: Tree, base = ROOT): string[] {
  const out = [base];
  for (const child of children(tree)) out.push(...cardPaths(child.tree, joinPath(base, child.key)));
  return out;
}

/** The block a farm option holds, when it holds one. */
export function slotTree(value: Tree | false | null): Tree | null {
  return isTree(value) ? value : null;
}
