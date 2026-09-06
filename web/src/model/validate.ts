/**
 * What is wrong with a flow, said the way Tolquane says it.
 *
 * This runs on every keystroke in the properties panel, so it only knows what the tree
 * can tell it: names that do not resolve, a sink with something after it, option
 * combinations `tq.farm` refuses. The real answer comes from `POST /api/flows/{path}/check`,
 * which runs `tq.check` on the generated code; its problems arrive with `source: 'server'`
 * and land in the same list. Messages copy the library's wording, because those already
 * say the fix.
 */

import { children, farmWorkers, findNode, joinPath, ROOT } from './tree';
import type { FarmTree, FlowModel, NodeKind, Tree } from './types';

export interface Problem {
  /** The card this belongs to, or `null` when it is about the flow as a whole. */
  path: string | null;
  message: string;
  severity: 'error' | 'warning';
  source: 'model' | 'server';
}

function problem(
  path: string | null,
  message: string,
  severity: Problem['severity'] = 'error',
): Problem {
  return { path, message, severity, source: 'model' };
}

/**
 * The kind of the node a block starts or ends with, as far as the tree can say. `null`
 * for an expression: an inline block can be anything, and guessing would be worse than
 * saying nothing.
 */
export function terminalKind(tree: Tree, model: FlowModel, end: 'first' | 'last'): NodeKind | null {
  switch (tree.type) {
    case 'ref':
      return findNode(model, tree.id)?.kind ?? null;
    case 'pipeline': {
      const stage = end === 'first' ? tree.stages[0] : tree.stages[tree.stages.length - 1];
      return stage ? terminalKind(stage, model, end) : null;
    }
    case 'farm': {
      const workers = farmWorkers(tree);
      const first = workers[0];
      return first ? terminalKind(first, model, end) : null;
    }
    case 'comb':
      return terminalKind(end === 'first' ? tree.first : tree.second, model, end);
    case 'feedback':
      return terminalKind(tree.inner, model, end);
    case 'all2all':
      return terminalKind(end === 'first' ? tree.left : tree.right, model, end);
    case 'start':
      return 'source';
    default:
      return null; // an inline expression can be anything
  }
}

function label(tree: Tree): string {
  switch (tree.type) {
    case 'ref':
      return tree.id;
    case 'start':
      return 'start';
    case 'inline':
      return tree.source;
    case 'farm':
      return tree.options.name ?? 'the farm';
    case 'feedback':
      return tree.name ?? 'the loop';
    default:
      return `the ${tree.type}`;
  }
}

function farmProblems(farm: FarmTree, path: string, model: FlowModel, out: Problem[]): void {
  const { options: o } = farm;
  const workers = farmWorkers(farm);
  const blockWorker = workers.some((worker) => worker.type !== 'ref' && worker.type !== 'inline');
  const rawWorker = workers.some(
    (worker) => worker.type === 'ref' && findNode(model, worker.id)?.kind === 'raw',
  );

  for (const worker of workers) {
    if (terminalKind(worker, model, 'first') === 'source') {
      out.push(
        problem(
          path,
          `a farm worker must take an item: ${label(worker)} is a source, so it has no input`,
        ),
      );
    }
  }
  if (!Array.isArray(farm.worker) && (!Number.isInteger(farm.workers) || farm.workers < 1)) {
    out.push(problem(path, `workers must be a positive integer, got ${String(farm.workers)}`));
  }
  if (o.key !== null && o.emit !== 'round_robin' && o.emit !== 'key') {
    out.push(
      problem(path, `key= selects workers by key; it cannot be combined with emit='${o.emit}'`),
    );
  }
  if (o.emit === 'key' && o.key === null) {
    out.push(problem(path, "emit='key' needs key=<function of the item>"));
  }
  if (o.ordered && o.collect !== null && o.collect !== 'ordered') {
    out.push(problem(path, "ordered=True already means collect='ordered'; drop one of them"));
  }
  if (o.collect === 'gather' && o.emit !== 'scatter') {
    out.push(problem(path, "collect='gather' pairs with emit='scatter'"));
  }
  const collect =
    o.collect ?? (o.ordered ? 'ordered' : o.emit === 'scatter' ? 'gather' : 'first_come');
  const tagged = collect === 'ordered' || collect === 'gather';
  if (tagged && blockWorker) {
    out.push(
      problem(
        path,
        `collect='${collect}' tags every item through one worker node, so the workers must be ` +
          'plain nodes; make the inner block the ordered farm instead',
      ),
    );
  }
  if (tagged && (o.emitter === false || o.collector === false)) {
    out.push(problem(path, `collect='${collect}' needs both an emitter and a collector`));
  }
  if (tagged && rawWorker) {
    out.push(problem(path, `collect='${collect}' tags every item, so workers cannot be raw nodes`));
  }
  if (o.prefetch < 1) out.push(problem(path, 'prefetch must be at least 1'));
  if (o.window !== null && o.window < 1) out.push(problem(path, 'window must be at least 1'));
  if (o.capacity !== null && o.capacity < 1) {
    out.push(problem(path, 'capacity must be at least 1, or empty for the run default'));
  }
  if (o.runtime === 'processes' && blockWorker) {
    out.push(
      problem(
        path,
        "runtime='processes' on a farm of blocks is ambiguous; put it on the inner farm, or run " +
          "the whole graph with runtime='processes'",
      ),
    );
  }
}

