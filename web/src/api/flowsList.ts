/**
 * `GET /api/flows`, the list only. The editor's own client (`api/flows.ts`) owns the
 * routes that read and write a flow; the schedules page needs nothing but the names.
 */
import { api } from './client';
import type { RunStatus } from './schedules';

export interface FlowSummary {
  path: string;
  name: string;
  modified: string;
  size: number;
  has_layout: boolean;
  last_run: { id: number; status: RunStatus; ended: string | null } | null;
}

export interface FlowList {
  workspace: string;
  flows: FlowSummary[];
}

export const listFlows = () => api.get<FlowList>('/flows');
