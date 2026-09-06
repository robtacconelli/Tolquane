/** The five run states of docs/web-interfaces.md, S2, and their labels. */
export type NodeState = 'new' | 'running' | 'waiting' | 'done' | 'failed';

export const NODE_STATES: readonly NodeState[] = ['new', 'running', 'waiting', 'done', 'failed'];

export const NODE_STATE_LABEL: Record<NodeState, string> = {
  new: 'Not started',
  running: 'Running',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
};