function treeProblems(tree: Tree, path: string, model: FlowModel, out: Problem[]): void {
  switch (tree.type) {
    case 'ref':
      if (!findNode(model, tree.id)) {
        out.push(problem(path, `the flow uses '${tree.id}', which is not one of its nodes`));
      }
      break;
    case 'start':
      if (!model.start) {
        out.push(
          problem(
            path,
            'this flow starts from a source it does not name; pick the node the run starts from',
          ),
        );
      }
      break;
    case 'pipeline': {
      if (tree.stages.length === 0) {
        out.push(
          problem(
            path,
            path === ROOT
              ? 'the flow has no stages yet; drag a block onto the canvas'
              : 'this pipeline has no stages',
            path === ROOT ? 'warning' : 'error',
          ),
        );
      }
      tree.stages.forEach((stage, i) => {
        const stagePath = joinPath(path, `stages.${i}`);
        if (i < tree.stages.length - 1 && terminalKind(stage, model, 'last') === 'sink') {
          out.push(problem(stagePath, `${label(stage)} is a sink: nothing can follow it`));
        }
        if (i > 0 && terminalKind(stage, model, 'first') === 'source') {
          out.push(
            problem(stagePath, `${label(stage)} is a source: it has no input, so it goes first`),
          );
        }
      });
      break;
    }
    case 'farm':
      farmProblems(tree, path, model, out);
      break;
    case 'comb':
      for (const side of [tree.first, tree.second]) {
        if (side.type !== 'ref' && side.type !== 'inline') {
          out.push(
            problem(path, 'comb() fuses plain nodes; farms and pipelines cannot be combined'),
          );
        }
      }
      if (terminalKind(tree.first, model, 'last') === 'sink') {
        out.push(problem(path, `comb(): ${label(tree.first)} is a sink, nothing can follow it`));
      }
      for (const side of [tree.first, tree.second]) {
        const node = side.type === 'ref' ? findNode(model, side.id) : null;
        if (node && (node.kind === 'source' || node.kind === 'raw' || node.is_async)) {
          out.push(
            problem(
              path,
              `comb() cannot fuse ${node.id}; use map, flat or ctx nodes (not coroutines)`,
            ),
          );
        }
      }
      break;
    case 'feedback':
      if (tree.inner.type === 'feedback') {
        out.push(problem(path, 'nested feedback loops are not supported yet'));
      }
      break;
    case 'all2all':
      for (const side of ['left', 'right'] as const) {
        const farm = tree[side];
        if (farm.type !== 'farm') {
          out.push(problem(path, 'all2all() joins two farms: all2all(left_farm, right_farm)'));
        } else if (
          farm.options.ordered ||
          farm.options.collect === 'ordered' ||
          farm.options.collect === 'gather'
        ) {
          out.push(
            problem(path, 'all2all() cannot split an ordered or gather farm; it needs a collector'),
          );
        }
      }
      break;
    default:
      break;
  }

  for (const child of children(tree)) {
    treeProblems(child.tree, joinPath(path, child.key), model, out);
  }
}

/** Everything wrong with the model, worst first, each pointing at the card it is about. */
export function validateModel(model: FlowModel): Problem[] {
  const out: Problem[] = [];
  if (model.start && !findNode(model, model.start)) {
    out.push(problem(null, `the start node '${model.start}' is not one of the flow's nodes`));
  }
  treeProblems(model.flow, ROOT, model, out);
  return out.sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'));
}

/** The problems that belong to one card. */
export function problemsAt(problems: readonly Problem[], path: string): Problem[] {
  return problems.filter((item) => item.path === path);
}

/** A card is in error when it, or anything inside it, is. */
export function worstSeverity(
  problems: readonly Problem[],
  path: string,
): Problem['severity'] | null {
  let worst: Problem['severity'] | null = null;
  for (const item of problems) {
    if (item.path === null) continue;
    if (item.path !== path && !item.path.startsWith(`${path}.`) && path !== ROOT) continue;
    if (item.severity === 'error') return 'error';
    worst = 'warning';
  }
  return worst;
}

/**
 * Which card a message from `tq.check` is about.
 *
 * The server's problems are the library's own words -- "farm worker 'numbers' must take
 * an item" -- so the node they name is in the text. Finding it is worth a little string
 * work: a problem you can see on the card is a problem you can fix.
 */
export function locateProblem(message: string, model: FlowModel): string | null {
  const names = model.nodes.map((node) => node.id).sort((a, b) => b.length - a.length);
  const named = names.find((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(message));
  if (!named) return null;
  const found = walkPaths(model.flow, ROOT).find(
    (entry) => entry.tree.type === 'ref' && entry.tree.id === named,
  );
  return found?.path ?? null;
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkPaths(tree: Tree, path: string): { path: string; tree: Tree }[] {
  const out = [{ path, tree }];
  for (const child of children(tree)) out.push(...walkPaths(child.tree, joinPath(path, child.key)));
  return out;
}
