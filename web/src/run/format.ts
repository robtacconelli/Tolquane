/**
 * Numbers as a run shows them.
 *
 * A run is watched while it happens, so everything here is written to be read at a
 * glance and to stop moving: fixed decimals rather than significant figures, tabular
 * numerals in the CSS, and a dash where there is nothing rather than a zero that looks
 * like a measurement.
 */

/**
 * Seconds as a person reads them: `4 ms`, `420 ms`, `3.1 s`, `2 m 05 s`.
 *
 * Under a second the unit changes rather than the decimals: most flows in an editor
 * finish in a few milliseconds, and `0.00 s` says nothing at all about which few.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds <= 0) return '0 ms';
  if (seconds < 0.001) return '<1 ms';
  if (seconds < 1) return `${String(Math.round(seconds * 1000))} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${String(minutes)} m ${String(rest).padStart(2, '0')} s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

/** The gap between two ISO stamps, or the gap to now while a run is still going. */
export function elapsedBetween(started: string, ended: string | null): number | null {
  const from = new Date(started).getTime();
  if (Number.isNaN(from)) return null;
  const to = ended === null ? Date.now() : new Date(ended).getTime();
  if (Number.isNaN(to)) return null;
  return Math.max(0, (to - from) / 1000);
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

/** A 0-to-1 share as whole percent; `busy_share` is what a card wears. */
export function formatShare(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return '—';
  return `${String(Math.round(share * 100))}%`;
}

/** Seconds in a report column: small numbers stay readable, zero reads as a dash. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds === 0) return '—';
  if (seconds < 0.001) return '<1 ms';
  if (seconds < 1) return `${String(Math.round(seconds * 1000))} ms`;
  return `${seconds.toFixed(2)} s`;
}

/*
 * Colour codes, out.
 *
 * `tolquane check` writes its error with the same colours it would in a terminal, and
 * the server passes the child's message through unchanged (S4: a GraphError already says
 * the fix). In a browser those bytes are not colour, they are `[1;35m` in the middle of
 * the sentence, so they come off before the message is shown.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

export function withoutAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** `numbers->double.emitter` as two halves, so an edge can be drawn with an arrow. */
export function splitEdgeKey(key: string): { src: string; dst: string } {
  const at = key.indexOf('->');
  if (at < 0) return { src: key, dst: '' };
  return { src: key.slice(0, at), dst: key.slice(at + 2) };
}

/**
 * What started a run: `manual`, `api`, `schedule:3`, `retry:3:2` (section N).
 *
 * A retry names the schedule it belongs to and which attempt it is, which is what lets
 * the run dialog draw the chain: the firing and everything that followed it.
 */
export interface Trigger {
  kind: 'manual' | 'api' | 'schedule' | 'retry' | 'other';
  /** The schedule this belongs to, for `schedule:` and `retry:`. */
  schedule: number | null;
  /** Which attempt a retry is; `0` for the firing itself. */
  attempt: number;
  label: string;
}

export function parseTrigger(trigger: string): Trigger {
  if (trigger === 'manual') return { kind: 'manual', schedule: null, attempt: 0, label: 'Manual' };
  if (trigger === 'api') return { kind: 'api', schedule: null, attempt: 0, label: 'API' };
  const retry = /^retry:(\d+):(\d+)$/.exec(trigger);
  if (retry) {
    return {
      kind: 'retry',
      schedule: Number(retry[1]),
      attempt: Number(retry[2]),
      label: `Retry ${String(retry[2])}`,
    };
  }
  const scheduled = /^schedule:(\d+)$/.exec(trigger);
  if (scheduled) {
    return {
      kind: 'schedule',
      schedule: Number(scheduled[1]),
      attempt: 0,
      label: `Schedule ${String(scheduled[1])}`,
    };
  }
  return { kind: 'other', schedule: null, attempt: 0, label: trigger };
}

/** `manual`, `api`, `schedule:3`, `retry:3:2` as a word. */
export function formatTrigger(trigger: string): string {
  return parseTrigger(trigger).label;
}

/** The least a run has to be for the chain below to line it up with its siblings. */
export interface ChainRun {
  id: number;
  trigger: string;
  started: string;
}

/**
 * One firing of a schedule and every retry that followed it, oldest first.
 *
 * The trigger says which schedule a run belongs to but not which *firing*: two failures
 * a day apart both leave `schedule:3` and `retry:3:1`. Ordering by start time and
 * beginning a new chain at every `schedule:` run puts each retry with the firing it
 * actually followed. A run that is not a schedule's is its own chain of one.
 */
export function retryChain<T extends ChainRun>(runs: readonly T[], run: T): T[] {
  const trigger = parseTrigger(run.trigger);
  if (trigger.schedule === null) return [run];
  const mine = runs
    .filter((other) => parseTrigger(other.trigger).schedule === trigger.schedule)
    .slice()
    .sort((a, b) => a.started.localeCompare(b.started) || a.id - b.id);
  const chains: T[][] = [];
  for (const other of mine) {
    if (parseTrigger(other.trigger).kind === 'schedule' || chains.length === 0)
      chains.push([other]);
    else chains[chains.length - 1]?.push(other);
  }
  return chains.find((chain) => chain.some((other) => other.id === run.id)) ?? [run];
}
