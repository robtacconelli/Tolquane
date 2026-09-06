import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import {
  appendStage,
  insertBefore,
  layoutAfterEdit,
  moveStage,
  normalizeModel,
  pathRenames,
  pathsAfterEdit,
  removeAt,
  unwrap,
  wrapInFarm,
  type FlowModel,
  type Position,
  type Tree,
} from './index';

function model(name: string): FlowModel {
  const raw = FIXTURES[name]?.model;
  if (!raw) throw new Error(`fixture ${name} has no model`);
  return normalizeModel(raw);
}

/** A position per top-level stage, the way the sidecar keys them. */
function positionsFor(tree: Tree): Record<string, Position> {
  if (tree.type !== 'pipeline') return { '': { x: 0, y: 0 } };
  const out: Record<string, Position> = {};
  tree.stages.forEach((_stage, index) => {
    out[`stages.${String(index)}`] = { x: index * 300, y: 0 };
  });
  return out;
}

describe('pathsAfterEdit', () => {
  it('moves a card position along with the stage it belongs to', () => {
    const before = model('word_count.py').flow;
    const positions = positionsFor(before);
    const after = insertBefore(before, 'stages.0', { type: 'ref', id: 'new' });

    expect(pathRenames(before, after)).toMatchObject({
      'stages.0': 'stages.1',
      'stages.1': 'stages.2',
      'stages.1.worker': 'stages.2.worker',
      'stages.2': 'stages.3',
      'stages.3': 'stages.4',
    });

    const moved = pathsAfterEdit(before, after, positions);
    expect(moved['stages.1']).toEqual(positions['stages.0']);
    expect(moved['stages.3']).toEqual(positions['stages.2']);
    expect(moved['stages.0']).toBeUndefined(); // the new stage has no position yet
  });

  it('drops the position of a stage that was removed', () => {
    const before = model('word_count.py').flow;
    const positions = positionsFor(before);
    const after = removeAt(before, 'stages.1');
    const moved = pathsAfterEdit(before, after, positions);
    expect(Object.keys(moved)).toHaveLength(Object.keys(positions).length - 1);
    expect(moved['stages.1']).toEqual(positions['stages.2']);
  });

  it('follows a move, in both directions', () => {
    const before = model('word_count.py').flow;
    const positions = positionsFor(before);
    const after = moveStage(before, 'stages.0', 2);
    const moved = pathsAfterEdit(before, after, positions);
    expect(moved['stages.2']).toEqual(positions['stages.0']);
    expect(moved['stages.0']).toEqual(positions['stages.1']);
  });

  it('leaves a wrapped stage where it was: the farm now stands there', () => {
    const before = model('word_count.py').flow;
    const positions = positionsFor(before);
    const after = wrapInFarm(before, 'stages.0');
    const moved = pathsAfterEdit(before, after, positions);
    expect(moved['stages.0']).toEqual(positions['stages.0']);
    expect(moved['stages.0.worker']).toBeUndefined();
    expect(moved['stages.1']).toEqual(positions['stages.1']);
  });

  it('gives a container position to the block that comes out of it', () => {
    const before = wrapInFarm(model('word_count.py').flow, 'stages.0');
    const positions = positionsFor(before);
    const after = unwrap(before, 'stages.0');
    const moved = pathsAfterEdit(before, after, positions);
    expect(moved['stages.0']).toEqual(positions['stages.0']);
  });

  it('leaves untouched positions alone when a stage is appended', () => {
    const before = model('hello.py').flow;
    const positions = positionsFor(before);
    const after = appendStage(before, { type: 'ref', id: 'tail' });
    expect(pathsAfterEdit(before, after, positions)).toEqual(positions);
  });

  it('re-keys a whole sidecar', () => {
    const before = model('word_count.py').flow;
    const layout = {
      version: 1,
      positions: positionsFor(before),
      viewport: { x: 0, y: 0, zoom: 1 },
      samples: [{ name: 'three lines', items: ['a b', 'b c'] }],
    };
    const after = insertBefore(before, 'stages.0', { type: 'ref', id: 'new' });
    const next = layoutAfterEdit(layout, before, after);
    expect(next.samples).toBe(layout.samples);
    expect(next.viewport).toBe(layout.viewport);
    expect(next.positions['stages.1']).toEqual(layout.positions['stages.0']);
  });
});
