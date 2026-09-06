/**
 * Walking and rewriting the flow tree by path.
 *
 * A path names one element of the tree the way the layout sidecar keys it:
 * `''` is the root, `stages.1` its second stage, `stages.1.worker` that farm's worker,
 * `stages.1.options.emitter` its custom emitter. Every rewrite here is pure and keeps
 * the parts it did not touch by identity, which is what lets `pathsAfterEdit` work out
 * where a card went without every edit having to say so.
 */

import {
  type All2AllTree,
  type FarmOptions,
  type FarmTree,
  type FlowModel,
  type NodeDef,
  type Tree,
} from './types';

export const ROOT = '';

export const DEFAULT_FARM_OPTIONS: FarmOptions = {
  emit: 'round_robin',
  collect: null,
  ordered: false,
  emitter: null,
  collector: null,
  key: null,
  prefetch: 1,
  window: null,
  name: null,
  capacity: null,
  runtime: null,
};

export function farmOptions(patch: Partial<FarmOptions> = {}): FarmOptions {
  return { ...DEFAULT_FARM_OPTIONS, ...patch };
}

export function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && typeof (value as Tree).type === 'string';
}

export function isContainer(tree: Tree): boolean {
  return tree.type !== 'ref' && tree.type !== 'inline' && tree.type !== 'start';
}

/** A farm's workers as a list, whether it was written with one worker or many. */
export function farmWorkers(farm: FarmTree): Tree[] {
  return Array.isArray(farm.worker) ? farm.worker : [farm.worker];
}

/** `true` for `tq.farm([f, g, h])`, FastFlow's heterogeneous farm. */
export function isHeterogeneous(farm: FarmTree): boolean {
  return Array.isArray(farm.worker);
}

/* ------------------------------------------------------------------------- children */

export interface Child {
  /** The path segment under the parent, such as `stages.2` or `options.emitter`. */
  key: string;
  tree: Tree;
}

/** Every sub-tree of a block, in the order the canvas draws them. */
export function children(tree: Tree): Child[] {
  switch (tree.type) {
    case 'pipeline':
      return tree.stages.map((stage, index) => ({ key: `stages.${index}`, tree: stage }));
    case 'farm': {
      const out: Child[] = Array.isArray(tree.worker)
        ? tree.worker.map((worker, index) => ({ key: `worker.${index}`, tree: worker }))
        : [{ key: 'worker', tree: tree.worker }];
      for (const option of ['emitter', 'collector', 'key'] as const) {
        const value = tree.options[option];
        if (isTree(value)) out.push({ key: `options.${option}`, tree: value });
      }
      return out;
    }
    case 'comb':
      return [
        { key: 'first', tree: tree.first },
        { key: 'second', tree: tree.second },
      ];
    case 'feedback':
      return [{ key: 'inner', tree: tree.inner }];
    case 'all2all': {
      const out: Child[] = [
        { key: 'left', tree: tree.left },
        { key: 'right', tree: tree.right },
      ];
      if (tree.R) out.push({ key: 'R', tree: tree.R });
      if (tree.G) out.push({ key: 'G', tree: tree.G });
      return out;
    }
    default:
      return [];
  }
}

export function joinPath(parent: string, key: string): string {
  return parent === ROOT ? key : `${parent}.${key}`;
}

/** The path of the element holding this one, and the segment it sits under. */
export function splitPath(path: string): { parent: string; key: string } {
  if (path === ROOT) return { parent: ROOT, key: ROOT };
  const steps = segments(path);
  return {
    parent: steps.slice(0, -1).join('.'),
    key: steps[steps.length - 1] ?? ROOT,
  };
}

/** Every element of the tree, root first, each with its path. */
export function walk(tree: Tree, base = ROOT): { path: string; tree: Tree }[] {
  const out: { path: string; tree: Tree }[] = [{ path: base, tree }];
  for (const child of children(tree)) {
    out.push(...walk(child.tree, joinPath(base, child.key)));
  }
  return out;
}

export function paths(tree: Tree): string[] {
  return walk(tree).map((entry) => entry.path);
}

/** The element at a path, or `null` when the path names nothing. */
export function getAt(tree: Tree, path: string): Tree | null {
  if (path === ROOT) return tree;
  let current: Tree = tree;
  for (const key of segments(path)) {
    const child = children(current).find((candidate) => candidate.key === key);
    if (!child) return null;
    current = child.tree;
  }
  return current;
}

