/**
 * The flow tree as React Flow nodes and edges.
 *
 * One block is one node: a leaf is a card, a farm, a loop, a nested pipeline or an
 * all-to-all is a group that holds its children, and an edge between two blocks joins
 * the two nodes, so a nested farm does not need its inner cards to know anything about
 * the outside. Node ids are tree paths (`stages.1.worker`), which is what makes
 * selection, the layout sidecar and the problem list agree on what a card is without a
 * lookup table.
 *
 * Positions of the top-level stages come from the layout sidecar (or from dagre, see
 * `autoLayout.ts`); everything inside a container is placed here, because a farm's
 * emitter is not something a person should have to drag into place.
 */

import type { Edge, Node } from '@xyflow/react';
import {
  blockSubtitle,
  blockTitle,
  cardKind,
  farmBadges,
  farmWorkers,
  isTree,
  joinPath,
  type CardKind,
  type FarmTree,
  type FlowModel,
  type Position,
  type Tree,
} from '../model';
import {
  CARD_H,
  CARD_W,
  COMB_H,
  END_H,
  END_W,
  GAP_IN,
  GAP_Y,
  GROUP_HEADER,
  GROUP_PAD,
  LOOP_SPACE,
  reps as repsOf,
  type Box,
} from './geometry';

export type NodeVariant = 'card' | 'group' | 'end' | 'comb';

export interface CanvasNodeData extends Record<string, unknown> {
  variant: NodeVariant;
  /** The tree path this node stands for; a farm's ends share the farm's path. */
  path: string;
  /**
   * The path a problem would be reported against, or `null` for a node that stands for
   * something the tree does not name: a farm's own emitter is not a block to blame.
   */
  problemPath: string | null;
  kind: CardKind;
  title: string;
  subtitle: string;
  badges: string[];
  /** `emitter` or `collector` for a farm's end cards. */
  role: 'emitter' | 'collector' | null;
  hasInput: boolean;
  hasOutput: boolean;
  /** The two node names a comb fuses. */
  parts: string[];
  /** The name this block has in a run, so the overlay can find it. */
  runKey: string;
}

export type CanvasNode = Node<CanvasNodeData>;

export interface EdgeData extends Record<string, unknown> {
  kind: 'flow' | 'farm' | 'cross' | 'loop';
  /** The `src->dst` key the run store uses for queue depth. */
  runKey: string;
  /** How far under the block a loop edge dips on its way back. */
  dip: number;
}

export type CanvasEdge = Edge<EdgeData>;

export interface BuildResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** The top-level stages, in order: the blocks a person drags, keyed by the sidecar. */
  stages: { path: string; box: Box }[];
}

interface FarmView {
  showEmitter: boolean;
  showCollector: boolean;
  /** How many worker cards to draw for one worker (an all-to-all shows the cross). */
  reps: number;
}

const PLAIN: FarmView = { showEmitter: true, showCollector: true, reps: 1 };

function farmView(farm: FarmTree, override: Partial<FarmView> = {}): FarmView {
  return {
    showEmitter: farm.options.emitter !== false,
    showCollector: farm.options.collector !== false,
    reps: 1,
    ...override,
  };
}

function viewOf(tree: Tree, side: 'left' | 'right'): FarmView {
  if (tree.type !== 'farm') return PLAIN;
  return side === 'left'
    ? farmView(tree, { showCollector: false, reps: repsOf(tree.workers) })
    : farmView(tree, { showEmitter: false, reps: repsOf(tree.workers) });
}

/* --------------------------------------------------------------------- measuring */

/** How big a block is, with everything it contains. A pipeline here is always a nested one. */
export function measure(tree: Tree, model: FlowModel): Box {
  switch (tree.type) {
    case 'ref':
    case 'inline':
    case 'start':
      return { w: CARD_W, h: CARD_H };
    case 'comb':
      return { w: CARD_W, h: COMB_H };
    case 'pipeline': {
      const row = measureRow(tree.stages, model);
      return { w: row.w + 2 * GROUP_PAD, h: GROUP_HEADER + GROUP_PAD + row.h + GROUP_PAD };
    }
    case 'farm':
      return measureFarm(tree, model, farmView(tree));
    case 'feedback': {
      const inner = measure(tree.inner, model);
      return {
        w: inner.w + 2 * GROUP_PAD,
        h: GROUP_HEADER + GROUP_PAD + inner.h + LOOP_SPACE + GROUP_PAD,
      };
    }
    case 'all2all': {
      const parts = all2allParts(tree, model);
      return {
        w: parts.width + 2 * GROUP_PAD,
        h: GROUP_HEADER + GROUP_PAD + parts.height + GROUP_PAD,
      };
    }
    default:
      return { w: CARD_W, h: CARD_H };
  }
}

