/**
 * The live run: what the canvas overlays, what the drawer shows and what the Run button
 * knows about the child process at the other end of the socket.
 *
 * Every event line of `docs/web-interfaces.md`, S2, goes through `applyEvent`, which is
 * the only place the wire format is read. Nothing here talks to the server:
 * `src/hooks/useRunEvents.ts` owns the socket and `src/api/runs.ts` the routes, so this
 * store is a pure reducer and can be tested one event at a time.
 *
 * The canvas reads `nodes` and `edges` and nothing else, keyed the way a run names
 * things (`double.0`, `numbers->double.emitter`). `edges` also carries the aliases the
 * block view needs -- a card standing for a whole farm has no edge of its own -- which
 * `setEdgeAliases` supplies from the flow model.
 */

import { create } from 'zustand';
import type { Runtime } from '../api/schedules';
import type { ProgressSnapshot, Run, RunEvent, RunPhase, RunReport } from '../api/runs';
import type { NodeState } from '../components/nodeState';
import type { GraphView } from '../model/types';
import { NO_ALIASES, type RunAliases } from '../run/keys';

/** `idle` before anything has run; afterwards the run's own status. */
export type RunStatus = 'idle' | RunPhase;

export interface RunNodeStatus {
  state: NodeState;
  items_in: number;
  items_out: number;
  /** Busy time over elapsed time, 0 to 1: the card draws it as a percentage. */
  busy_share: number;
  /** The rest of S2's `NodeProgress`, for the report table and the tooltips. */
  dropped?: number;
  busy?: number;
  wait_in?: number;
  wait_out?: number;
  /** Why the node is waiting: `input`, `output`, `window`. */
  reason?: string;
  detail?: string;
}

export interface RunEdgeStatus {
  queued: number;
  taps: string[];
  high_water?: number;
  capacity?: number | null;
}

/** One line of the flow's output, kept in order and bounded. */
export interface ConsoleLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

/** A failure or a deadlock, pointing at the card that caused it. */
export interface RunProblem {
  id: number;
  kind: 'error' | 'deadlock';
  /** `NodeError`, `DeadlockError`, whatever the run called it. */
  type: string;
  message: string;
  /** The run name of the node that failed, or `null` for a whole-run failure. */
  node: string | null;
  traceback: string | null;
}

/** What the Run button was set to when it started; a re-run repeats exactly this. */
export interface RunOptions {
  path: string | null;
  runtime: Runtime;
  /** The name of a sample in the layout sidecar, or `null` for the flow's own source. */
  sample: string | null;
  tap: number;
  trace: boolean;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  path: null,
  runtime: 'threads',
  sample: null,
  tap: 5,
  trace: false,
};

/** The socket's own state, so the drawer can say when it is not listening. */
export type RunConnection = 'idle' | 'connecting' | 'open' | 'closed';

export interface RunSnapshot {
  status: RunStatus;
  /** Keyed by expanded node name (`double.0`) and by block name (`double`). */
  nodes: Record<string, RunNodeStatus>;
  /** Keyed `src->dst`, as S2 writes them. */
  edges: Record<string, RunEdgeStatus>;
}

/** How many lines of output are kept; older ones fall off the front. */
export const CONSOLE_LIMIT = 5000;

export const EMPTY_RUN: RunSnapshot = { status: 'idle', nodes: {}, edges: {} };

const EMPTY_STATE = {
  ...EMPTY_RUN,
  runId: null,
  options: DEFAULT_RUN_OPTIONS,
  phase: null,
  elapsed: 0,
  startedAt: null,
  graph: null,
  lines: [],
  linesDropped: 0,
  report: null,
  problems: [],
  selectedEdge: null,
  connection: 'idle',
} satisfies Omit<RunState, keyof RunActions | 'aliases'>;

interface RunActions {
  setStatus: (status: RunStatus) => void;
  /** Each `progress` event, already reduced to the shape above. */
  applyProgress: (snapshot: Partial<RunSnapshot>) => void;
  /** The one door the wire format comes through. */
  applyEvent: (event: RunEvent) => void;
  /** Begin a run: everything from the last one goes, the options are remembered. */
  start: (runId: number, options?: Partial<RunOptions>) => void;
  /** Show a run that ended before this page opened: its report, status and error. */
  loadRun: (run: Run) => void;
  reset: () => void;
  /** Empty what a replay will send again: the console, the problems, the report. */
  rewind: () => void;
  clearConsole: () => void;
  selectEdge: (key: string | null) => void;
  setConnection: (connection: RunConnection) => void;
  /**
   * The canvas names blocks, a run names threads. A card for a farm covers
   * `double.emitter`, `double.0`, `double.collector`, so the edge into it is really
   * several edges; the canvas asks for one key and gets their sum. `src/run/keys.ts`
   * works the map out from the flow model and the expanded graph.
   */
  setAliases: (aliases: RunAliases) => void;
}

