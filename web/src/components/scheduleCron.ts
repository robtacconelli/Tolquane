/**
 * The cron presets and the arithmetic behind them.
 *
 * Nothing here validates an expression: the server's parser is the only authority (S3),
 * and `POST /api/schedules/preview` is what the editor shows. These functions only turn
 * the six shapes people ask for into an expression, and read one back into a preset so
 * that editing a schedule opens on the chip it was made with.
 */

export type PresetId =
  'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export const PRESETS: readonly { id: PresetId; label: string }[] = [
  { id: 'minutes', label: 'Every few minutes' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'custom', label: 'Custom' },
];

export const STEPS: readonly number[] = [1, 2, 5, 10, 15, 20, 30];

/* Cron numbers the days from Sunday; the list starts on Monday because the week does. */
export const WEEKDAYS: readonly { value: string; label: string }[] = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];

export interface CronParams {
  step: number;
  time: string;
  weekday: string;
  day: string;
}

export const DEFAULT_PARAMS: CronParams = { step: 5, time: '09:00', weekday: '1', day: '1' };

export const DEFAULT_CRON = '*/5 * * * *';

function clock(time: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = time.split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  return {
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : 0,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, Math.trunc(minute))) : 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The expression a preset stands for; `custom` builds nothing, it is what was typed. */
export function buildCron(preset: PresetId, params: CronParams): string | null {
  const { hour, minute } = clock(params.time);
  switch (preset) {
    case 'minutes':
      return `*/${params.step} * * * *`;
    case 'hourly':
      return '0 * * * *';
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${params.weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${params.day} * *`;
    case 'custom':
      return null;
  }
}

/** The inverse, as far as it goes: anything else is `custom`, which is not a failure. */
export function detectPreset(cron: string): { preset: PresetId; params: CronParams } {
  const text = cron.trim().replace(/\s+/g, ' ');
  const params = { ...DEFAULT_PARAMS };

  const every = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(text);
  if (every?.[1]) return { preset: 'minutes', params: { ...params, step: Number(every[1]) } };
  if (text === '0 * * * *') return { preset: 'hourly', params };

  const at = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|1-5|[0-6])$/.exec(text);
  if (at?.[1] !== undefined && at[2] !== undefined) {
    const time = `${pad(Number(at[2]))}:${pad(Number(at[1]))}`;
    const day = at[3];
    const dow = at[4];
    if (day !== undefined && day !== '*' && dow === '*') {
      return { preset: 'monthly', params: { ...params, time, day: String(Number(day)) } };
    }
    if (day === '*' && dow === '1-5') return { preset: 'weekdays', params: { ...params, time } };
    if (day === '*' && dow === '*') return { preset: 'daily', params: { ...params, time } };
    if (day === '*' && dow !== undefined) {
      return { preset: 'weekly', params: { ...params, time, weekday: dow } };
    }
  }
  return { preset: 'custom', params };
}
