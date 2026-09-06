import { describe, expect, it } from 'vitest';
import { formatRelative, formatWhen, runStatusLook, splitWhen, zoneLabel } from './scheduleFormat';

const NOON = Date.parse('2026-09-06T12:00:00Z');

describe('schedule formatting', () => {
  it('splits a time into a day and a clock reading', () => {
    const parts = splitWhen('2026-09-06T12:00:00Z');
    expect(parts).not.toBeNull();
    expect(parts?.day).toMatch(/Sep|Sept/);
    expect(parts?.time).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it('has one dash for a time that is not there', () => {
    expect(splitWhen(null)).toBeNull();
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('not a date')).toBe('—');
    expect(formatRelative(null)).toBe('');
  });

  it('says how far away a time is, in whichever direction', () => {
    expect(formatRelative('2026-09-06T12:12:00Z', NOON)).toBe('in 12 minutes');
    expect(formatRelative('2026-09-06T09:00:00Z', NOON)).toBe('3 hours ago');
    expect(formatRelative('2026-09-08T12:00:00Z', NOON)).toBe('in 2 days');
    expect(formatRelative('2026-09-06T12:00:20Z', NOON)).toBe('now');
  });

  it('names the zone the times are shown in', () => {
    expect(zoneLabel().length).toBeGreaterThan(0);
  });

  it('paints a run status with one of the five run-state colours', () => {
    expect(runStatusLook('done')).toEqual({ state: 'done', label: 'Done' });
    expect(runStatusLook('deadlock')).toEqual({ state: 'failed', label: 'Deadlock' });
    expect(runStatusLook('cancelled')).toEqual({ state: 'new', label: 'Cancelled' });
    expect(runStatusLook(null)).toEqual({ state: 'new', label: 'Never run' });
  });
});
