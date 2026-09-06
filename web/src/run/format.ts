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

/** `numbers->double.emitter` as two halves, so an edge can be drawn with an arrow. */
export function splitEdgeKey(key: string): { src: string; dst: string } {
  const at = key.indexOf('->');
  if (at < 0) return { src: key, dst: '' };
  return { src: key.slice(0, at), dst: key.slice(at + 2) };
}

/** `manual`, `api`, `schedule:3` as a word. */
export function formatTrigger(trigger: string): string {
  if (trigger.startsWith('schedule:')) return `Schedule ${trigger.slice('schedule:'.length)}`;
  if (trigger === 'manual') return 'Manual';
  if (trigger === 'api') return 'API';
  return trigger;
}
