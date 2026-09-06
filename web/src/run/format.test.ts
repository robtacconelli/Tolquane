import { describe, expect, it } from 'vitest';
import { formatTrigger, parseTrigger, retryChain, type ChainRun } from './format';

/* What started a run, and -- for a schedule that retries (docs/web-interfaces.md, N) --
 * which firing a retry belongs to. */

describe('the trigger', () => {
  it('reads the four shapes the server writes', () => {
    expect(parseTrigger('manual')).toMatchObject({ kind: 'manual', label: 'Manual' });
    expect(parseTrigger('api')).toMatchObject({ kind: 'api', label: 'API' });
    expect(parseTrigger('schedule:3')).toMatchObject({
      kind: 'schedule',
      schedule: 3,
      attempt: 0,
      label: 'Schedule 3',
    });
    expect(parseTrigger('retry:3:2')).toMatchObject({
      kind: 'retry',
      schedule: 3,
      attempt: 2,
      label: 'Retry 2',
    });
  });

  it('passes anything else through as it is', () => {
    expect(formatTrigger('something-new')).toBe('something-new');
  });
});

const run = (id: number, trigger: string, started: string): ChainRun => ({ id, trigger, started });

describe('the retry chain', () => {
  const runs = [
    run(1, 'schedule:3', '2026-09-06T10:00:00Z'),
    run(2, 'retry:3:1', '2026-09-06T10:01:00Z'),
    run(3, 'retry:3:2', '2026-09-06T10:02:00Z'),
    run(4, 'schedule:3', '2026-09-06T11:00:00Z'),
    run(5, 'retry:3:1', '2026-09-06T11:01:00Z'),
    run(6, 'schedule:9', '2026-09-06T11:30:00Z'),
    run(7, 'manual', '2026-09-06T11:40:00Z'),
  ];

  it('puts every retry with the firing it followed, not with the other firing', () => {
    expect(retryChain(runs, runs[2] as ChainRun).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(retryChain(runs, runs[4] as ChainRun).map((r) => r.id)).toEqual([4, 5]);
  });

  it('gives the firing its own retries, whichever end it is asked from', () => {
    expect(retryChain(runs, runs[0] as ChainRun).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('leaves a run of another schedule, and a manual one, alone', () => {
    expect(retryChain(runs, runs[5] as ChainRun).map((r) => r.id)).toEqual([6]);
    expect(retryChain(runs, runs[6] as ChainRun).map((r) => r.id)).toEqual([7]);
  });

  it('is the run itself when the history has not arrived', () => {
    expect(retryChain([], runs[0] as ChainRun).map((r) => r.id)).toEqual([1]);
  });
});
