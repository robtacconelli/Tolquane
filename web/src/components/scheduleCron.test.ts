import { describe, expect, it } from 'vitest';
import { buildCron, DEFAULT_PARAMS, detectPreset } from './scheduleCron';

describe('cron presets', () => {
  it('builds the six shapes people ask for', () => {
    const params = { ...DEFAULT_PARAMS, time: '07:30', weekday: '3', day: '12', step: 15 };
    expect(buildCron('minutes', params)).toBe('*/15 * * * *');
    expect(buildCron('hourly', params)).toBe('0 * * * *');
    expect(buildCron('daily', params)).toBe('30 7 * * *');
    expect(buildCron('weekdays', params)).toBe('30 7 * * 1-5');
    expect(buildCron('weekly', params)).toBe('30 7 * * 3');
    expect(buildCron('monthly', params)).toBe('30 7 12 * *');
    expect(buildCron('custom', params)).toBeNull();
  });

  it('reads an expression back into the preset that made it', () => {
    expect(detectPreset('*/5 * * * *')).toMatchObject({ preset: 'minutes', params: { step: 5 } });
    expect(detectPreset('0 * * * *').preset).toBe('hourly');
    expect(detectPreset('30 7 * * *')).toMatchObject({
      preset: 'daily',
      params: { time: '07:30' },
    });
    expect(detectPreset('0 9 * * 1-5')).toMatchObject({
      preset: 'weekdays',
      params: { time: '09:00' },
    });
    expect(detectPreset('0 9 * * 3')).toMatchObject({
      preset: 'weekly',
      params: { weekday: '3' },
    });
    expect(detectPreset('0 9 12 * *')).toMatchObject({ preset: 'monthly', params: { day: '12' } });
  });

  it('calls anything else custom, which is not a failure', () => {
    expect(detectPreset('@hourly').preset).toBe('custom');
    expect(detectPreset('*/15 8-18 * * mon-fri').preset).toBe('custom');
    expect(detectPreset('').preset).toBe('custom');
  });

  it('survives a half-typed time', () => {
    expect(buildCron('daily', { ...DEFAULT_PARAMS, time: '' })).toBe('0 0 * * *');
    expect(buildCron('daily', { ...DEFAULT_PARAMS, time: '99:99' })).toBe('59 23 * * *');
  });
});
