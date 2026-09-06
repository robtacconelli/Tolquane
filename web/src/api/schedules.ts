/**
 * The schedules routes of docs/web-interfaces.md, S4.
 *
 * The types come from the server's OpenAPI through `client.ts`'s `Schemas`; the two
 * unions -- the runtimes and the run statuses -- are what the UI adds, because the
 * server's models spell both as `str`. The wrappers are one line over `request()`.
 */
import { type Complete, type Optional, type Schemas, api } from './client';

export type Runtime = 'threads' | 'processes' | 'sync';

export const RUNTIMES: readonly Runtime[] = ['threads', 'processes', 'sync'];

/** `Run.status` in S3. A schedule only ever shows the status of its last run. */
export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'deadlock';

/**
 * A row of the `schedules` table (S3), the cron in English and its next five times.
 * Every route that answers with a schedule answers with all of it. Times are UTC ISO.
 */
export type ScheduleRow = Omit<Complete<Schemas['ScheduleModel']>, 'runtime' | 'last_status'> & {
  runtime: Runtime;
  last_status: RunStatus | null;
};

/** The stored row on its own: what a dialog needs to fill its fields in. */
export type Schedule = Omit<ScheduleRow, 'description' | 'next_five'>;

/** `POST /api/schedules`; `enabled` has a server-side default. */
export type ScheduleInput = Omit<Optional<Schemas['NewSchedule'], 'enabled'>, 'runtime'> & {
  runtime?: Runtime | null;
};

export type CronPreview = Complete<Schemas['CronPreview']>;

export type ScheduleList = Omit<Complete<Schemas['ScheduleList']>, 'schedules'> & {
  schedules: ScheduleRow[];
};

/** `POST /api/schedules/{id}/run` answers with the whole run; the page shows the id. */
export type StartedRun = Pick<Complete<Schemas['RunModel']>, 'id' | 'flow'> & {
  status: RunStatus;
};

export const listSchedules = (flow?: string) =>
  api.get<ScheduleList>('/schedules', { query: { flow } });

export const createSchedule = (body: ScheduleInput) => api.post<ScheduleRow>('/schedules', body);

export const updateSchedule = (id: number, body: Partial<ScheduleInput>) =>
  api.put<ScheduleRow>(`/schedules/${id}`, body);

export const deleteSchedule = (id: number) => api.delete<Schemas['Ok']>(`/schedules/${id}`);

export const runScheduleNow = (id: number) => api.post<StartedRun>(`/schedules/${id}/run`);

export const previewCron = (cron: string, options?: { signal?: AbortSignal }) =>
  api.post<CronPreview>(
    '/schedules/preview',
    { cron } satisfies Schemas['CronPreviewRequest'],
    options,
  );
