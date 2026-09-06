import { describe, expect, it } from 'vitest';
import { normalizeModel, type FlowModel, type Position } from '../model';
import { FIXTURES } from '../test/fixtures';
import { autoLayoutStages } from './autoLayout';
import { buildGraph, measure, topStages, type CanvasNode } from './buildGraph';
import { buildExpandedGraph } from './expandedGraph';

const NAMES = [
  'hello.py',
  'word_count.py',
  'showcase.py',
  'newton_sqrt_feedback/flow.py',
  'word_frequency/flow.py',
  'url_status_report/flow.py',
];

function model(name: string): FlowModel {
  const raw = FIXTURES[name]?.model;
  if (!raw) throw new Error(`fixture ${name} has no model`);
  return normalizeModel(raw);
}

function laidOut(name: string): ReturnType<typeof buildGraph> {
  const flow = model(name);
  const positions: Record<string, Position> = autoLayoutStages(topStages(flow));
  return buildGraph(flow, positions);
}

function byId(nodes: CanvasNode[]): Map<string, CanvasNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

describe('buildGraph', () => {
  it('draws every fixture as a well-formed React Flow graph', () => {
    for (const name of NAMES) {
      const { nodes, edges } = laidOut(name);
      const ids = new Set<string>();
      const seen = new Set<string>();

      for (const node of nodes) {
        expect(ids.has(node.id), `${name}: ${node.id} twice`).toBe(false);
        ids.add(node.id);
        expect(node.width).toBeGreaterThan(0);
        expect(node.height).toBeGreaterThan(0);
        if (node.parentId !== undefined) {
          // React Flow needs a parent before its children, and a child inside its box.
          expect(seen.has(node.parentId), `${name}: ${node.id} before its parent`).toBe(true);
          const parent = byId(nodes).get(node.parentId);
          expect(node.position.x).toBeGreaterThanOrEqual(0);
          expect(node.position.y).toBeGreaterThanOrEqual(0);
          expect(node.position.x + (node.width ?? 0)).toBeLessThanOrEqual(
            (parent?.width ?? 0) + 0.5,
          );
          expect(node.position.y + (node.height ?? 0)).toBeLessThanOrEqual(
            (parent?.height ?? 0) + 0.5,
          );
        }
        seen.add(node.id);
      }

      for (const edge of edges) {
        expect(ids.has(edge.source), `${name}: edge from ${edge.source}`).toBe(true);
        expect(ids.has(edge.target), `${name}: edge to ${edge.target}`).toBe(true);
      }
      expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    }
  });

  it('gives the top-level stages one draggable node each', () => {
    const { nodes, stages } = laidOut('word_count.py');
    const roots = nodes.filter((node) => node.parentId === undefined);
    expect(roots.map((node) => node.id)).toEqual(stages.map((stage) => stage.path));
    expect(roots.every((node) => node.draggable)).toBe(true);
    expect(
      nodes.filter((node) => node.parentId !== undefined).every((node) => !node.draggable),
    ).toBe(true);
  });

  it('joins the stages of the pipeline in order', () => {
    const { edges } = laidOut('hello.py');
    const flow = edges.filter((edge) => edge.data?.kind === 'flow');
    expect(flow.map((edge) => [edge.source, edge.target])).toEqual([
      ['stages.0', 'stages.1'],
      ['stages.1', 'stages.2'],
    ]);
  });

  it('draws a farm as its emitter, its worker and its collector', () => {
    const { nodes, edges } = laidOut('hello.py');
    const inside = nodes.filter((node) => node.parentId === 'stages.1');
    expect(inside.map((node) => node.id)).toEqual([
      'stages.1#emitter',
      'stages.1.worker',
      'stages.1#collector',
    ]);
    const farmEdges = edges.filter((edge) => edge.data?.kind === 'farm');
    expect(farmEdges).toHaveLength(2);
    expect(nodes.find((node) => node.id === 'stages.1')?.data.badges).toContain('ordered');
  });

  it('uses a custom collector as the farm end, at its own path', () => {
    const { nodes } = laidOut('newton_sqrt_feedback/flow.py');
    const collector = nodes.find((node) => node.id === 'stages.2.inner.options.collector');
    expect(collector?.data.title).toBe('route');
    expect(collector?.data.subtitle).toBe('custom collector');
  });

  it('draws a feedback loop as a container with an edge back to itself', () => {
    const { nodes, edges } = laidOut('newton_sqrt_feedback/flow.py');
    const loop = nodes.find((node) => node.id === 'stages.2');
    expect(loop?.type).toBe('blockGroup');
    expect(loop?.data.kind).toBe('feedback');
    const back = edges.find((edge) => edge.data?.kind === 'loop');
    expect(back?.source).toBe('stages.2.inner');
    expect(back?.target).toBe('stages.2.inner');
    expect(back?.data?.dip).toBeGreaterThan(0);
  });

  it('draws an all-to-all as two farms with the cross edges between them', () => {
    const { nodes, edges } = laidOut('showcase.py');
    const cross = nodes.find((node) => node.id === 'stages.2');
    expect(cross?.data.kind).toBe('all2all');
    // Three left workers and two right ones, so six crossing edges and no collector on
    // the left, no emitter on the right: that is what all2all removes.
    const crossings = edges.filter((edge) => edge.data?.kind === 'cross');
    expect(crossings).toHaveLength(6);
    expect(nodes.some((node) => node.id === 'stages.2.left#collector')).toBe(false);
    expect(nodes.some((node) => node.id === 'stages.2.right#emitter')).toBe(false);
    expect(nodes.some((node) => node.id === 'stages.2.left#emitter')).toBe(true);
  });

  it('draws a comb as one card naming both nodes', () => {
    const { nodes } = laidOut('showcase.py');
    const comb = nodes.find((node) => node.id === 'stages.1');
    expect(comb?.type).toBe('combCard');
    expect(comb?.data.parts).toEqual(['parse', 'scale']);
  });

  it('measures a container as big as what it holds', () => {
    const flow = model('showcase.py');
    const all2all = topStages(flow).find((stage) => stage.path === 'stages.2');
    const feedback = topStages(flow).find((stage) => stage.path === 'stages.3');
    expect(all2all?.box.w).toBeGreaterThan(measure({ type: 'ref', id: 'x' }, flow).w * 2);
    expect(feedback?.box.h).toBeGreaterThan(measure({ type: 'ref', id: 'x' }, flow).h);
  });

  it('lays the stages out left to right, without overlap', () => {
    const flow = model('word_count.py');
    const stages = topStages(flow);
    const positions = autoLayoutStages(stages);
    const boxes = stages.map((stage) => ({ ...stage, at: positions[stage.path] as Position }));
    for (let i = 1; i < boxes.length; i += 1) {
      const previous = boxes[i - 1];
      const current = boxes[i];
      expect(current?.at.x).toBeGreaterThanOrEqual((previous?.at.x ?? 0) + (previous?.box.w ?? 0));
    }
  });
});

