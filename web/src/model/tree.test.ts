import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import {
  children,
  farmOptions,
  farmWorkers,
  getAt,
  hasPath,
  isHeterogeneous,
  joinPath,
  normalizeModel,
  paths,
  ROOT,
  segments,
  setAt,
  splitPath,
  updateAt,
  walk,
  type FarmTree,
  type FlowModel,
  type Tree,
} from './index';

function model(name: string): FlowModel {
  const raw = FIXTURES[name]?.model;
  if (!raw) throw new Error(`fixture ${name} has no model`);
  return normalizeModel(raw);
}

const MODELS = ['hello.py', 'word_count.py', 'showcase.py', 'newton_sqrt_feedback/flow.py'];

describe('paths', () => {
  it('splits a path into the child keys it names', () => {
    expect(segments(ROOT)).toEqual([]);
    expect(segments('stages.1')).toEqual(['stages.1']);
    expect(segments('stages.1.worker')).toEqual(['stages.1', 'worker']);
    expect(segments('stages.1.options.emitter')).toEqual(['stages.1', 'options.emitter']);
    expect(segments('stages.3.inner.stages.0')).toEqual(['stages.3', 'inner', 'stages.0']);
    expect(segments('left.worker.2')).toEqual(['left', 'worker.2']);
  });

  it('names the parent of a path and the key under it', () => {
    expect(splitPath('stages.1')).toEqual({ parent: ROOT, key: 'stages.1' });
    expect(splitPath('stages.1.worker')).toEqual({ parent: 'stages.1', key: 'worker' });
    expect(splitPath('stages.1.options.emitter')).toEqual({
      parent: 'stages.1',
      key: 'options.emitter',
    });
  });

  it('walks every fixture and finds each block back by its path', () => {
    for (const name of MODELS) {
      const flow = model(name).flow;
      for (const entry of walk(flow)) {
        expect(getAt(flow, entry.path)).toBe(entry.tree);
        expect(hasPath(flow, entry.path)).toBe(true);
      }
      expect(new Set(paths(flow)).size).toBe(paths(flow).length);
    }
  });

  it('gives nothing for a path that names nothing', () => {
    const flow = model('hello.py').flow;
    expect(getAt(flow, 'stages.99')).toBeNull();
    expect(getAt(flow, 'stages.1.nowhere')).toBeNull();
    expect(hasPath(flow, 'stages.1.worker')).toBe(true);
  });
});

describe('children', () => {
  it('lists a farm as its worker and the option blocks it has', () => {
    const flow = model('newton_sqrt_feedback/flow.py').flow;
    const farm = getAt(flow, 'stages.2.inner');
    expect(farm?.type).toBe('farm');
    const keys = children(farm as Tree).map((child) => child.key);
    expect(keys).toContain('worker');
    expect(keys).toContain('options.collector');
  });

  it('lists both sides of an all-to-all', () => {
    const flow = model('showcase.py').flow;
    const cross = getAt(flow, 'stages.2');
    expect(cross?.type).toBe('all2all');
    expect(children(cross as Tree).map((child) => child.key)).toEqual(['left', 'right']);
  });

  it('reads a heterogeneous farm as a list of workers', () => {
    const farm: FarmTree = {
      type: 'farm',
      worker: [
        { type: 'ref', id: 'a' },
        { type: 'ref', id: 'b' },
      ],
      workers: 2,
      options: farmOptions(),
    };
    expect(isHeterogeneous(farm)).toBe(true);
    expect(farmWorkers(farm)).toHaveLength(2);
    expect(children(farm).map((child) => child.key)).toEqual(['worker.0', 'worker.1']);
  });
});

describe('rewriting', () => {
  it('replaces one block and keeps every other by identity', () => {
    const flow = model('word_count.py').flow;
    const next = setAt(flow, 'stages.2.worker', { type: 'ref', id: 'other' });
    expect(getAt(next, 'stages.2.worker')).toEqual({ type: 'ref', id: 'other' });
    expect(getAt(next, 'stages.0')).toBe(getAt(flow, 'stages.0'));
    expect(getAt(next, 'stages.1')).toBe(getAt(flow, 'stages.1'));
    expect(flow).toEqual(model('word_count.py').flow); // the original is untouched
  });

  it('leaves the tree alone when the path names nothing', () => {
    const flow = model('hello.py').flow;
    expect(updateAt(flow, 'stages.9.worker', () => ({ type: 'ref', id: 'x' }))).toBe(flow);
  });

  it('joins paths the way the layout sidecar keys them', () => {
    expect(joinPath(ROOT, 'stages.0')).toBe('stages.0');
    expect(joinPath('stages.0', 'worker')).toBe('stages.0.worker');
  });
});