export interface RunState extends RunSnapshot, RunActions {
  /** The run this snapshot belongs to, or `null` before anything has run. */
  runId: number | null;
  options: RunOptions;
  /** The phase of the last `progress` event; `null` until the first one. */
  phase: RunPhase | null;
  elapsed: number;
  /** `Date.now()` when the run started, for a clock that ticks between snapshots. */
  startedAt: number | null;
  /** The expanded graph the run reported at its start. */
  graph: GraphView | null;
  lines: ConsoleLine[];
  /** How many lines fell off the front of the console. */
  linesDropped: number;
  report: RunReport | null;
  problems: RunProblem[];
  /** The edge whose tapped items the drawer is showing. */
  selectedEdge: string | null;
  connection: RunConnection;
  aliases: RunAliases;
}

/** A state a run reports for a node, or `new` for anything this build does not know. */
function nodeState(value: string): NodeState {
  return value === 'running' ||
    value === 'waiting' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'new'
    ? value
    : 'new';
}

function present<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

/** The canvas keys, added alongside the real ones so the overlay finds both. */
function withAliases(
  nodes: Record<string, RunNodeStatus>,
  edges: Record<string, RunEdgeStatus>,
  aliases: RunAliases,
): { nodes: Record<string, RunNodeStatus>; edges: Record<string, RunEdgeStatus> } {
  const outNodes: Record<string, RunNodeStatus> = { ...nodes };
  for (const [key, names] of Object.entries(aliases.nodes)) {
    const parts = present(names.map((name) => nodes[name]));
    if (parts.length === 0) continue;
    outNodes[key] = mergeNodes(parts);
  }
  const outEdges: Record<string, RunEdgeStatus> = { ...edges };
  for (const [key, names] of Object.entries(aliases.edges)) {
    const parts = present(names.map((name) => edges[name]));
    if (parts.length === 0) continue;
    outEdges[key] = {
      queued: parts.reduce((total, part) => total + part.queued, 0),
      high_water: parts.reduce((most, part) => Math.max(most, part.high_water ?? 0), 0),
      capacity: parts[0]?.capacity ?? null,
      taps: parts.flatMap((part) => part.taps),
    };
  }
  return { nodes: outNodes, edges: outEdges };
}

/** Several threads read as one card: the worst state, the sum, the average busy share. */
function mergeNodes(parts: RunNodeStatus[]): RunNodeStatus {
  const order: NodeState[] = ['done', 'new', 'waiting', 'running', 'failed'];
  let worst = 0;
  let allDone = true;
  const merged: RunNodeStatus = {
    state: 'new',
    items_in: 0,
    items_out: 0,
    busy_share: 0,
    dropped: 0,
    busy: 0,
    wait_in: 0,
    wait_out: 0,
  };
  for (const part of parts) {
    worst = Math.max(worst, order.indexOf(part.state));
    if (part.state !== 'done') allDone = false;
    merged.items_in += part.items_in;
    merged.items_out += part.items_out;
    merged.busy_share += part.busy_share;
    merged.dropped = (merged.dropped ?? 0) + (part.dropped ?? 0);
    merged.busy = (merged.busy ?? 0) + (part.busy ?? 0);
    merged.wait_in = (merged.wait_in ?? 0) + (part.wait_in ?? 0);
    merged.wait_out = (merged.wait_out ?? 0) + (part.wait_out ?? 0);
  }
  merged.busy_share /= parts.length;
  merged.state = allDone ? 'done' : (order[worst] ?? 'new');
  return merged;
}

/** A `progress` snapshot as the canvas and the drawer read it. */
function fromProgress(progress: ProgressSnapshot): RunSnapshot {
  const nodes: Record<string, RunNodeStatus> = {};
  for (const [name, node] of Object.entries(progress.nodes)) {
    const span = progress.elapsed > 0 ? progress.elapsed : 1;
    nodes[name] = {
      state: nodeState(node.state),
      items_in: node.items_in,
      items_out: node.items_out,
      busy_share: Math.min(1, node.busy / span),
      dropped: node.dropped,
      busy: node.busy,
      wait_in: node.wait_in,
      wait_out: node.wait_out,
      reason: node.reason,
      detail: node.detail,
    };
  }
  const edges: Record<string, RunEdgeStatus> = {};
  for (const [key, edge] of Object.entries(progress.edges)) {
    edges[key] = {
      queued: edge.queued,
      taps: edge.taps,
      high_water: edge.high_water,
      capacity: edge.capacity,
    };
  }
  const status: RunStatus = progress.phase;
  return { status, nodes, edges };
}

