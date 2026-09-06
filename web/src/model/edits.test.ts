import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import {
  appendStage,
  cardPaths,
  farmOptions,
  getAt,
  insertAfter,
  insertBefore,
  insertStage,
  moveStage,
  normalizeModel,
  paths,
  removeAt,
  ROOT,
  setFarmOptions,
  setWorkers,
  unwrap,
  validateModel,
  walk,
  wrapInFarm,
  wrapInFeedback,
  type FlowModel,
  type Tree,
} from './index';

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

/** Every tree the canvas can draw has to stay something the code generator can write. */
function wellFormed(tree: Tree): void {
  for (const entry of walk(tree)) {
    const node = entry.tree;
    expect(typeof node.type).toBe('string');
    if (node.type === 'pipeline') expect(Array.isArray(node.stages)).toBe(true);
    if (node.type === 'farm') {
      expect(node.workers).toBeGreaterThanOrEqual(1);
      expect(node.options).toBeTruthy();
      if (Array.isArray(node.worker)) expect(node.worker.length).toBe(node.workers);
    }
    if (node.type === 'comb') expect(node.first && node.second).toBeTruthy();
    if (node.type === 'feedback') expect(node.inner).toBeTruthy();
  }
  expect(new Set(paths(tree)).size).toBe(paths(tree).length);
}

const NEW: Tree = { type: 'ref', id: 'added' };

/** A stage that is not already a farm, so wrapping it in one is a visible change. */
function firstPlainStage(tree: Tree): string {
  if (tree.type !== 'pipeline') return ROOT;
  const index = tree.stages.findIndex((stage) => stage.type !== 'farm');
  return index < 0 ? ROOT : `stages.${String(index)}`;
}

describe('the fixtures themselves', () => {
  it('round-trip through the model types unchanged', () => {
    for (const name of NAMES) {
      const raw = FIXTURES[name]?.model;
      expect(normalizeModel(raw)).toEqual(raw);
    }
  });

  it('are all well formed and, but for the showcase, free of problems', () => {
    for (const name of NAMES) {
      const flow = model(name);
      wellFormed(flow.flow);
      expect(validateModel(flow).filter((p) => p.severity === 'error')).toEqual([]);
    }
  });
});

describe('inserting', () => {
  it('appends to the flow and leaves the other stages where they were', () => {
    for (const name of NAMES) {
      const before = model(name).flow;
      const after = appendStage(before, NEW);
      wellFormed(after);
      expect(after).not.toBe(before);
      if (before.type === 'pipeline') {
        expect(getAt(after, `stages.${String(before.stages.length)}`)).toBe(NEW);
        expect(getAt(after, 'stages.0')).toBe(getAt(before, 'stages.0'));
      }
    }
  });

  it('puts a stage after another and shifts the rest along', () => {
    const before = model('word_count.py').flow;
    const first = getAt(before, 'stages.1');
    const after = insertAfter(before, 'stages.0', NEW);
    expect(getAt(after, 'stages.1')).toBe(NEW);
    expect(getAt(after, 'stages.2')).toBe(first);
    wellFormed(after);
  });

  it('puts a stage before another', () => {
    const before = model('word_count.py').flow;
    const after = insertBefore(before, 'stages.0', NEW);
    expect(getAt(after, 'stages.0')).toBe(NEW);
    wellFormed(after);
  });

  it('makes a pipeline when the block it inserts next to is not in one', () => {
    const before = model('word_count.py').flow;
    const worker = getAt(before, 'stages.1.worker') as Tree;
    const after = insertAfter(before, 'stages.1.worker', NEW);
    const inner = getAt(after, 'stages.1.worker');
    expect(inner?.type).toBe('pipeline');
    expect(getAt(after, 'stages.1.worker.stages.0')).toBe(worker);
    expect(getAt(after, 'stages.1.worker.stages.1')).toBe(NEW);
    wellFormed(after);
  });

  it('inserts into a pipeline at an index, clamping out-of-range ones', () => {
    const before = model('hello.py').flow;
    const after = insertStage(before, ROOT, 99, NEW);
    expect(getAt(after, 'stages.3')).toBe(NEW);
  });
});