export function hasPath(tree: Tree, path: string): boolean {
  return getAt(tree, path) !== null;
}

/** The path split into child keys: `stages.1.options.emitter` is three steps. */
export function segments(path: string): string[] {
  if (path === ROOT) return [];
  const parts = path.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    const next = parts[i + 1];
    // `stages` and `worker` are followed by an index; `worker` alone is the single one.
    const indexed =
      (part === 'stages' || part === 'worker') && next !== undefined && /^\d+$/.test(next);
    const option =
      part === 'options' && (next === 'emitter' || next === 'collector' || next === 'key');
    if (indexed || option) {
      out.push(`${part}.${String(next)}`);
      i += 1;
    } else {
      out.push(part);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ rewriting */

/** A copy of `parent` with the child under `key` replaced, or dropped when `null`. */
export function replaceChild(parent: Tree, key: string, child: Tree | null): Tree {
  switch (parent.type) {
    case 'pipeline': {
      const index = indexOfKey(key, 'stages');
      if (index === null) return parent;
      const stages = parent.stages.slice();
      if (child === null) stages.splice(index, 1);
      else stages[index] = child;
      return { ...parent, stages };
    }
    case 'farm':
      return replaceFarmChild(parent, key, child);
    case 'comb': {
      if (key !== 'first' && key !== 'second') return parent;
      if (child === null) return parent;
      return { ...parent, [key]: child };
    }
    case 'feedback':
      return child === null ? parent : { ...parent, inner: child };
    case 'all2all': {
      if (key === 'left' || key === 'right') {
        return child === null ? parent : { ...parent, [key]: child };
      }
      if (key === 'R' || key === 'G') return { ...parent, [key]: child };
      return parent;
    }
    default:
      return parent;
  }
}

function replaceFarmChild(farm: FarmTree, key: string, child: Tree | null): Tree {
  if (key.startsWith('options.')) {
    const option = key.slice('options.'.length);
    if (option !== 'emitter' && option !== 'collector' && option !== 'key') return farm;
    return { ...farm, options: { ...farm.options, [option]: child } };
  }
  if (key === 'worker') {
    return child === null ? farm : { ...farm, worker: child };
  }
  const index = indexOfKey(key, 'worker');
  if (index === null || !Array.isArray(farm.worker)) return farm;
  const workers = farm.worker.slice();
  if (child === null) workers.splice(index, 1);
  else workers[index] = child;
  if (workers.length === 0) return farm;
  return { ...farm, worker: workers, workers: workers.length };
}

function indexOfKey(key: string, prefix: string): number | null {
  if (!key.startsWith(`${prefix}.`)) return null;
  const index = Number(key.slice(prefix.length + 1));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * The tree with the element at `path` replaced by what `update` returns (`null` removes
 * it). Untouched sub-trees keep their identity, so the layout can be re-keyed afterwards.
 */
export function updateAt(tree: Tree, path: string, update: (node: Tree) => Tree | null): Tree {
  if (path === ROOT) return update(tree) ?? tree;
  const steps = segments(path);
  const rewrite = (node: Tree, depth: number): Tree => {
    const key = steps[depth] as string;
    const child = children(node).find((candidate) => candidate.key === key);
    if (!child) return node;
    const next = depth === steps.length - 1 ? update(child.tree) : rewrite(child.tree, depth + 1);
    if (next === child.tree) return node;
    return replaceChild(node, key, next);
  };
  return rewrite(tree, 0);
}

export function setAt(tree: Tree, path: string, value: Tree): Tree {
  return updateAt(tree, path, () => value);
}

/* --------------------------------------------------------------------- the model */

export function findNode(model: FlowModel, id: string): NodeDef | null {
  return model.nodes.find((node) => node.id === id) ?? null;
}

/** The ids of every `ref` in the tree, in the order they are drawn. */
export function referencedIds(tree: Tree): string[] {
  return walk(tree)
    .map((entry) => (entry.tree.type === 'ref' ? entry.tree.id : null))
    .filter((id): id is string => id !== null);
}

export function isFarm(tree: Tree | null | undefined): tree is FarmTree {
  return !!tree && tree.type === 'farm';
}

export function isAll2All(tree: Tree | null | undefined): tree is All2AllTree {
  return !!tree && tree.type === 'all2all';
}
