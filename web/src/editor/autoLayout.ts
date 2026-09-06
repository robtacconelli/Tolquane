/**
 * Automatic placement, with dagre.
 *
 * Two jobs: the top-level stages of a flow that has no layout sidecar yet (and the
 * "Tidy up" button), and the expanded graph, which is a real graph and needs a real
 * layout. Dagre rather than elk: the flows people draw here are wide and shallow, dagre
 * handles that in a few milliseconds and costs a fifth of elk's bytes.
 *
 * Dagre positions a node by its centre; React Flow positions it by its top-left corner.
 */

import dagre from 'dagre';
import type { Position } from '../model';
import { GAP_X, GAP_Y } from './geometry';

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutOptions {
  /** Left to right, like the `>>` that made it. */
  rankdir?: 'LR' | 'TB';
  /** Between ranks (stages) and within a rank. */
  ranksep?: number;
  nodesep?: number;
  origin?: Position;
}

export function autoLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): Record<string, Position> {
  const { rankdir = 'LR', ranksep = GAP_X, nodesep = GAP_Y * 2, origin = { x: 0, y: 0 } } = options;

  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir, ranksep, nodesep, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: node.w, height: node.h });
  let index = 0;
  for (const edge of edges) {
    if (edge.source === edge.target) continue; // a feedback loop is not a rank
    graph.setEdge(edge.source, edge.target, {}, `e${String(index)}`);
    index += 1;
  }
  dagre.layout(graph);

  const positions: Record<string, Position> = {};
  for (const node of nodes) {
    const placed = graph.node(node.id) as { x?: number; y?: number } | undefined;
    positions[node.id] = {
      x: origin.x + (placed?.x ?? 0) - node.w / 2,
      y: origin.y + (placed?.y ?? 0) - node.h / 2,
    };
  }
  return positions;
}

/** The top-level stages of a pipeline, laid out left to right and centred on one axis. */
export function autoLayoutStages(
  stages: readonly { path: string; box: { w: number; h: number } }[],
): Record<string, Position> {
  const nodes = stages.map((stage) => ({ id: stage.path, w: stage.box.w, h: stage.box.h }));
  const edges = stages
    .slice(1)
    .map((stage, index) => ({ source: stages[index]?.path ?? '', target: stage.path }));
  return autoLayout(nodes, edges);
}
