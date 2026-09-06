import { beforeEach, describe, expect, it } from 'vitest';
import type { ProgressSnapshot, Run, RunEvent } from '../api/runs';
import type { GraphView } from '../model/types';
import { CONSOLE_LIMIT, EMPTY_RUN, stateOfGroup, useRunStore, type RunNodeStatus } from './run';

function node(state: RunNodeStatus['state'], items = 0, busy = 0): RunNodeStatus {
  return { state, items_in: items, items_out: items, busy_share: busy };
}

function progress(over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    elapsed: 1,
    phase: 'running',
    nodes: {
      numbers: {
        state: 'done',
        reason: '',
        detail: '',
        items_in: 0,
        items_out: 100,
        dropped: 0,
        busy: 0.25,
        wait_in: 0,
        wait_out: 0.1,
      },
      'double.0': {
        state: 'running',
        reason: 'input',
        detail: '',
        items_in: 50,
        items_out: 48,
        dropped: 2,
        busy: 0.5,
        wait_in: 0.2,
        wait_out: 0,
      },
    },
    edges: {
      'numbers->double.emitter': { queued: 12, high_water: 40, capacity: 1024, taps: ['1', '2'] },
    },
    ...over,
  };
}

const GRAPH: GraphView = { nodes: [], edges: [], loops: [], windows: {} };

describe('the run store', () => {
  beforeEach(() => {
    useRunStore.getState().reset();
    useRunStore.getState().setAliases({ nodes: {}, edges: {} });
  });

  it('starts idle and empty', () => {
    const state = useRunStore.getState();
    expect(state.status).toBe('idle');
    expect(state.nodes).toEqual({});
    expect(state.runId).toBeNull();
    expect(state.lines).toEqual([]);
    expect(state.report).toBeNull();
    expect(state.problems).toEqual([]);
  });

  it('takes the snapshots the canvas reads', () => {
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

  it('remembers the options a run was started with', () => {
    useRunStore.getState().start(3, { path: 'hello.py', sample: 'three lines', tap: 5 });
    const { options } = useRunStore.getState();
    expect(options).toMatchObject({ path: 'hello.py', sample: 'three lines', tap: 5 });
    expect(options.runtime).toBe('threads');
  });
});

describe('each event', () => {
  beforeEach(() => {
    useRunStore.getState().reset();
    useRunStore.getState().setAliases({ nodes: {}, edges: {} });
    useRunStore.getState().start(1, { path: 'hello.py' });
  });

  function apply(event: RunEvent): void {
    useRunStore.getState().applyEvent(event);
  }

  it('keeps the graph the run opened with', () => {
    apply({ event: 'start', graph: GRAPH, runtime: 'threads', flow: 'hello.py' });
    expect(useRunStore.getState().graph).toBe(GRAPH);
    expect(useRunStore.getState().status).toBe('running');
  });

  it('turns a progress snapshot into nodes, edges and a clock', () => {
    apply({ event: 'progress', progress: progress() });
    const state = useRunStore.getState();
    expect(state.nodes['double.0']).toMatchObject({
      state: 'running',
      items_in: 50,
      items_out: 48,
      dropped: 2,
      reason: 'input',
    });
    // busy over elapsed: half a second of work in one second.
    expect(state.nodes['double.0']?.busy_share).toBeCloseTo(0.5);
    expect(state.edges['numbers->double.emitter']).toEqual({
      queued: 12,
      high_water: 40,
      capacity: 1024,
      taps: ['1', '2'],
    });
    expect(state.elapsed).toBe(1);
    expect(state.phase).toBe('running');
  });

  it('reads an unknown node state as new rather than believing it', () => {
    apply({
      event: 'progress',
      progress: progress({
        nodes: {
          odd: {
            state: 'levitating',
            reason: '',
            detail: '',
            items_in: 0,
            items_out: 0,
            dropped: 0,
            busy: 0,
            wait_in: 0,
            wait_out: 0,
          },
        },
      }),
    });
    expect(useRunStore.getState().nodes.odd?.state).toBe('new');
  });

  it('splits output into lines and tells the two streams apart', () => {
    apply({ event: 'stdout', text: 'one\ntwo\n' });
    apply({ event: 'stderr', text: 'warning\n' });
    const lines = useRunStore.getState().lines;
    expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'warning']);
    expect(lines.map((line) => line.stream)).toEqual(['stdout', 'stdout', 'stderr']);
    expect(new Set(lines.map((line) => line.id)).size).toBe(3);
  });

  it('bounds the console and says how much it dropped', () => {
    apply({ event: 'stdout', text: `${Array.from({ length: 6000 }, (_, i) => i).join('\n')}\n` });
    const state = useRunStore.getState();
    expect(state.lines).toHaveLength(CONSOLE_LIMIT);
    expect(state.linesDropped).toBe(1000);
    expect(state.lines[0]?.text).toBe('1000');
  });

  it('keeps the report and takes its elapsed as the run’s', () => {
    apply({
      event: 'report',
      report: { runtime: 'threads', elapsed: 2.5, nodes: {}, edges: {}, busiest: ['double.0'] },
    });
    expect(useRunStore.getState().report?.busiest).toEqual(['double.0']);
    expect(useRunStore.getState().elapsed).toBe(2.5);
  });

  it('records a failure with the node it happened on', () => {
    apply({
      event: 'error',
      type: 'NodeError',
      message: "node 'double.1' failed: ValueError: cannot handle 3",
      node: 'double.1',
      traceback: 'Traceback...',
    });
    const problem = useRunStore.getState().problems[0];
    expect(problem).toMatchObject({ kind: 'error', node: 'double.1', type: 'NodeError' });
    expect(problem?.traceback).toBe('Traceback...');
  });

  it('reads the first blocked node out of a deadlock report', () => {
    apply({
      event: 'deadlock',
      message:
        'deadlock: every node is waiting on another one and nothing can make progress\n' +
        "  a: sending to 'b' (queue full, capacity 2)\n" +
        "  b: sending to 'a' (queue full, capacity 2)\n" +
        'fix: raise the capacity of the full edge',
    });
    const problem = useRunStore.getState().problems[0];
    expect(problem).toMatchObject({ kind: 'deadlock', node: 'a', type: 'DeadlockError' });
  });

  it('ends on the status the run reports', () => {
    apply({ event: 'done', status: 'cancelled', elapsed: 3 });
    expect(useRunStore.getState().status).toBe('cancelled');
    expect(useRunStore.getState().elapsed).toBe(3);
  });

  it('does not let a late snapshot reopen a run that has ended', () => {
    apply({ event: 'done', status: 'failed', elapsed: 3 });
    apply({ event: 'progress', progress: progress({ phase: 'running' }) });
    expect(useRunStore.getState().status).toBe('failed');
  });

  it('forgets what a replay will send again', () => {
    apply({ event: 'stdout', text: 'one\n' });
    apply({ event: 'deadlock', message: 'deadlock: ...' });
    useRunStore.getState().rewind();
    const state = useRunStore.getState();
    expect(state.lines).toEqual([]);
    expect(state.problems).toEqual([]);
    expect(state.runId).toBe(1); // the run itself stays
  });
});