function measureRow(stages: readonly Tree[], model: FlowModel): Box {
  if (stages.length === 0) return { w: CARD_W, h: CARD_H };
  const boxes = stages.map((stage) => measure(stage, model));
  return {
    w: boxes.reduce((total, box) => total + box.w, 0) + GAP_IN * (boxes.length - 1),
    h: Math.max(...boxes.map((box) => box.h)),
  };
}

function workerColumn(farm: FarmTree, model: FlowModel, view: FarmView): Box {
  const workers = farmWorkers(farm);
  const first: Tree = workers[0] ?? { type: 'inline', source: '' };
  const boxes =
    workers.length > 1
      ? workers.map((worker) => measure(worker, model))
      : new Array<Box>(view.reps).fill(measure(first, model));
  return {
    w: Math.max(...boxes.map((box) => box.w)),
    h: boxes.reduce((total, box) => total + box.h, 0) + GAP_Y * (boxes.length - 1),
  };
}

function measureFarm(farm: FarmTree, model: FlowModel, view: FarmView): Box {
  const column = workerColumn(farm, model, view);
  const width =
    (view.showEmitter ? END_W + GAP_IN : 0) + column.w + (view.showCollector ? GAP_IN + END_W : 0);
  const height = Math.max(column.h, END_H);
  return { w: width + 2 * GROUP_PAD, h: GROUP_HEADER + GROUP_PAD + height + GROUP_PAD };
}

interface All2AllParts {
  left: Box;
  right: Box;
  middle: Box | null;
  width: number;
  height: number;
}

function all2allParts(tree: Tree & { type: 'all2all' }, model: FlowModel): All2AllParts {
  const left =
    tree.left.type === 'farm'
      ? measureFarm(tree.left, model, viewOf(tree.left, 'left'))
      : measure(tree.left, model);
  const right =
    tree.right.type === 'farm'
      ? measureFarm(tree.right, model, viewOf(tree.right, 'right'))
      : measure(tree.right, model);
  const middle = middleOf(tree) ? { w: CARD_W, h: CARD_H } : null;
  return {
    left,
    right,
    middle,
    width: left.w + GAP_IN + (middle ? middle.w + GAP_IN : 0) + right.w,
    height: Math.max(left.h, right.h, middle?.h ?? 0),
  };
}

/** With `merge=True` the two farms meet through one node: `R`, `G`, or both fused. */
function middleOf(tree: Tree & { type: 'all2all' }): Tree | null {
  if (!tree.merge) return null;
  if (tree.R && tree.G) return { type: 'comb', first: tree.R, second: tree.G };
  return tree.R ?? tree.G ?? null;
}

/* ---------------------------------------------------------------------- placing */

