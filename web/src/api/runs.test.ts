import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiToken,
  cancelRun,
  getRun,
  getRunLog,
  listRuns,
  parseRunEvent,
  runEventsUrl,
  runTraceUrl,
  startRun,
  type Run,
} from './runs';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function mockFetch(response: () => Response) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(response()),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callOf(mock: ReturnType<typeof mockFetch>): {
  url: string;
  body: string;
  method?: string | undefined;
} {
  const call = mock.mock.calls[0];
  const init = call?.[1] ?? {};
  return {
    url: typeof call?.[0] === 'string' ? call[0] : '',
    body: typeof init.body === 'string' ? init.body : '',
    method: init.method,
  };
}

const RUN: Run = {
  id: 12,
  flow: 'hello.py',
  runtime: 'threads',
  sample: null,
  trigger: 'manual',
  started: '2026-09-06T10:00:00Z',
  ended: null,
  status: 'running',
  report: null,
  log: '',
  trace_path: null,
  error: null,
  live: true,
};

describe('the run routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts a run with the options it was given', async () => {
    const mock = mockFetch(() => jsonResponse(RUN));
    await expect(
      startRun({ path: 'hello.py', runtime: 'sync', sample: 'three lines', tap: 5, trace: true }),
    ).resolves.toEqual(RUN);
    const call = callOf(mock);
    expect(call.url).toBe('/api/runs');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      path: 'hello.py',
      runtime: 'sync',
      sample: 'three lines',
      tap: 5,
      trace: true,
    });
  });

  it('lists runs, filtered by flow', async () => {
    const mock = mockFetch(() => jsonResponse({ runs: [RUN] }));
    await expect(listRuns({ flow: 'hello.py', limit: 10 })).resolves.toEqual({ runs: [RUN] });
    expect(callOf(mock).url).toBe('/api/runs?flow=hello.py&limit=10');
  });

  it('leaves the flow out when nothing is filtered', async () => {
    const mock = mockFetch(() => jsonResponse({ runs: [] }));
    await listRuns();
    expect(callOf(mock).url).toBe('/api/runs?limit=50');
  });

  it('reads one run and cancels one', async () => {
    const get = mockFetch(() => jsonResponse(RUN));
    await getRun(12);
    expect(callOf(get).url).toBe('/api/runs/12');

    vi.unstubAllGlobals();
    const cancel = mockFetch(() => jsonResponse({ ...RUN, status: 'cancelled' }));
    await expect(cancelRun(12)).resolves.toMatchObject({ status: 'cancelled' });
    expect(callOf(cancel).method).toBe('POST');
    expect(callOf(cancel).url).toBe('/api/runs/12/cancel');
  });

  it('reads the log as text, not as JSON', async () => {
    mockFetch(
      () =>
        new Response('two\nlines\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(getRunLog(12)).resolves.toBe('two\nlines\n');
  });
});

describe('the event socket', () => {
  it('speaks ws on an http page', () => {
    expect(runEventsUrl(7)).toBe('ws://localhost:3000/api/runs/7/events');
  });

  it('carries the token when the shell has one', () => {
    localStorage.setItem('tolquane.token', 's3cret');
    expect(apiToken()).toBe('s3cret');
    expect(runEventsUrl(7)).toBe('ws://localhost:3000/api/runs/7/events?token=s3cret');
    expect(runTraceUrl(7)).toBe('http://localhost:3000/api/runs/7/trace?token=s3cret');
  });

  it('leaves the trace link alone without one', () => {
    expect(runTraceUrl(7)).toBe('http://localhost:3000/api/runs/7/trace');
  });
});

describe('parseRunEvent', () => {
  it('reads every event of the stream', () => {
    expect(parseRunEvent('{"event": "done", "status": "done", "elapsed": 1.5}')).toEqual({
      event: 'done',
      status: 'done',
      elapsed: 1.5,
    });
    expect(parseRunEvent('{"event": "stdout", "text": "hi\\n"}')).toMatchObject({
      event: 'stdout',
    });
  });

  it('drops anything a run cannot have sent', () => {
    expect(parseRunEvent('not json')).toBeNull();
    expect(parseRunEvent('{"event": "gossip"}')).toBeNull();
    expect(parseRunEvent('[1, 2]')).toBeNull();
    expect(parseRunEvent('null')).toBeNull();
    expect(parseRunEvent(new Blob())).toBeNull();
  });
});
