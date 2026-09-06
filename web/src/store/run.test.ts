import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_RUN, stateOfGroup, useRunStore, type RunNodeStatus } from './run';

function node(state: RunNodeStatus['state'], items = 0, busy = 0): RunNodeStatus {
  return { state, items_in: items, items_out: items, busy_share: busy };
}

describe('the run store', () => {
  beforeEach(() => {
    useRunStore.getState().reset();
  });

  it('starts idle and empty', () => {
    const state = useRunStore.getState();
    expect(state.status).toBe('idle');
    expect(state.nodes).toEqual({});
    expect(state.runId).toBeNull();
  });

  it('takes the snapshots F4 will feed it', () => {
    useRunStore.getState().start(7);
    expect(useRunStore.getState().status).toBe('running');
    useRunStore.getState().applyProgress({
      nodes: { 'double.0': node('running', 40, 0.6) },
      edges: { 'numbers->double.emitter': { queued: 12, taps: ['1', '2'] } },
    });
    const state = useRunStore.getState();
    expect(state.runId).toBe(7);
    expect(state.nodes['double.0']?.items_out).toBe(40);
    expect(state.edges['numbers->double.emitter']?.queued).toBe(12);
    expect(state.status).toBe('running'); // a progress event without a phase changes nothing
  });

  it('resets between runs', () => {
    useRunStore.getState().start(1);
    useRunStore.getState().applyProgress({ nodes: { a: node('done') } });
    useRunStore.getState().reset();
    expect(useRunStore.getState()).toMatchObject(EMPTY_RUN);
  });
});

describe('stateOfGroup', () => {
  const nodes = {
    'double.0': node('done', 10, 0.5),
    'double.1': node('running', 6, 0.9),
    'double.emitter': node('waiting', 16, 0.1),
    other: node('failed', 1, 0),
  };

  it('sums the threads a block expands to and takes the worst state', () => {
    const group = stateOfGroup(nodes, 'double');
    expect(group?.state).toBe('running');
    expect(group?.items_out).toBe(32);
    expect(group?.busy_share).toBeCloseTo(0.5);
  });

  it('is done only when every thread is', () => {
    expect(stateOfGroup({ 'f.0': node('done'), 'f.1': node('done') }, 'f')?.state).toBe('done');
    expect(stateOfGroup({ 'f.0': node('done'), 'f.1': node('new') }, 'f')?.state).toBe('new');
  });

  it('lets a failure win over everything', () => {
    expect(stateOfGroup({ 'f.0': node('running'), 'f.1': node('failed') }, 'f')?.state).toBe(
      'failed',
    );
  });

  it('reads a plain node by its own name', () => {
    expect(stateOfGroup(nodes, 'other')?.state).toBe('failed');
    expect(stateOfGroup(nodes, 'missing')).toBeNull();
  });
});
