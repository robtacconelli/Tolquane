/**
 * Names on the canvas, names in a run, and the map between them.
 *
 * The canvas draws blocks: one card for a whole farm, one edge between two stages. A run
 * reports threads: `double.emitter`, `double.0`, `double.collector`, and one edge for
 * each of them. So a card asks the run store for `double farm` and an edge for
 * `stages.0->stages.1`, neither of which a run has ever heard of.
 *
 * This is where the two are reconciled. The expanded graph the run sends with its first
 * event already holds the real names and which group each belongs to, so the map is
 * built from that rather than from a second copy of the naming rules: a block resolves
 * to the names it covers, and every canvas key that is not a run name itself becomes an
 * alias for them. Keys that already resolve are left alone, so nothing is ever counted
 * twice.
 */

import type { FlowModel, GraphView, Tree } from '../model';
import { blockTitle, farmWorkers, isHeterogeneous, joinPath, ROOT, walk } from '../model';

export interface RunAliases {
  /** Canvas card key to the run node names it stands for. */
  nodes: Record<string, string[]>;
  /** Canvas edge key (`stages.0->stages.1`) to the run edges it stands for. */
  edges: Record<string, string[]>;
}

export const NO_ALIASES: RunAliases = { nodes: {}, edges: {} };

interface Index {
  names: Set<string>;
  groups: Map<string, string[]>;
  loops: Map<string, string[]>;
  edges: { src: string; dst: string; key: string; feedback: boolean }[];
}

function indexGraph(graph: GraphView): Index {
  const names = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) {
    names.add(node.name);
    if (node.group) groups.set(node.group, [...(groups.get(node.group) ?? []), node.name]);
  }
  const loops = new Map<string, string[]>();
  for (const loop of graph.loops) loops.set(loop.name, [...loop.nodes]);
  // Edges are keyed the way a Progress snapshot keys them, `src->dst`, with the repeats
  // of one pair numbered; the run does the same, so the keys line up.
  const seen = new Map<string, number>();
  const edges = graph.edges.map((edge) => {
    const base = `${edge.src}->${edge.dst}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return {
      src: edge.src,
      dst: edge.dst,
      key: n === 0 ? base : `${base}#${String(n)}`,
      feedback: edge.feedback,
    };
  });
  return { names, groups, loops, edges };
}

/** The run names a candidate covers: a whole group, or one node and its threads. */
function namesFor(index: Index, candidate: string): string[] {
  const group = index.groups.get(candidate);
  if (group) return group;
  const own = [...index.names].filter(
    (name) => name === candidate || name.startsWith(`${candidate}.`),
  );
  return own;
}

function firstResolved(index: Index, candidates: (string | null)[]): string[] {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const names = namesFor(index, candidate);
    if (names.length > 0) return names;
  }
  return [];
}

/** The name a farm carries in a run: what the canvas calls it, minus the card's wording. */
function farmCandidates(tree: Tree & { type: 'farm' }, model: FlowModel): (string | null)[] {
  const workers = farmWorkers(tree);
  const first = workers[0];
  const title = blockTitle(tree, model);
  return [
    tree.options.name,
    title,
    // `blockTitle` writes "double farm" on the card; the run calls that group "double".
    title.endsWith(' farm') ? title.slice(0, -' farm'.length) : null,
    !isHeterogeneous(tree) && first ? blockTitle(first, model) : null,
  ];
}

/** Every run node a block covers, in graph order. */
function blockNames(tree: Tree, model: FlowModel, index: Index): string[] {
  switch (tree.type) {
    case 'pipeline':
      return tree.stages.flatMap((stage) => blockNames(stage, model, index));
    case 'farm':
      return firstResolved(index, farmCandidates(tree, model));
    case 'feedback': {
      const loop = tree.name ? index.loops.get(tree.name) : undefined;
      return loop ?? blockNames(tree.inner, model, index);
    }
    case 'all2all':
      return [...blockNames(tree.left, model, index), ...blockNames(tree.right, model, index)];
    case 'comb': {
      const first = blockTitle(tree.first, model);
      const second = blockTitle(tree.second, model);
      return firstResolved(index, [`${first}+${second}`, `${first} + ${second}`, first, second]);
    }
    case 'ref':
      return firstResolved(index, [tree.id]);
    case 'start':
      return firstResolved(index, [model.start, 'from_iterable', 'start']);
    default:
      return firstResolved(index, [blockTitle(tree, model), 'from_iterable']);
  }
}

/** The key `buildGraph` gives a card, so an alias lands where the canvas looks for it. */
function cardKey(tree: Tree, model: FlowModel): string {
  if (tree.type === 'farm') return tree.options.name ?? blockTitle(tree, model);
  if (tree.type === 'ref') return tree.id;
  return blockTitle(tree, model);
}

