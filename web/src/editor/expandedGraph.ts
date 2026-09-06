/**
 * The expanded graph: the threads that will actually run.
 *
 * The canvas shows blocks, not threads (docs/web.md, decision 2), but a toggle shows
 * what `tq.draw` would: every worker, every emitter and collector, every edge, with the
 * feedback ones drawn back. It is read-only -- there is nothing to edit here, this is
 * the consequence of the blocks -- and it uses the same cards so the eye can follow one
 * view into the other.
 */

import type { GraphView, Position } from '../model';
import type { CardKind } from '../model';
import { autoLayout } from './autoLayout';
import type { CanvasEdge, CanvasNode } from './buildGraph';
import { CARD_H, CARD_W, END_H } from './geometry';

/* Nothing boxes these in, so an end card here is wide enough for `words.collector`. */
const GRAPH_END_W = 172;

function kindOf(node: GraphView['nodes'][number]): CardKind {
  if (node.is_sink) return 'sink';
  if (node.kind === 'source') return 'source';
  if (node.kind === 'raw') return 'raw';
  return 'node';
}

function subtitleOf(node: GraphView['nodes'][number]): string {
  const parts = [node.kind];
  if (node.is_async) parts.push('async');
  if (node.tagged) parts.push('tagged');
  if (node.group && node.role === 'worker') parts.push(`worker of ${node.group}`);
  return parts.join(' · ');
}

/** The expanded graph as React Flow nodes and edges, laid out with dagre. */
export function buildExpandedGraph(graph: GraphView): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const sizes = graph.nodes.map((node) => ({
    id: node.name,
    w: node.role === 'emitter' || node.role === 'collector' ? GRAPH_END_W : CARD_W,
    h: node.role === 'emitter' || node.role === 'collector' ? END_H : CARD_H,
  }));
  const positions: Record<string, Position> = autoLayout(
    sizes,
    graph.edges.map((edge) => ({ source: edge.src, target: edge.dst })),
  );

  const nodes: CanvasNode[] = graph.nodes.map((node, index) => {
    const size = sizes[index] as { id: string; w: number; h: number };
    const end = node.role === 'emitter' || node.role === 'collector';
    return {
      id: node.name,
      type: end ? 'endCard' : 'blockCard',
      position: positions[node.name] ?? { x: 0, y: 0 },
      width: size.w,
      height: size.h,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: {
        variant: end ? ('end' as const) : ('card' as const),
        path: node.name,
        problemPath: null,
        kind: kindOf(node),
        title: node.name,
        subtitle: subtitleOf(node),
        badges: [],
        role: node.role === 'emitter' || node.role === 'collector' ? node.role : null,
        hasInput: node.kind !== 'source',
        hasOutput: !node.is_sink,
        parts: [],
        runKey: node.name,
      },
    };
  });

  const edges: CanvasEdge[] = graph.edges.map((edge, index) => ({
    id: `${edge.src}~${edge.dst}~${String(index)}`,
    source: edge.src,
    target: edge.dst,
    type: edge.feedback ? 'loopEdge' : 'flowEdge',
    data: {
      kind: edge.feedback
        ? ('loop' as const)
        : edge.rule === 'farm'
          ? ('farm' as const)
          : ('flow' as const),
      runKey: `${edge.src}->${edge.dst}`,
      dip: 0,
    },
  }));

  return { nodes, edges };
}
