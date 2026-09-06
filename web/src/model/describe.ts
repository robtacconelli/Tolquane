/**
 * The words a block wears on the canvas: its title, its subtitle in Tolquane terms and
 * the badges a farm carries. Kept in the model so the palette, the cards, the property
 * panel and the problems list all name a block the same way.
 */

import { farmWorkers, findNode, isHeterogeneous } from './tree';
import type { CollectPolicy, EmitPolicy, FarmTree, FlowModel, Runtime, Tree } from './types';

/** The kinds `components/blockKinds` draws. */
export type CardKind =
  'source' | 'node' | 'sink' | 'raw' | 'farm' | 'comb' | 'feedback' | 'all2all';

export const EMIT_LABEL: Record<EmitPolicy, string> = {
  round_robin: 'round robin',
  on_demand: 'on demand',
  broadcast: 'broadcast',
  scatter: 'scatter',
  key: 'by key',
};

export const COLLECT_LABEL: Record<CollectPolicy, string> = {
  first_come: 'first come',
  round_robin: 'round robin',
  ordered: 'ordered',
  gather: 'gather',
};

export const RUNTIME_LABEL: Record<Runtime, string> = {
  threads: 'threads',
  processes: 'processes',
};

export function cardKind(tree: Tree, model: FlowModel): CardKind {
  switch (tree.type) {
    case 'ref':
      return findNode(model, tree.id)?.kind ?? 'node';
    case 'start':
      return 'source';
    case 'inline':
      return 'raw';
    case 'farm':
      return 'farm';
    case 'comb':
      return 'comb';
    case 'feedback':
      return 'feedback';
    case 'all2all':
      return 'all2all';
    default:
      return 'node';
  }
}

/** The name on the card. */
export function blockTitle(tree: Tree, model: FlowModel): string {
  switch (tree.type) {
    case 'ref':
      return tree.id;
    case 'start':
      return model.start ?? 'start';
    case 'inline':
      return tree.source;
    case 'farm': {
      const workers = farmWorkers(tree);
      const first = workers[0];
      return (
        tree.options.name ??
        (isHeterogeneous(tree) ? 'farm' : first ? `${blockTitle(first, model)} farm` : 'farm')
      );
    }
    case 'comb':
      return `${blockTitle(tree.first, model)} + ${blockTitle(tree.second, model)}`;
    case 'feedback':
      return tree.name ?? 'loop';
    case 'all2all':
      return 'all-to-all';
    default:
      return 'pipeline';
  }
}

/** What it is, in Tolquane terms: `tq.farm · 8 workers`. */
export function blockSubtitle(tree: Tree, model: FlowModel): string {
  switch (tree.type) {
    case 'ref': {
      const node = findNode(model, tree.id);
      if (!node) return 'unknown node';
      const parts = [`tq.${node.kind}`];
      if (node.is_async) parts.push('async');
      if (node.is_class) parts.push('class');
      return parts.join(' · ');
    }
    case 'start':
      return model.start ? 'tq.source · or the run’s sample' : 'the flow’s input';
    case 'inline':
      return 'expression';
    case 'farm': {
      const count = isHeterogeneous(tree)
        ? `${farmWorkers(tree).length} workers, one each`
        : `${tree.workers} ${tree.workers === 1 ? 'worker' : 'workers'}`;
      return `tq.farm · ${count}`;
    }
    case 'comb':
      return 'tq.comb · fused on one thread';
    case 'feedback':
      return 'tq.feedback · outputs wired back';
    case 'all2all': {
      const left = tree.left.type === 'farm' ? tree.left.workers : '?';
      const right = tree.right.type === 'farm' ? tree.right.workers : '?';
      return `tq.all2all · ${String(left)} × ${String(right)}`;
    }
    default:
      return 'pipeline';
  }
}

/** The chips on a farm's header: only what differs from the defaults. */
export function farmBadges(farm: FarmTree): string[] {
  const o = farm.options;
  const out: string[] = [];
  if (o.ordered || o.collect === 'ordered') out.push('ordered');
  if (o.key) out.push('by key');
  else if (o.emit !== 'round_robin') out.push(EMIT_LABEL[o.emit]);
  if (o.collect && o.collect !== 'ordered') out.push(COLLECT_LABEL[o.collect]);
  if (o.emit === 'on_demand' && o.prefetch !== 1) out.push(`prefetch ${String(o.prefetch)}`);
  if (o.window !== null) out.push(`window ${String(o.window)}`);
  if (o.capacity !== null) out.push(`capacity ${String(o.capacity)}`);
  if (o.runtime) out.push(RUNTIME_LABEL[o.runtime]);
  if (o.emitter === false) out.push('no emitter');
  if (o.collector === false) out.push('no collector');
  return out;
}

/** The one-line summary of a node's body, for the properties panel. */
export function nodeSignature(model: FlowModel, id: string): string | null {
  const node = findNode(model, id);
  if (!node) return null;
  const params = node.params.join(', ');
  if (node.is_class) return `class ${node.id}: __call__(${params})`;
  return `${node.is_async ? 'async def' : 'def'} ${node.id}(${params})`;
}
