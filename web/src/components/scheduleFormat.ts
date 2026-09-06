/**
 * Times and statuses as the schedules page shows them.
 *
 * The server speaks UTC ISO throughout (S3); a schedule fires in the machine's own zone,
 * so every time here is rendered in the reader's local zone and the zone is named
 * wherever a list of future times appears.
 */
import type { RunStatus } from '../api/schedules';
import type { NodeState } from './nodeState';

const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The day and the clock time apart, for the two-line cells the page draws. */
export function splitWhen(iso: string | null | undefined): { day: string; time: string } | null {
  const date = parse(iso);
  if (!date) return null;
  return { day: DAY.format(date), time: TIME.format(date) };
}

export function formatWhen(iso: string | null | undefined): string {
  const parts = splitWhen(iso);
  return parts ? `${parts.day}, ${parts.time}` : '—';
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "in 12 minutes", "3 days ago"; anything under a minute is simply "now". */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parse(iso);
  if (!date) return '';
  const delta = date.getTime() - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return RELATIVE.format(Math.round(delta / size), unit);
  }
  return 'now';
}

export function zoneLabel(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
}

/** A run status painted with the five run-state colours the canvas uses. */
export function runStatusLook(status: RunStatus | null): { state: NodeState; label: string } {
  switch (status) {
    case 'running':
      return { state: 'running', label: 'Running' };
    case 'done':
      return { state: 'done', label: 'Done' };
    case 'failed':
      return { state: 'failed', label: 'Failed' };
    case 'deadlock':
      return { state: 'failed', label: 'Deadlock' };
    case 'cancelled':
      return { state: 'new', label: 'Cancelled' };
    default:
      return { state: 'new', label: 'Never run' };
  }
}
