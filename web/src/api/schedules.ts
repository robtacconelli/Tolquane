/**
 * The schedules routes of docs/web-interfaces.md, S4.
 *
 * The types are written by hand against that contract and the wrappers are one-liners
 * over `request()`, because both are what the OpenAPI generator will rewrite once the
 * server publishes `/api/openapi.json`.
 */
import { api } from './client';

export type Runtime = 'threads' | 'processes' | 'sync';

export const RUNTIMES: readonly Runtime[] = ['threads', 'processes', 'sync'];

/** `Run.status` in S3. A schedule only ever shows the status of its last run. */
export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'deadlock';

/** A row of the `schedules` table (S3). Times are UTC ISO strings. */
export interface Schedule {
  id: number;
  flow: string;
  cron: string;
  sample: string | null;
  runtime: Runtime;
  enabled: boolean;
  created: string;
  last_run: number | null;
  last_status: RunStatus | null;
  next_run: string | null;
}

/** What the list route adds to every row: the cron in English and its next five times. */
export interface ScheduleRow extends Schedule {
  description: string;
  next_five: string[];
}

export interface ScheduleInput {
  flow: string;
  cron: string;
  sample?: string | null;
  runtime?: Runtime;
  enabled?: boolean;
}

export interface CronPreview {
  description: string;
  next_five: string[];
}

/** `POST /api/schedules/{id}/run` answers with the whole run; the page shows the id. */
export interface StartedRun {
  id: number;
  flow: string;
  status: RunStatus;
}

export const listSchedules = (flow?: string) =>
  api.get<{ schedules: ScheduleRow[] }>('/schedules', { query: { flow } });

export const createSchedule = (body: ScheduleInput) => api.post<Schedule>('/schedules', body);

export const updateSchedule = (id: number, body: Partial<ScheduleInput>) =>
  api.put<Schedule>(`/schedules/${id}`, body);

export const deleteSchedule = (id: number) => api.delete<{ ok: true }>(`/schedules/${id}`);

export const runScheduleNow = (id: number) => api.post<StartedRun>(`/schedules/${id}/run`);

export const previewCron = (cron: string, options?: { signal?: AbortSignal }) =>
  api.post<CronPreview>('/schedules/preview', { cron }, options);
