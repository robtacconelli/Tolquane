/**
 * The schedules routes of docs/web-interfaces.md, S4, and the outcomes of N.
 *
 * The types come from the server's OpenAPI through `client.ts`'s `Schemas`; the three
 * unions -- the runtimes, the run statuses and the four events a schedule notifies on --
 * are what the UI adds, because the server's models spell all three as `str`. The
 * wrappers are one line over `request()`.
 */
import { type Complete, type Optional, type Schemas, api } from './client';

export type Runtime = 'threads' | 'processes' | 'sync';

export const RUNTIMES: readonly Runtime[] = ['threads', 'processes', 'sync'];

/** `Run.status` in S3. A schedule only ever shows the status of its last run. */
export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'deadlock';

/** The four endings a schedule can be told about (N); `running` is not one of them. */
export type NotifyEvent = 'failed' | 'deadlock' | 'cancelled' | 'done';

export const NOTIFY_EVENTS: readonly NotifyEvent[] = ['failed', 'deadlock', 'cancelled', 'done'];

/** Who hears about a run ending, and how. `webhook: null` means the default in settings. */
export type Notify = Omit<Complete<Schemas['Notify']>, 'events'> & { events: NotifyEvent[] };

/** How the last firing went, written after every attempt (N, "as built"). */
export type LastOutcome = Omit<Complete<Schemas['LastOutcome']>, 'status'> & {
  status: RunStatus;
};

/**
 * A row of the `schedules` table (S3), the cron in English and its next five times.
 * Every route that answers with a schedule answers with all of it. Times are UTC ISO.
 */
export type ScheduleRow = Omit<
  Complete<Schemas['ScheduleModel']>,
  'runtime' | 'last_status' | 'notify' | 'last_outcome'
> & {
  runtime: Runtime;
  last_status: RunStatus | null;
  notify: Notify;
  last_outcome: LastOutcome | null;
};

/** The stored row on its own: what a dialog needs to fill its fields in. */
export type Schedule = Omit<ScheduleRow, 'description' | 'next_five'>;

/** `POST /api/schedules`; `enabled`, `retries` and `retry_delay` have server defaults. */
export type ScheduleInput = Omit<
  Optional<Schemas['NewSchedule'], 'enabled' | 'retries' | 'retry_delay'>,
  'runtime' | 'notify'
> & { runtime?: Runtime | null; notify?: Notify | null };

export type CronPreview = Complete<Schemas['CronPreview']>;

export type ScheduleList = Omit<Complete<Schemas['ScheduleList']>, 'schedules'> & {
  schedules: ScheduleRow[];
};

/** One delivery attempt as `POST /schedules/{id}/test` reports it, channel by channel. */
export type DeliveryResult = Complete<Schemas['DeliveryModel']>;

export type TestResults = Omit<Complete<Schemas['TestResults']>, 'results'> & {
  results: DeliveryResult[];
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

/** Send the notifications this schedule would send, now, and say how each one went. */
export const testSchedule = (id: number) => api.post<TestResults>(`/schedules/${id}/test`);

export const previewCron = (cron: string, options?: { signal?: AbortSignal }) =>
  api.post<CronPreview>(
    '/schedules/preview',
    { cron } satisfies Schemas['CronPreviewRequest'],
    options,
  );

/** A schedule tells somebody about a run only when it has an event and a way to send. */
export function notifies(notify: Notify | null | undefined): boolean {
  if (!notify) return false;
  return notify.events.length > 0;
}