/** Split a chunk of output into console lines, keeping the console bounded. */
function appendLines(
  state: Pick<RunState, 'lines' | 'linesDropped'>,
  stream: 'stdout' | 'stderr',
  text: string,
): Pick<RunState, 'lines' | 'linesDropped'> {
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop(); // a trailing newline is not a line
  if (parts.length === 0) return state;
  let nextId = (state.lines[state.lines.length - 1]?.id ?? 0) + 1;
  const lines = state.lines.concat(parts.map((line) => ({ id: nextId++, stream, text: line })));
  const over = lines.length - CONSOLE_LIMIT;
  if (over <= 0) return { lines, linesDropped: state.linesDropped };
  return { lines: lines.slice(over), linesDropped: state.linesDropped + over };
}

function problem(state: Pick<RunState, 'problems'>, next: Omit<RunProblem, 'id'>): RunProblem[] {
  const id = (state.problems[state.problems.length - 1]?.id ?? 0) + 1;
  return [...state.problems, { ...next, id }];
}

export const useRunStore = create<RunState>((set) => ({
  ...EMPTY_STATE,
  aliases: NO_ALIASES,

  setStatus: (status) => set({ status }),

  applyProgress: (snapshot) =>
    set((state) => ({
      status: snapshot.status ?? state.status,
      ...withAliases(snapshot.nodes ?? state.nodes, snapshot.edges ?? state.edges, state.aliases),
    })),

  applyEvent: (event) =>
    set((state) => {
      switch (event.event) {
        case 'start':
          return { graph: event.graph, status: 'running' };
        case 'progress': {
          const snapshot = fromProgress(event.progress);
          return {
            ...withAliases(snapshot.nodes, snapshot.edges, state.aliases),
            // The final snapshot carries the phase the run ended in; `done` has the
            // last word, so a status already settled is never reopened.
            status: state.status === 'running' ? snapshot.status : state.status,
            phase: event.progress.phase,
            elapsed: event.progress.elapsed,
          };
        }
        case 'stdout':
        case 'stderr':
          return appendLines(state, event.event, event.text);
        case 'report':
          return { report: event.report, elapsed: event.report.elapsed };
        case 'error':
          return {
            problems: problem(state, {
              kind: 'error',
              type: event.type,
              message: event.message,
              // A run that is not the supervisor's answers with an `error` of its own,
              // which carries neither of these.
              node: event.node ?? null,
              traceback: event.traceback ?? null,
            }),
          };
        case 'deadlock':
          return {
            problems: problem(state, {
              kind: 'deadlock',
              type: 'DeadlockError',
              message: event.message,
              node: deadlockNode(event.message),
              traceback: null,
            }),
          };
        case 'done':
          return { status: event.status, phase: event.status, elapsed: event.elapsed };
      }
    }),

  start: (runId, options) =>
    set((state) => ({
      ...EMPTY_STATE,
      runId,
      status: 'running',
      startedAt: Date.now(),
      options: { ...state.options, ...options },
      connection: 'connecting',
    })),

  loadRun: (run) =>
    set((state) => ({
      ...EMPTY_STATE,
      runId: run.id,
      status: run.status,
      phase: run.status,
      elapsed: run.report?.elapsed ?? 0,
      report: run.report,
      options: {
        path: run.flow,
        runtime: run.runtime,
        sample: run.sample,
        tap: state.options.tap,
        trace: run.trace_path !== null,
      },
      problems: run.error
        ? [
            {
              id: 1,
              kind: run.status === 'deadlock' ? 'deadlock' : 'error',
              type: run.status === 'deadlock' ? 'DeadlockError' : 'RunError',
              message: run.error,
              node: run.status === 'deadlock' ? deadlockNode(run.error) : null,
              traceback: null,
            },
          ]
        : [],
    })),

  reset: () => set({ ...EMPTY_STATE }),

  /**
   * Forget what accumulates, keeping the run. The socket replays a run from its first
   * event whenever it reconnects, so the console, the problems and the report are
   * emptied first and arrive again in order, rather than twice.
   */
  rewind: () => set({ lines: [], linesDropped: 0, problems: [], report: null, graph: null }),

  clearConsole: () => set({ lines: [], linesDropped: 0 }),

  selectEdge: (key) => set({ selectedEdge: key }),

  setConnection: (connection) => set({ connection }),

  setAliases: (aliases) =>
    set((state) => ({ aliases, ...withAliases(state.nodes, state.edges, aliases) })),
}));

/**
 * The first node a deadlock report names. The message lists every blocked node under a
 * headline, `  a: sending to 'b' (queue full, capacity 2)`, and the first is the one
 * worth selecting on the canvas.
 */
function deadlockNode(message: string): string | null {
  for (const line of message.split('\n').slice(1)) {
    const match = /^\s{2}([^\s:][^:]*):\s/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

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

/** True while the child process is still going: the button says Cancel, not Run. */
export function isLive(status: RunStatus): boolean {
  return status === 'running';
}
