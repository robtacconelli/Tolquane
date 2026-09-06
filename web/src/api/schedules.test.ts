import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listFlows } from './flowsList';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  previewCron,
  runScheduleNow,
  updateSchedule,
} from './schedules';
import { getSettings, putSettings } from './settings';

interface Call {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const calls: Call[] = [];

function mockFetch(): void {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: urlOf(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        signal: init?.signal,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

describe('the schedules wrappers', () => {
  beforeEach(mockFetch);

  it('lists every schedule, and one flow at a time', async () => {
    await listSchedules();
    expect(calls[0]).toMatchObject({ url: '/api/schedules', method: 'GET' });
    await listSchedules('hello.py');
    expect(calls[1]?.url).toBe('/api/schedules?flow=hello.py');
  });

  it('creates, updates and deletes by id', async () => {
    await createSchedule({ flow: 'hello.py', cron: '*/5 * * * *', runtime: 'threads' });
    expect(calls[0]).toMatchObject({
      url: '/api/schedules',
      method: 'POST',
      body: { flow: 'hello.py', cron: '*/5 * * * *', runtime: 'threads' },
    });

    await updateSchedule(7, { enabled: false });
    expect(calls[1]).toMatchObject({
      url: '/api/schedules/7',
      method: 'PUT',
      body: { enabled: false },
    });

    await deleteSchedule(7);
    expect(calls[2]).toMatchObject({ url: '/api/schedules/7', method: 'DELETE' });
  });

  it('fires a schedule now and previews an expression', async () => {
    await runScheduleNow(3);
    expect(calls[0]).toMatchObject({ url: '/api/schedules/3/run', method: 'POST' });

    await previewCron('0 9 * * 1-5');
    expect(calls[1]).toMatchObject({
      url: '/api/schedules/preview',
      method: 'POST',
      body: { cron: '0 9 * * 1-5' },
    });
  });

  it('gives the preview an abort signal, so a keystroke can drop it', async () => {
    const controller = new AbortController();
    await previewCron('* * * * *', { signal: controller.signal });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('the settings wrappers', () => {
  beforeEach(mockFetch);

  it('reads and writes the whole document', async () => {
    await getSettings();
    expect(calls[0]).toMatchObject({ url: '/api/settings', method: 'GET' });

    await putSettings({ default_batch: 64, ai: { provider: 'anthropic', anthropic_key: 'sk-x' } });
    expect(calls[1]).toMatchObject({
      url: '/api/settings',
      method: 'PUT',
      body: { default_batch: 64, ai: { provider: 'anthropic', anthropic_key: 'sk-x' } },
    });
  });
});

describe('the flow list wrapper', () => {
  beforeEach(mockFetch);

  it('asks for the workspace listing', async () => {
    await listFlows();
    expect(calls[0]).toMatchObject({ url: '/api/flows', method: 'GET' });
  });
});