describe('aliases', () => {
  beforeEach(() => {
    useRunStore.getState().reset();
  });

  it('adds the canvas keys beside the run’s own', () => {
    useRunStore.getState().setAliases({
      nodes: { 'double farm': ['double.0', 'double.1'] },
      edges: { 'stages.0->stages.1': ['numbers->double.emitter'] },
    });
    useRunStore.getState().applyProgress({
      nodes: {
        'double.0': node('running', 10, 0.4),
        'double.1': node('waiting', 6, 0.2),
      },
      edges: { 'numbers->double.emitter': { queued: 3, taps: ['x'], high_water: 9 } },
    });
    const state = useRunStore.getState();
    expect(state.nodes['double farm']).toMatchObject({
      state: 'running',
      items_out: 16,
    });
    expect(state.nodes['double farm']?.busy_share).toBeCloseTo(0.3);
    expect(state.edges['stages.0->stages.1']).toMatchObject({ queued: 3, taps: ['x'] });
    // The real names are untouched.
    expect(state.nodes['double.0']?.items_out).toBe(10);
  });

  it('sums the edges a block-level edge stands for', () => {
    useRunStore.getState().setAliases({
      nodes: {},
      edges: { 'a->b': ['x->y', 'x->z'] },
    });
    useRunStore.getState().applyProgress({
      edges: {
        'x->y': { queued: 2, taps: ['1'], high_water: 4 },
        'x->z': { queued: 5, taps: ['2'], high_water: 9 },
      },
    });
    expect(useRunStore.getState().edges['a->b']).toMatchObject({
      queued: 7,
      high_water: 9,
      taps: ['1', '2'],
    });
  });
});

describe('loadRun', () => {
  it('shows a run that ended before this page opened', () => {
    const run: Run = {
      id: 4,
      flow: 'boom.py',
      runtime: 'threads',
      sample: null,
      trigger: 'manual',
      started: '2026-09-06T10:00:00Z',
      ended: '2026-09-06T10:00:02Z',
      status: 'failed',
      report: { runtime: 'threads', elapsed: 2, nodes: {}, edges: {}, busiest: [] },
      log: '',
      trace_path: null,
      error: "node 'fragile.0' failed",
      live: false,
    };
    useRunStore.getState().loadRun(run);
    const state = useRunStore.getState();
    expect(state.status).toBe('failed');
    expect(state.report?.elapsed).toBe(2);
    expect(state.problems).toHaveLength(1);
    expect(state.options).toMatchObject({ path: 'boom.py', runtime: 'threads' });
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
