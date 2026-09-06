/**
 * `GET /api/flows`, the list only. The editor's own client (`api/flows.ts`) owns the
 * routes that read and write a flow; the schedules page needs nothing but the names.
 *
 * The types come from the server's OpenAPI (`client.ts`, `Schemas`); the one thing added
 * here is the shape of `last_run`, which the server passes through as a plain object.
 */
import { type Complete, type Schemas, api } from './client';
import type { RunStatus } from './schedules';

/** How a flow last ran, as the list route summarises it. */
export interface LastRun {
  id: number;
  status: RunStatus;
  ended: string | null;
}

export type FlowSummary = Omit<Complete<Schemas['FlowSummary']>, 'last_run'> & {
  last_run: LastRun | null;
};

export type FlowList = Omit<Complete<Schemas['FlowList']>, 'flows'> & { flows: FlowSummary[] };

export const listFlows = () => api.get<FlowList>('/flows');
