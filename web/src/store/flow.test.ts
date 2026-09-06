import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import { getAt, type FlowResponse } from '../model';
import { useFlowStore } from './flow';

function open(name = 'word_count.py'): FlowResponse {
  const flow = FIXTURES[name];
  if (!flow) throw new Error(`no fixture ${name}`);
  const response: FlowResponse = {
    ...flow,
    layout: {
      version: 1,
      positions: { 'stages.0': { x: 0, y: 0 }, 'stages.1': { x: 300, y: 0 } },
      viewport: null,
      samples: [],
    },
  };
  useFlowStore.getState().applyServerFlow(response);
  return response;
}

describe('the flow store', () => {
  beforeEach(() => {
    useFlowStore.getState().clear();
  });

  it('opens what the server sent and starts clean', () => {
    const response = open();
    const state = useFlowStore.getState();
    expect(state.path).toBe(response.path);
    expect(state.model?.name).toBe('word_count');
    expect(state.dirty).toBe(false);
    expect(state.sourceStale).toBe(false);
    expect(state.problems).toEqual([]);
    expect(state.past).toHaveLength(0);
  });

  it('opens a file it cannot model in the threads view, with the reason', () => {
    open('som.py');
    const state = useFlowStore.getState();
    expect(state.model).toBeNull();
    expect(state.codeOnly?.reason).toMatch(/build\(\)/);
    expect(state.expanded).toBe(true);
  });

  it('marks the flow dirty on an edit and re-keys the layout', () => {
    open();
    const store = useFlowStore.getState();
    store.insertBefore('stages.0', { type: 'ref', id: 'lines' });
    const state = useFlowStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.sourceStale).toBe(true);
    expect(state.layout.positions['stages.1']).toEqual({ x: 0, y: 0 });
    expect(state.layout.positions['stages.2']).toEqual({ x: 300, y: 0 });
  });

  it('follows the selection when the block it names moves', () => {
    open();
    useFlowStore.getState().select('stages.1');
    useFlowStore.getState().insertBefore('stages.0', { type: 'ref', id: 'lines' });
    expect(useFlowStore.getState().selected).toBe('stages.2');
  });

  it('drops the selection when its block is deleted', () => {
    open();
    useFlowStore.getState().select('stages.1');
    useFlowStore.getState().removeBlock('stages.1');
    expect(useFlowStore.getState().selected).toBeNull();
  });

  it('changes a farm option and validates as it goes', () => {
    open();
    useFlowStore.getState().setFarmOptions('stages.1', { collect: 'gather' });
    const state = useFlowStore.getState();
    expect(state.problems.map((problem) => problem.message)).toEqual([
      "collect='gather' pairs with emit='scatter'",
    ]);
    expect(state.problems[0]?.path).toBe('stages.1');
  });

  it('undoes and redoes an edit, model and layout together', () => {
    open();
    const before = useFlowStore.getState().model;
    const positions = useFlowStore.getState().layout.positions;

    useFlowStore.getState().setWorkers('stages.1', 9);
    expect(useFlowStore.getState().canUndo()).toBe(true);
    const farm = getAt(useFlowStore.getState().model!.flow, 'stages.1');
    expect(farm?.type === 'farm' && farm.workers).toBe(9);

    useFlowStore.getState().undo();
    expect(useFlowStore.getState().model).toBe(before);
    expect(useFlowStore.getState().layout.positions).toEqual(positions);
    expect(useFlowStore.getState().canRedo()).toBe(true);

    useFlowStore.getState().redo();
    const again = getAt(useFlowStore.getState().model!.flow, 'stages.1');
    expect(again?.type === 'farm' && again.workers).toBe(9);
    expect(useFlowStore.getState().canRedo()).toBe(false);
  });

  it('undoes a whole run of edits, one at a time', () => {
    open();
    const store = useFlowStore.getState();
    store.setWorkers('stages.1', 2);
    store.setWorkers('stages.1', 3);
    store.setWorkers('stages.1', 4);
    expect(useFlowStore.getState().past).toHaveLength(3);
    useFlowStore.getState().undo();
    useFlowStore.getState().undo();
    const farm = getAt(useFlowStore.getState().model!.flow, 'stages.1');
    expect(farm?.type === 'farm' && farm.workers).toBe(2);
  });

  it('undoes a drag, because the drag said when it started', () => {
    open();
    useFlowStore.getState().beginChange();
    useFlowStore.getState().setPosition('stages.0', { x: 999, y: 40 });
    expect(useFlowStore.getState().layout.positions['stages.0']).toEqual({ x: 999, y: 40 });
    useFlowStore.getState().undo();
    expect(useFlowStore.getState().layout.positions['stages.0']).toEqual({ x: 0, y: 0 });
  });

  it('adds a node definition with the block that needs it, in front of the sink', () => {
    open();
    const count = useFlowStore.getState().model!.nodes.length;
    useFlowStore.getState().appendBlock({ type: 'ref', id: 'fresh' }, [
      {
        id: 'fresh',
        kind: 'node',
        is_class: false,
        is_async: false,
        params: ['item'],
        doc: null,
        source: '@tq.node\ndef fresh(item):\n    return item',
      },
    ]);
    const state = useFlowStore.getState();
    expect(state.model?.nodes).toHaveLength(count + 1);
    // word_count ends in the `show` sink, so the new stage goes before it, not after.
    expect(state.selected).toBe('stages.3');
    expect(getAt(state.model!.flow, 'stages.3')).toEqual({ type: 'ref', id: 'fresh' });
    expect(state.problems).toEqual([]);
  });

  it('puts a source at the front of the flow', () => {
    open();
    useFlowStore.getState().appendBlock({ type: 'ref', id: 'other_lines' }, [
      {
        id: 'other_lines',
        kind: 'source',
        is_class: false,
        is_async: false,
        params: [],
        doc: null,
        source: '@tq.source\ndef other_lines():\n    yield from ()',
      },
    ]);
    expect(useFlowStore.getState().selected).toBe('stages.0');
  });

  it('gives a save request only once a flow is open', () => {
    expect(useFlowStore.getState().toSaveRequest()).toBeNull();
    const response = open();
    expect(useFlowStore.getState().toSaveRequest()).toEqual({
      path: response.path,
      source: response.source,
      modified: response.modified,
    });
  });

  it('is clean again after a save, and keeps the new stamp', () => {
    open();
    useFlowStore.getState().setWorkers('stages.1', 5);
    useFlowStore.getState().setSource('# generated');
    useFlowStore.getState().markSaved({ source: '# generated', modified: 'newer' });
    const state = useFlowStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.sourceStale).toBe(false);
    expect(state.toSaveRequest()).toEqual({
      path: state.path,
      source: '# generated',
      modified: 'newer',
    });
  });

  it('keeps server problems until the next edit', () => {
    open();
    useFlowStore
      .getState()
      .setServerProblems([
        { path: 'stages.1', message: 'GraphError: nope', severity: 'error', source: 'server' },
      ]);
    expect(useFlowStore.getState().serverProblems).toHaveLength(1);
    useFlowStore.getState().setWorkers('stages.1', 6);
    expect(useFlowStore.getState().serverProblems).toHaveLength(0);
  });
});
