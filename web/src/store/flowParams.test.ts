import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import { useFlowStore } from './flow';

/* The store actions behind the properties panel's Parameters section. A parameter is a
 * model edit like any other: undoable, and the code is generated again from the model. */

function open(): void {
  const flow = FIXTURES['hello.py'];
  if (!flow) throw new Error('no hello.py fixture');
  useFlowStore.getState().applyServerFlow(flow);
}

describe('build()’s parameters, through the flow store', () => {
  beforeEach(() => {
    useFlowStore.getState().clear();
    open();
  });

  it('starts with the ones the file declares', () => {
    expect(useFlowStore.getState().model?.params).toEqual([]);
  });

  it('adds one with a free name and marks the file as needing generating', () => {
    useFlowStore.getState().addParam();
    const state = useFlowStore.getState();
    expect(state.model?.params).toEqual([{ name: 'value', default: 'None', annotation: null }]);
    expect(state.dirty).toBe(true);
    expect(state.sourceStale).toBe(true);
  });

  it('adds one with the shape the panel chose', () => {
    useFlowStore.getState().addParam({ name: 'factor', default: '2', annotation: 'int' });
    expect(useFlowStore.getState().model?.params[0]).toEqual({
      name: 'factor',
      default: '2',
      annotation: 'int',
    });
  });

  it('renames, retypes and removes', () => {
    const store = useFlowStore.getState();
    store.addParam({ name: 'factor', default: '2', annotation: 'int' });
    useFlowStore.getState().renameParam('factor', 'scale');
    expect(useFlowStore.getState().model?.params[0]?.name).toBe('scale');

    useFlowStore.getState().setParam('scale', { default: '""', annotation: 'str' });
    expect(useFlowStore.getState().model?.params[0]).toEqual({
      name: 'scale',
      default: '""',
      annotation: 'str',
    });

    useFlowStore.getState().removeParam('scale');
    expect(useFlowStore.getState().model?.params).toEqual([]);
  });

  it('is undoable, like every other model edit', () => {
    useFlowStore.getState().addParam({ name: 'factor', default: '2', annotation: 'int' });
    expect(useFlowStore.getState().canUndo()).toBe(true);
    useFlowStore.getState().undo();
    expect(useFlowStore.getState().model?.params).toEqual([]);
    useFlowStore.getState().redo();
    expect(useFlowStore.getState().model?.params[0]?.name).toBe('factor');
  });

  it('does nothing at all when no flow is open', () => {
    useFlowStore.getState().clear();
    useFlowStore.getState().addParam();
    expect(useFlowStore.getState().model).toBeNull();
  });
});
