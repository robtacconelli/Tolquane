/**
 * The live run, as far as the canvas needs to know it.
 *
 * F4 owns running a flow: it opens the WebSocket, reads S2's `progress` events and calls
 * `applyProgress` here. This is the shape those events collapse to, and the only thing
 * the canvas reads, so the overlay works the day F4 lands without touching the editor:
 * a card colours its status dot from `nodes[name]`, an edge shows `edges["src->dst"].queued`.
 */

import { create } from 'zustand';
import type { NodeState } from '../components/nodeState';

export type RunStatus = 'idle' | 'running' | 'done' | 'failed';

export interface RunNodeStatus {
  state: NodeState;
  items_in: number;
  items_out: number;
  /** Busy time over elapsed time, 0 to 1: the card draws it as a percentage. */
  busy_share: number;
}

export interface RunEdgeStatus {
  queued: number;
  taps: string[];
}

export interface RunSnapshot {
  status: RunStatus;
  /** Keyed by expanded node name (`double.0`) and by block name (`double`). */
  nodes: Record<string, RunNodeStatus>;
  /** Keyed `src->dst`, as S2 writes them. */
  edges: Record<string, RunEdgeStatus>;
}

export const EMPTY_RUN: RunSnapshot = { status: 'idle', nodes: {}, edges: {} };

export interface RunState extends RunSnapshot {
  /** The run this snapshot belongs to, or `null` before anything has run. */
  runId: number | null;
  setStatus: (status: RunStatus) => void;
  /** F4 calls this with each `progress` event, already reduced to the shape above. */
  applyProgress: (snapshot: Partial<RunSnapshot>) => void;
  start: (runId: number) => void;
  reset: () => void;
}

export const useRunStore = create<RunState>((set) => ({
  ...EMPTY_RUN,
  runId: null,
  setStatus: (status) => set({ status }),
  applyProgress: (snapshot) =>
    set((state) => ({
      status: snapshot.status ?? state.status,
      nodes: snapshot.nodes ?? state.nodes,
      edges: snapshot.edges ?? state.edges,
    })),
  start: (runId) => set({ ...EMPTY_RUN, status: 'running', runId }),
  reset: () => set({ ...EMPTY_RUN, runId: null }),
}));

/**
 * The state of one block on the canvas. A block card stands for every thread the block
 * expands to (`double.0`, `double.1`), so it takes the worst state of the group: failed
 * beats running beats waiting beats new, and it is only done when all of them are.
 */
export function stateOfGroup(
  nodes: Record<string, RunNodeStatus>,
  name: string,
): RunNodeStatus | null {
  const own = nodes[name];
  const members = Object.entries(nodes).filter(
    ([key]) => key === name || key.startsWith(`${name}.`),
  );
  if (members.length === 0) return own ?? null;
  const order: NodeState[] = ['done', 'new', 'waiting', 'running', 'failed'];
  let worst = 0;
  let items_in = 0;
  let items_out = 0;
  let busy = 0;
  let allDone = true;
  for (const [, status] of members) {
    worst = Math.max(worst, order.indexOf(status.state));
    items_in += status.items_in;
    items_out += status.items_out;
    busy += status.busy_share;
    if (status.state !== 'done') allDone = false;
  }
  const state = allDone ? 'done' : (order[worst] ?? 'new');
  return { state, items_in, items_out, busy_share: busy / members.length };
}
