/**
 * What the palette drops on the canvas.
 *
 * A block on the canvas is a block in the file, so dropping a "Node" has to write a
 * Python function as well as a stage: these are the bodies it writes, in the house style
 * of `docs/style.md` -- one definition per node, a comment saying why it is shaped that
 * way, and nothing a person then has to delete.
 */

import { farmOptions } from './tree';
import type { CardKind } from './describe';
import type { FlowModel, NodeDef, NodeKind, Tree } from './types';

export interface PaletteItem {
  kind: CardKind;
  label: string;
  hint: string;
}

export const PALETTE: readonly PaletteItem[] = [
  { kind: 'source', label: 'Source', hint: 'Produces items. No inputs.' },
  { kind: 'node', label: 'Node', hint: 'Takes an item, returns or yields what to send.' },
  { kind: 'sink', label: 'Sink', hint: 'Consumes items. No outputs.' },
  { kind: 'farm', label: 'Farm', hint: 'Emitter, N workers and a collector.' },
  { kind: 'comb', label: 'Comb', hint: 'Fuse two nodes onto one thread.' },
  { kind: 'feedback', label: 'Feedback', hint: 'Wire a block’s outputs back to its inputs.' },
  { kind: 'all2all', label: 'All-to-all', hint: 'Every left worker to every right worker.' },
  { kind: 'raw', label: 'Raw', hint: 'Full control: read and send yourself.' },
];

const BODIES: Record<NodeKind, (id: string) => string> = {
  source: (id) =>
    `@tq.source\ndef ${id}():\n    # The stream to process: any iterable works.\n    yield from range(10)`,
  node: (id) =>
    `@tq.node\ndef ${id}(item):\n    # Pure and stateless, so several workers can run it at once.\n    return item`,
  sink: (id) => `@tq.sink\ndef ${id}(item) -> None:\n    print(item)`,
  raw: (id) =>
    `@tq.raw\ndef ${id}(ctx) -> None:\n    # Full control: read what arrives, send what should go on.\n    for _src, item in ctx.inputs():\n        ctx.send(item)`,
};

const DEFAULT_ID: Record<NodeKind, string> = {
  source: 'rows',
  node: 'stage',
  sink: 'show',
  raw: 'gate',
};

/** A name no node in the flow has yet: `stage`, then `stage_2`, `stage_3`. */
export function freshId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${String(Date.now())}`;
}

export function newNodeDef(kind: NodeKind, id: string): NodeDef {
  return {
    id,
    kind,
    is_class: false,
    is_async: false,
    params: kind === 'source' ? [] : ['item'],
    doc: null,
    source: BODIES[kind](id),
  };
}

export interface NewBlock {
  /** The node definitions the file gains. */
  nodes: NodeDef[];
  /** The stage the tree gains. */
  block: Tree;
}

/** What dropping one palette item on the canvas adds to the flow. */
export function templateFor(kind: CardKind, model: FlowModel): NewBlock {
  const taken = new Set(model.nodes.map((node) => node.id));
  const make = (nodeKind: NodeKind, base = DEFAULT_ID[nodeKind]): NodeDef => {
    const def = newNodeDef(nodeKind, freshId(base, taken));
    taken.add(def.id);
    return def;
  };

  switch (kind) {
    case 'source':
    case 'node':
    case 'sink':
    case 'raw': {
      const def = make(kind);
      return { nodes: [def], block: { type: 'ref', id: def.id } };
    }
    case 'farm': {
      const def = make('node', 'work');
      return {
        nodes: [def],
        block: {
          type: 'farm',
          worker: { type: 'ref', id: def.id },
          workers: 4,
          options: farmOptions(),
        },
      };
    }
    case 'comb': {
      const first = make('node', 'parse');
      const second = make('node', 'scale');
      return {
        nodes: [first, second],
        block: {
          type: 'comb',
          first: { type: 'ref', id: first.id },
          second: { type: 'ref', id: second.id },
        },
      };
    }
    case 'feedback': {
      const def = make('node', 'refine');
      const route: NodeDef = {
        ...newNodeDef('node', freshId('route', taken)),
        params: ['item', 'ctx'],
      };
      route.source =
        `@tq.node\ndef ${route.id}(item, ctx) -> None:\n` +
        `    # The loop's last stage: send results out, send the rest round again.\n` +
        `    if item:\n        ctx.send(item)\n    else:\n        ctx.feedback(item)`;
      taken.add(route.id);
      return {
        nodes: [def, route],
        block: {
          type: 'feedback',
          inner: {
            type: 'pipeline',
            stages: [
              { type: 'ref', id: def.id },
              { type: 'ref', id: route.id },
            ],
          },
          name: null,
        },
      };
    }
    case 'all2all': {
      const left = make('node', 'shard');
      const right = make('node', 'reduce');
      return {
        nodes: [left, right],
        block: {
          type: 'all2all',
          left: {
            type: 'farm',
            worker: { type: 'ref', id: left.id },
            workers: 2,
            options: farmOptions(),
          },
          right: {
            type: 'farm',
            worker: { type: 'ref', id: right.id },
            workers: 2,
            options: farmOptions(),
          },
          R: null,
          G: null,
          merge: false,
        },
      };
    }
    default: {
      const def = make('node');
      return { nodes: [def], block: { type: 'ref', id: def.id } };
    }
  }
}