interface Ctx {
  model: FlowModel;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const NODE_TYPE: Record<NodeVariant, string> = {
  card: 'blockCard',
  group: 'blockGroup',
  end: 'endCard',
  comb: 'combCard',
};

function push(
  ctx: Ctx,
  id: string,
  variant: NodeVariant,
  path: string,
  box: Box,
  at: Position,
  parent: string | null,
  data: Partial<CanvasNodeData>,
): void {
  ctx.nodes.push({
    id,
    type: NODE_TYPE[variant],
    position: at,
    width: box.w,
    height: box.h,
    draggable: parent === null,
    selectable: true,
    connectable: false,
    deletable: parent === null,
    ...(parent === null ? {} : { parentId: parent, extent: 'parent' as const }),
    data: {
      variant,
      path,
      problemPath: path,
      kind: 'node',
      title: '',
      subtitle: '',
      badges: [],
      role: null,
      hasInput: true,
      hasOutput: true,
      parts: [],
      runKey: '',
      ...data,
    },
  });
}

function link(ctx: Ctx, source: string, target: string, kind: EdgeData['kind'], dip = 0): void {
  ctx.edges.push({
    id: `${source}~${target}~${kind}`,
    source,
    target,
    type: kind === 'loop' ? 'loopEdge' : 'flowEdge',
    data: { kind, runKey: `${source}->${target}`, dip },
  });
}

/** Draw one block at `at`, inside `parent`. The node's id is its tree path. */
function place(
  ctx: Ctx,
  tree: Tree,
  path: string,
  at: Position,
  parent: string | null,
  view: FarmView = PLAIN,
): void {
  const { model } = ctx;
  const box = tree.type === 'farm' ? measureFarm(tree, model, view) : measure(tree, model);
  const common = {
    kind: cardKind(tree, model),
    title: blockTitle(tree, model),
    subtitle: blockSubtitle(tree, model),
  };

  switch (tree.type) {
    case 'pipeline': {
      push(ctx, path, 'group', path, box, at, parent, {
        ...common,
        kind: 'node',
        title: 'pipeline',
        subtitle: `${String(tree.stages.length)} stages, one after another`,
        runKey: 'pipeline',
      });
      placeRow(ctx, tree.stages, path, GROUP_PAD, GROUP_HEADER + GROUP_PAD, path, box.h);
      break;
    }
    case 'farm':
      placeFarm(ctx, tree, path, at, parent, view, box);
      break;
    case 'feedback': {
      push(ctx, path, 'group', path, box, at, parent, {
        ...common,
        badges: ['loops back'],
        runKey: tree.name ?? 'loop',
      });
      place(
        ctx,
        tree.inner,
        joinPath(path, 'inner'),
        { x: GROUP_PAD, y: GROUP_HEADER + GROUP_PAD },
        path,
      );
      const inner = measure(tree.inner, model);
      link(
        ctx,
        joinPath(path, 'inner'),
        joinPath(path, 'inner'),
        'loop',
        inner.h / 2 + LOOP_SPACE * 0.6,
      );
      break;
    }
    case 'all2all':
      placeAll2All(ctx, tree, path, at, parent, box);
      break;
    case 'comb':
      push(ctx, path, 'comb', path, box, at, parent, {
        ...common,
        parts: [blockTitle(tree.first, model), blockTitle(tree.second, model)],
        runKey: `${blockTitle(tree.first, model)}+${blockTitle(tree.second, model)}`,
      });
      break;
    default:
      push(ctx, path, 'card', path, box, at, parent, {
        ...common,
        hasInput: common.kind !== 'source',
        hasOutput: common.kind !== 'sink',
        runKey: tree.type === 'ref' ? tree.id : common.title,
      });
      break;
  }
}

/** A row of stages joined by `>>`, centred on the row's axis. */
function placeRow(
  ctx: Ctx,
  stages: readonly Tree[],
  basePath: string,
  x0: number,
  y0: number,
  parent: string | null,
  boxHeight: number,
): void {
  const rowHeight = boxHeight - y0 - GROUP_PAD;
  let x = x0;
  let previous: string | null = null;
  stages.forEach((stage, index) => {
    const box = measure(stage, ctx.model);
    const path = joinPath(basePath, `stages.${String(index)}`);
    place(ctx, stage, path, { x, y: y0 + (rowHeight - box.h) / 2 }, parent);
    if (previous) link(ctx, previous, path, 'flow');
    previous = path;
    x += box.w + GAP_IN;
  });
}

function placeFarm(
  ctx: Ctx,
  farm: FarmTree,
  path: string,
  at: Position,
  parent: string | null,
  view: FarmView,
  box: Box,
): void {
  const { model } = ctx;
  const farmName = farm.options.name ?? blockTitle(farm, model);
  push(ctx, path, 'group', path, box, at, parent, {
    kind: 'farm',
    title: blockTitle(farm, model),
    subtitle: blockSubtitle(farm, model),
    badges: farmBadges(farm),
    runKey: farmName,
  });

  const column = workerColumn(farm, model, view);
  const contentH = Math.max(column.h, END_H);
  const top = GROUP_HEADER + GROUP_PAD;
  let x = GROUP_PAD;

  let emitterId: string | null = null;
  if (view.showEmitter) {
    const custom = isTree(farm.options.emitter) ? farm.options.emitter : null;
    emitterId = custom ? joinPath(path, 'options.emitter') : `${path}#emitter`;
    push(
      ctx,
      emitterId,
      'end',
      custom ? joinPath(path, 'options.emitter') : path,
      { w: END_W, h: END_H },
      { x, y: top + (contentH - END_H) / 2 },
      path,
      {
        kind: custom ? cardKind(custom, model) : 'node',
        role: 'emitter',
        problemPath: custom ? joinPath(path, 'options.emitter') : null,
        title: custom ? blockTitle(custom, model) : 'emitter',
        subtitle: custom ? 'custom emitter' : emitLabel(farm),
        runKey: `${farmName}.emitter`,
      },
    );
    x += END_W + GAP_IN;
  }

  const workers = farmWorkers(farm);
  const count = workers.length > 1 ? workers.length : view.reps;
  const workerIds: string[] = [];
  let y = top + (contentH - column.h) / 2;
  for (let index = 0; index < count; index += 1) {
    const worker = (workers.length > 1 ? workers[index] : workers[0]) as Tree;
    const workerBox = measure(worker, model);
    const workerPath =
      workers.length > 1 ? joinPath(path, `worker.${String(index)}`) : joinPath(path, 'worker');
    if (index === 0 || workers.length > 1) {
      place(ctx, worker, workerPath, { x, y }, path);
      workerIds.push(workerPath);
    } else {
      // The same worker drawn again, so an all-to-all can show its cross edges.
      const id = `${workerPath}#${String(index)}`;
      push(ctx, id, 'card', workerPath, workerBox, { x, y }, path, {
        kind: cardKind(worker, model),
        title: blockTitle(worker, model),
        subtitle: blockSubtitle(worker, model),
        runKey: `${farmName}.${String(index)}`,
      });
      workerIds.push(id);
    }
    y += workerBox.h + GAP_Y;
  }
  x += column.w + GAP_IN;

  let collectorId: string | null = null;
  if (view.showCollector) {
    const custom = isTree(farm.options.collector) ? farm.options.collector : null;
    collectorId = custom ? joinPath(path, 'options.collector') : `${path}#collector`;
    push(
      ctx,
      collectorId,
      'end',
      custom ? joinPath(path, 'options.collector') : path,
      { w: END_W, h: END_H },
      { x, y: top + (contentH - END_H) / 2 },
      path,
      {
        kind: custom ? cardKind(custom, model) : 'node',
        role: 'collector',
        problemPath: custom ? joinPath(path, 'options.collector') : null,
        title: custom ? blockTitle(custom, model) : 'collector',
        subtitle: custom ? 'custom collector' : collectLabel(farm),
        runKey: `${farmName}.collector`,
      },
    );
  }

  for (const workerId of workerIds) {
    if (emitterId) link(ctx, emitterId, workerId, 'farm');
    if (collectorId) link(ctx, workerId, collectorId, 'farm');
  }
}

function placeAll2All(
  ctx: Ctx,
  tree: Tree & { type: 'all2all' },
  path: string,
  at: Position,
  parent: string | null,
  box: Box,
): void {
  const { model } = ctx;
  push(ctx, path, 'group', path, box, at, parent, {
    kind: 'all2all',
    title: blockTitle(tree, model),
    subtitle: blockSubtitle(tree, model),
    badges: crossBadges(tree),
    runKey: 'all2all',
  });

  const parts = all2allParts(tree, model);
  const top = GROUP_HEADER + GROUP_PAD;
  const leftView = viewOf(tree.left, 'left');
  const rightView = viewOf(tree.right, 'right');
  const leftPath = joinPath(path, 'left');
  const rightPath = joinPath(path, 'right');

  place(
    ctx,
    tree.left,
    leftPath,
    { x: GROUP_PAD, y: top + (parts.height - parts.left.h) / 2 },
    path,
    leftView,
  );
  const rightX = GROUP_PAD + parts.left.w + GAP_IN + (parts.middle ? parts.middle.w + GAP_IN : 0);
  place(
    ctx,
    tree.right,
    rightPath,
    { x: rightX, y: top + (parts.height - parts.right.h) / 2 },
    path,
    rightView,
  );

  const sources = endsOfSide(tree.left, leftPath, leftView, 'out');
  const targets = endsOfSide(tree.right, rightPath, rightView, 'in');

  const middle = middleOf(tree);
  if (middle && parts.middle) {
    const id = `${path}#middle`;
    push(
      ctx,
      id,
      middle.type === 'comb' ? 'comb' : 'card',
      joinPath(path, tree.R ? 'R' : 'G'),
      parts.middle,
      { x: GROUP_PAD + parts.left.w + GAP_IN, y: top + (parts.height - parts.middle.h) / 2 },
      path,
      {
        kind: cardKind(middle, model),
        title: blockTitle(middle, model),
        subtitle:
          middle.type === 'comb'
            ? 'R then G, fused'
            : tree.R
              ? 'R · after each left worker'
              : 'G · before each right worker',
        parts:
          middle.type === 'comb'
            ? [blockTitle(middle.first, model), blockTitle(middle.second, model)]
            : [],
        runKey: blockTitle(middle, model),
      },
    );
    for (const source of sources) link(ctx, source, id, 'cross');
    for (const target of targets) link(ctx, id, target, 'cross');
    return;
  }
  for (const source of sources) {
    for (const target of targets) link(ctx, source, target, 'cross');
  }
}

/** The node ids an all-to-all's cross edges leave from, or arrive at. */
function endsOfSide(side: Tree, path: string, view: FarmView, end: 'in' | 'out'): string[] {
  if (side.type !== 'farm') return [path];
  const workers = farmWorkers(side);
  if (workers.length > 1) return workers.map((_, i) => joinPath(path, `worker.${String(i)}`));
  if (end === 'out' && view.showCollector) return [`${path}#collector`];
  if (end === 'in' && view.showEmitter) return [`${path}#emitter`];
  const workerPath = joinPath(path, 'worker');
  return Array.from({ length: view.reps }, (_, i) =>
    i === 0 ? workerPath : `${workerPath}#${String(i)}`,
  );
}

function crossBadges(tree: Tree & { type: 'all2all' }): string[] {
  const out: string[] = [];
  if (tree.merge) out.push('merge');
  if (tree.R && !tree.merge) out.push('R after each left worker');
  if (tree.G && !tree.merge) out.push('G before each right worker');
  return out;
}

function emitLabel(farm: FarmTree): string {
  if (farm.options.key) return 'by key';
  return farm.options.emit.replace('_', ' ');
}

function collectLabel(farm: FarmTree): string {
  const collect =
    farm.options.collect ??
    (farm.options.ordered ? 'ordered' : farm.options.emit === 'scatter' ? 'gather' : 'first_come');
  return collect.replace('_', ' ');
}

/* ------------------------------------------------------------------------ the top */

/** Every top-level stage: the blocks a person drags, and what the sidecar keys. */
export function topStages(model: FlowModel): { path: string; box: Box }[] {
  const flow = model.flow;
  if (flow.type !== 'pipeline') return [{ path: '', box: measure(flow, model) }];
  return flow.stages.map((stage, index) => ({
    path: `stages.${String(index)}`,
    box: measure(stage, model),
  }));
}

/**
 * The whole canvas for a model, with the top-level stages at `positions` (from the
 * sidecar or from dagre) and everything inside them placed here.
 */
export function buildGraph(model: FlowModel, positions: Record<string, Position>): BuildResult {
  const ctx: Ctx = { model, nodes: [], edges: [] };
  const stages = topStages(model);
  const flow = model.flow;

  if (flow.type !== 'pipeline') {
    place(ctx, flow, '', positions[''] ?? { x: 0, y: 0 }, null);
    return { nodes: ctx.nodes, edges: ctx.edges, stages };
  }

  let previous: string | null = null;
  flow.stages.forEach((stage, index) => {
    const path = `stages.${String(index)}`;
    place(ctx, stage, path, positions[path] ?? { x: 0, y: 0 }, null);
    if (previous) link(ctx, previous, path, 'flow');
    previous = path;
  });

  return { nodes: ctx.nodes, edges: ctx.edges, stages };
}