describe('removing and moving', () => {
  it('removes a stage and closes the gap', () => {
    const before = model('word_count.py').flow;
    const third = getAt(before, 'stages.2');
    const after = removeAt(before, 'stages.1');
    expect(getAt(after, 'stages.1')).toBe(third);
    wellFormed(after);
  });

  it('removes the pipeline a removal empties, but never the root', () => {
    const wrapped = insertAfter(model('word_count.py').flow, 'stages.1.worker', NEW);
    const back = removeAt(
      removeAt(wrapped, 'stages.1.worker.stages.1'),
      'stages.1.worker.stages.0',
    );
    expect(getAt(back, 'stages.1')?.type).toBe('farm');
    const emptied = removeAt(model('hello.py').flow, ROOT);
    expect(emptied).toEqual({ type: 'pipeline', stages: [] });
  });

  it('moves a stage inside its pipeline', () => {
    const before = model('word_count.py').flow;
    const moved = getAt(before, 'stages.0');
    const after = moveStage(before, 'stages.0', 2);
    expect(getAt(after, 'stages.2')).toBe(moved);
    wellFormed(after);
  });

  it('is its own inverse when a move goes back', () => {
    const before = model('word_count.py').flow;
    expect(moveStage(moveStage(before, 'stages.0', 3), 'stages.3', 0)).toEqual(before);
  });
});

describe('wrapping', () => {
  it('wraps a stage in a farm and unwraps it again', () => {
    for (const name of NAMES) {
      const before = model(name).flow;
      const target = firstPlainStage(before);
      const wrapped = wrapInFarm(before, target, 6);
      const farm = getAt(wrapped, target);
      expect(farm?.type).toBe('farm');
      expect(farm && farm.type === 'farm' ? farm.workers : 0).toBe(6);
      expect(getAt(wrapped, `${target === ROOT ? '' : `${target}.`}worker`)).toBe(
        getAt(before, target),
      );
      wellFormed(wrapped);
      expect(unwrap(wrapped, target)).toEqual(before);
    }
  });

  it('wraps a stage in a feedback loop and unwraps it again', () => {
    const before = model('word_count.py').flow;
    const wrapped = wrapInFeedback(before, 'stages.1', 'retry');
    const loop = getAt(wrapped, 'stages.1');
    expect(loop?.type).toBe('feedback');
    expect(loop && loop.type === 'feedback' ? loop.name : null).toBe('retry');
    expect(unwrap(wrapped, 'stages.1')).toEqual(before);
  });

  it('turns a comb back into the pipeline it fuses', () => {
    const before = model('showcase.py').flow;
    const opened = unwrap(before, 'stages.1');
    expect(getAt(opened, 'stages.1')?.type).toBe('pipeline');
    expect(cardPaths(opened).length).toBeGreaterThan(cardPaths(before).length - 1);
  });
});

describe('options', () => {
  it('changes one option and leaves the others', () => {
    const before = model('word_count.py').flow;
    const after = setFarmOptions(before, 'stages.2', { ordered: true });
    const farm = getAt(after, 'stages.2');
    expect(farm?.type === 'farm' && farm.options.ordered).toBe(true);
    expect(farm?.type === 'farm' && farm.options.key).toEqual(
      (getAt(before, 'stages.2') as { options: { key: unknown } }).options.key,
    );
  });

  it('keeps workers a positive integer', () => {
    const before = model('hello.py').flow;
    expect(
      (getAt(setWorkers(before, 'stages.1', 0), 'stages.1') as { workers: number }).workers,
    ).toBe(1);
    expect(
      (getAt(setWorkers(before, 'stages.1', 12), 'stages.1') as { workers: number }).workers,
    ).toBe(12);
  });

  it('leaves a heterogeneous farm count to its list', () => {
    const farm: Tree = {
      type: 'farm',
      worker: [
        { type: 'ref', id: 'a' },
        { type: 'ref', id: 'b' },
      ],
      workers: 2,
      options: farmOptions(),
    };
    expect(setWorkers({ type: 'pipeline', stages: [farm] }, 'stages.0', 9)).toEqual({
      type: 'pipeline',
      stages: [farm],
    });
  });
});
