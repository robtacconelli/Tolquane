import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import {
  farmOptions,
  locateProblem,
  normalizeModel,
  setFarmOptions,
  validateModel,
  worstSeverity,
  type FlowModel,
  type Tree,
} from './index';

function model(name: string): FlowModel {
  const raw = FIXTURES[name]?.model;
  if (!raw) throw new Error(`fixture ${name} has no model`);
  return normalizeModel(raw);
}

function withFlow(base: FlowModel, flow: Tree): FlowModel {
  return { ...base, flow };
}

function messages(flow: FlowModel): string[] {
  return validateModel(flow).map((problem) => problem.message);
}

describe('validateModel', () => {
  it('says nothing about a flow that is sound', () => {
    expect(validateModel(model('word_count.py'))).toEqual([]);
  });

  it('finds a name the flow does not define', () => {
    const base = model('hello.py');
    const flow = withFlow(base, { type: 'pipeline', stages: [{ type: 'ref', id: 'missing' }] });
    expect(messages(flow)[0]).toMatch(/'missing', which is not one of its nodes/);
  });

  it('puts a sink last and a source first', () => {
    const base = model('hello.py');
    const flow = withFlow(base, {
      type: 'pipeline',
      stages: [
        { type: 'ref', id: 'show' },
        { type: 'ref', id: 'double' },
        { type: 'ref', id: 'numbers' },
      ],
    });
    expect(messages(flow)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/show is a sink: nothing can follow it/),
        expect.stringMatching(/numbers is a source: it has no input/),
      ]),
    );
  });

  it('refuses a source as a farm worker', () => {
    const base = model('hello.py');
    const flow = withFlow(base, {
      type: 'pipeline',
      stages: [
        {
          type: 'farm',
          worker: { type: 'ref', id: 'numbers' },
          workers: 4,
          options: farmOptions(),
        },
      ],
    });
    expect(messages(flow)[0]).toMatch(/farm worker must take an item/);
  });

  it('repeats the library on the option combinations tq.farm refuses', () => {
    const base = model('hello.py');
    const farm = (options: Parameters<typeof farmOptions>[0]): FlowModel =>
      withFlow(base, {
        type: 'pipeline',
        stages: [
          { type: 'ref', id: 'numbers' },
          {
            type: 'farm',
            worker: { type: 'ref', id: 'double' },
            workers: 2,
            options: farmOptions(options),
          },
        ],
      });

    expect(messages(farm({ ordered: true, collect: 'first_come' }))[0]).toMatch(
      /ordered=True already means/,
    );
    expect(messages(farm({ collect: 'gather' }))[0]).toMatch(
      /collect='gather' pairs with emit='scatter'/,
    );
    expect(messages(farm({ emit: 'key' }))[0]).toMatch(/emit='key' needs key=/);
    expect(
      messages(farm({ emit: 'broadcast', key: { type: 'inline', source: 'lambda x: x' } }))[0],
    ).toMatch(/cannot be combined with emit='broadcast'/);
    expect(messages(farm({ prefetch: 0 }))[0]).toMatch(/prefetch must be at least 1/);
    expect(messages(farm({ capacity: 0 }))[0]).toMatch(/capacity must be at least 1/);
    expect(messages(farm({ ordered: true, emitter: false }))[0]).toMatch(/needs both an emitter/);
  });

  it('refuses an ordered farm of blocks, the way expand does', () => {
    const base = model('word_count.py');
    const flow = setFarmOptions(base.flow, 'stages.1', { ordered: true });
    const inner = withFlow(base, flow);
    // words is a plain node, so this one is fine...
    expect(messages(inner)).toEqual([]);
    const blocked = setFarmOptions(
      {
        type: 'pipeline',
        stages: [
          {
            type: 'farm',
            worker: { type: 'pipeline', stages: [{ type: 'ref', id: 'words' }] },
            workers: 2,
            options: farmOptions(),
          },
        ],
      },
      'stages.0',
      { ordered: true },
    );
    expect(messages(withFlow(base, blocked))[0]).toMatch(/tags every item through one worker node/);
  });

  it('warns, rather than errs, about an empty flow', () => {
    const base = model('hello.py');
    const problems = validateModel(withFlow(base, { type: 'pipeline', stages: [] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('warning');
  });

  it('asks for a start node when the flow has a start slot without one', () => {
    const base = { ...model('showcase.py'), start: null };
    expect(messages(base)[0]).toMatch(/starts from a source it does not name/);
  });

  it('rolls a child problem up to the container that holds it', () => {
    const base = model('showcase.py');
    const flow = withFlow(base, {
      type: 'pipeline',
      stages: [{ type: 'feedback', inner: { type: 'ref', id: 'nope' }, name: null }],
    });
    const problems = validateModel(flow);
    expect(worstSeverity(problems, 'stages.0')).toBe('error');
    expect(worstSeverity(problems, 'stages.0.inner')).toBe('error');
  });
});

describe('locateProblem', () => {
  it('finds the card a check message is about', () => {
    const flow = model('word_count.py');
    expect(locateProblem("farm worker 'words' must take an item", flow)).toBe('stages.1.worker');
    expect(locateProblem('the graph has a cycle', flow)).toBeNull();
  });
});
