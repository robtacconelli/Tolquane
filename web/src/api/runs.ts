/**
 * The run routes of docs/web-interfaces.md, S4, and the event lines of S2.
 *
 * `Run` and `StartRunRequest` come from the server's OpenAPI through `client.ts`'s
 * `Schemas`, narrowed where the server's model says `str` and the UI knows the three
 * runtimes and the five statuses. The report and the events are written out below
 * because the schema does not have them: the report is a plain dict on the wire, and
 * the events never travel over HTTP at all -- they are the JSON lines of `tolquane run
 * --events`, relayed down a WebSocket. So the store and the hook can switch on `event`
 * without re-describing it.
 *
 * Everything else is one line over `request()`, plus the two things a run needs that a
 * REST call cannot give: the WebSocket URL its events arrive on, and the trace link.
 */

import type { GraphView } from '../model/types';
import { API_BASE, type Complete, type Optional, type Schemas, api } from './client';
import type { Runtime } from './schedules';
import { apiToken } from './token';

/** How a run ended, as S2's `done` event and S3's `Run.status` spell it. */
export type RunPhase = 'running' | 'done' | 'failed' | 'cancelled' | 'deadlock';

/** A row of the `runs` table (S3), as `GET /api/runs/{id}` answers it. */
export type Run = Omit<Complete<Schemas['RunModel']>, 'runtime' | 'status' | 'report'> & {
  runtime: Runtime;
  status: RunPhase;
  report: RunReport | null;
};

/** `POST /api/runs`; `tap`, `trace` and `optimize` have server-side defaults. */
export type StartRunRequest = Omit<
  Optional<Schemas['StartRun'], 'tap' | 'trace' | 'optimize'>,
  'runtime'
> & { runtime?: Runtime | null };

/* ------------------------------------------------------------------ the report */

/** One node in `Report.to_dict()`: what it handled and where its time went. */
export interface ReportNode {
  items_in: number;
  items_out: number;
  dropped: number;
  elapsed: number;
  busy: number;
  wait_in: number;
  wait_out: number;
  busy_share: number;
}

export interface RunReport {
  runtime: string;
  elapsed: number;
  nodes: Record<string, ReportNode>;
  /** `src->dst` to the edge's high-water mark. */
  edges: Record<string, number>;
  /** The three nodes with the most busy seconds, the bottleneck first. */
  busiest: string[];
}

/* ------------------------------------------------------------------- the events */

/** One node in a `Progress` snapshot (S2). `state` is one of the five run states. */
export interface ProgressNode {
  state: string;
  reason: string;
  detail: string;
  items_in: number;
  items_out: number;
  dropped: number;
  busy: number;
  wait_in: number;
  wait_out: number;
}

export interface ProgressEdge {
  queued: number;
  high_water: number;
  capacity: number | null;
  /** The last items that crossed, as `repr` cut to 200 characters; empty without `tap`. */
  taps: string[];
}

export interface ProgressSnapshot {
  elapsed: number;
  phase: RunPhase;
  nodes: Record<string, ProgressNode>;
  edges: Record<string, ProgressEdge>;
}

export interface StartEvent {
  event: 'start';
  graph: GraphView;
  runtime: string;
  flow: string;
}
export interface ProgressEvent {
  event: 'progress';
  progress: ProgressSnapshot;
}
export interface OutputEvent {
  event: 'stdout' | 'stderr';
  text: string;
}
export interface ReportEvent {
  event: 'report';
  report: RunReport;
}
export interface ErrorEvent {
  event: 'error';
  type: string;
  message: string;
  /** The node that failed, when the failure has one: the card to point at. */
  node: string | null;
  traceback: string;
}
export interface DeadlockEvent {
  event: 'deadlock';
  message: string;
}
export interface DoneEvent {
  event: 'done';
  status: RunPhase;
  elapsed: number;
}

export type RunEvent =
  StartEvent | ProgressEvent | OutputEvent | ReportEvent | ErrorEvent | DeadlockEvent | DoneEvent;

const EVENT_NAMES = new Set([
  'start',
  'progress',
  'stdout',
  'stderr',
  'report',
  'error',
  'deadlock',
  'done',
]);

/**
 * One WebSocket message as an event, or `null` when it is not one.
 *
 * A run's stream must never be able to break the page: a half-written line, a message
 * from a newer server with an event this build has not heard of, anything at all that is
 * not JSON, is dropped rather than thrown.
 */
export function parseRunEvent(data: unknown): RunEvent | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const name = (value as { event?: unknown }).event;
  if (typeof name !== 'string' || !EVENT_NAMES.has(name)) return null;
  return value as RunEvent;
}

/* ------------------------------------------------------------------ the routes */

/** `GET /api/runs`; every row carries an empty `log`, which can be 64 KB each. */
export type RunList = Omit<Complete<Schemas['RunList']>, 'runs'> & { runs: Run[] };

export const startRun = (body: StartRunRequest) => api.post<Run>('/runs', body);

export const listRuns = (options: { flow?: string; limit?: number } = {}) =>
  api.get<RunList>('/runs', {
    query: { flow: options.flow, limit: options.limit ?? 50 },
  });

export const getRun = (id: number) => api.get<Run>(`/runs/${String(id)}`);

export const cancelRun = (id: number) => api.post<Run>(`/runs/${String(id)}/cancel`);

/** `text/plain`: what the flow printed, live while it runs and from the store after. */
export const getRunLog = (id: number) => api.get<string>(`/runs/${String(id)}/log`);

/*
 * A server started with `--token` wants it on every request, and neither a WebSocket nor
 * a download link can set a header, so those two carry it in the query string instead of
 * the `Authorization` header `client.ts` puts on every other call. `api/token.ts` holds
 * it; without one this is a no-op.
 */
export { apiToken } from './token';

function withToken(url: URL): URL {
  const token = apiToken();
  if (token) url.searchParams.set('token', token);
  return url;
}

/** The download link for a run's Chrome trace; 404 for a run started without one. */
export function runTraceUrl(id: number): string {
  return withToken(
    new URL(`${API_BASE}/runs/${String(id)}/trace`, window.location.href),
  ).toString();
}

/** The socket every event of a run arrives on, replaying the ones already past. */
export function runEventsUrl(id: number): string {
  const url = new URL(`${API_BASE}/runs/${String(id)}/events`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return withToken(url).toString();
}