function addNodes(out: RunAliases, index: Index, key: string, names: string[]): void {
  if (names.length === 0) return;
  // A key the run already answers needs no alias, and adding one would make the card
  // count the same threads twice.
  if (namesFor(index, key).length > 0) return;
  out.nodes[key] = names;
}

function addEdges(out: RunAliases, index: Index, key: string, from: string[], to: string[]): void {
  if (from.length === 0 || to.length === 0) return;
  const sources = new Set(from);
  const targets = new Set(to);
  const real = index.edges
    .filter((edge) => sources.has(edge.src) && targets.has(edge.dst))
    .map((edge) => edge.key);
  if (real.length > 0) out.edges[key] = real;
}

/**
 * The map for one flow. `graph` is the expanded graph the run sent with its `start`
 * event (or the one the server parsed with the file); without it there is nothing to
 * map to and every canvas key is left as it is.
 */
export function runAliases(model: FlowModel | null, graph: GraphView | null): RunAliases {
  if (!model || !graph) return NO_ALIASES;
  const index = indexGraph(graph);
  const out: RunAliases = { nodes: {}, edges: {} };

  for (const { path, tree } of walk(model.flow)) {
    const names = blockNames(tree, model, index);
    // A farm is aliased thread by thread instead: its group card takes the worst state
    // and the sum of `<key>.emitter`, `<key>.0`, … the way `stateOfGroup` reads a real
    // group, and one aggregate under the group key itself would be counted twice.
    if (tree.type !== 'farm') addNodes(out, index, cardKey(tree, model), names);

    if (tree.type === 'pipeline') {
      // `>>` between two stages: every edge that leaves the first for the second.
      for (let i = 0; i + 1 < tree.stages.length; i += 1) {
        const left = tree.stages[i];
        const right = tree.stages[i + 1];
        if (!left || !right) continue;
        const from = blockNames(left, model, index);
        const to = blockNames(right, model, index);
        const key = `${joinPath(path, `stages.${String(i)}`)}->${joinPath(path, `stages.${String(i + 1)}`)}`;
        addEdges(out, index, key, from, to);
      }
    }

    if (tree.type === 'feedback') {
      const inner = joinPath(path, 'inner');
      const loop = new Set(names);
      const real = index.edges
        .filter((edge) => edge.feedback && loop.has(edge.src) && loop.has(edge.dst))
        .map((edge) => edge.key);
      if (real.length > 0) out.edges[`${inner}->${inner}`] = real;
    }

    if (tree.type === 'farm') {
      aliasFarm(out, index, path, tree, model, names);
    }
  }

  return out;
}

/** A farm's own cards: its ends, and one worker card per thread the canvas draws. */
function aliasFarm(
  out: RunAliases,
  index: Index,
  path: string,
  farm: Tree & { type: 'farm' },
  model: FlowModel,
  names: string[],
): void {
  const key = cardKey(farm, model);
  const emitter = names.find((name) => name.endsWith('.emitter'));
  const collector = names.find((name) => name.endsWith('.collector'));
  const workers = names
    .filter((name) => /\.\d+$/.test(name))
    .sort((a, b) => Number(/\d+$/.exec(a)?.[0] ?? 0) - Number(/\d+$/.exec(b)?.[0] ?? 0));

  if (emitter) addNodes(out, index, `${key}.emitter`, [emitter]);
  if (collector) addNodes(out, index, `${key}.collector`, [collector]);

  const heterogeneous = isHeterogeneous(farm);
  const drawn = heterogeneous ? farmWorkers(farm).length : Math.max(1, workers.length);
  for (let i = 0; i < drawn; i += 1) {
    const worker = workers[i];
    if (!worker) continue;
    // Every thread gets its own key under the farm's, including the first: the card
    // drawn for it carries the worker block's key instead, but the group card adds
    // these up and needs all of them.
    addNodes(out, index, `${key}.${String(i)}`, [worker]);
    const cardPath = heterogeneous
      ? joinPath(path, `worker.${String(i)}`)
      : i === 0
        ? joinPath(path, 'worker')
        : `${joinPath(path, 'worker')}#${String(i)}`;
    if (emitter) addEdges(out, index, `${path}#emitter->${cardPath}`, [emitter], [worker]);
    if (collector) addEdges(out, index, `${cardPath}->${path}#collector`, [worker], [collector]);
  }
}

/** The tree path of the block a run node belongs to, for pointing at a card. */
export function pathOfNode(model: FlowModel | null, graph: GraphView | null, node: string): string {
  if (!model || !graph) return ROOT;
  const index = indexGraph(graph);
  let best = ROOT;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const { path, tree } of walk(model.flow)) {
    const names = blockNames(tree, model, index);
    if (!names.includes(node)) continue;
    // The smallest block that holds it is the card a person wants selected.
    if (names.length < bestSize) {
      best = path;
      bestSize = names.length;
    }
  }
  return best;
}