describe('the expanded graph', () => {
  it('draws every thread and every edge of the graph view', () => {
    for (const name of [...NAMES, 'som.py']) {
      const graph = FIXTURES[name]?.graph;
      if (!graph) continue;
      const { nodes, edges } = buildExpandedGraph(graph);
      expect(nodes).toHaveLength(graph.nodes.length);
      expect(edges).toHaveLength(graph.edges.length);
      expect(nodes.every((node) => node.draggable === false)).toBe(true);
      const ids = new Set(nodes.map((node) => node.id));
      for (const edge of edges) {
        expect(ids.has(edge.source)).toBe(true);
        expect(ids.has(edge.target)).toBe(true);
      }
    }
  });

  it('draws a farm’s ends as end cards and its workers as block cards', () => {
    const graph = FIXTURES['word_count.py']?.graph;
    const { nodes } = buildExpandedGraph(graph!);
    expect(nodes.find((node) => node.id === 'words.emitter')?.type).toBe('endCard');
    expect(nodes.find((node) => node.id === 'words.0')?.type).toBe('blockCard');
    expect(nodes.find((node) => node.id === 'words.0')?.data.subtitle).toMatch(/worker of words/);
  });

  it('marks the feedback edges so they are drawn back', () => {
    const graph = FIXTURES['newton_sqrt_feedback/flow.py']?.graph;
    const { edges } = buildExpandedGraph(graph!);
    expect(edges.some((edge) => edge.type === 'loopEdge')).toBe(true);
  });
});
