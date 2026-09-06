import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES } from '../test/fixtures';
import { ApiError } from './client';
import {
  checkFlow,
  drawFlow,
  explainFlow,
  generateSource,
  getFlow,
  listFlows,
  optimizeFlow,
  parseSource,
  saveFlow,
  saveLayout,
} from './flows';

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

function callOf(mock: ReturnType<typeof mockFetch>): { url: string; body: string } {
  const call = mock.mock.calls[0];
  const init = call?.[1] ?? {};
  return {
    url: typeof call?.[0] === 'string' ? call[0] : '',
    body: typeof init.body === 'string' ? init.body : '',
  };
}

function methodOf(mock: ReturnType<typeof mockFetch>): string | undefined {
  return mock.mock.calls[0]?.[1]?.method;
}

describe('the flow routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the workspace', async () => {
    const mock = mockFetch(() => jsonResponse({ workspace: '/w', flows: [] }));
    await expect(listFlows()).resolves.toEqual({ workspace: '/w', flows: [] });
    expect(callOf(mock).url).toBe('/api/flows');
  });

  it('opens a flow by its path inside the workspace', async () => {
    const flow = FIXTURES['word_count.py'];
    const mock = mockFetch(() => jsonResponse(flow));
    const answer = await getFlow('reports/word_count.py');
    expect(answer.model?.name).toBe('word_count');
    expect(callOf(mock).url).toBe('/api/flows/reports%2Fword_count.py');
  });

  it('saves the source with the modified stamp it was given', async () => {
    const mock = mockFetch(() => jsonResponse({ path: 'a.py', source: 'x', modified: 'later' }));
    await saveFlow('a.py', { source: 'x', modified: 'earlier' });
    const { url, body } = callOf(mock);
    expect(url).toBe('/api/flows/a.py');
    expect(methodOf(mock)).toBe('PUT');
    expect(body).toBe('{"source":"x","modified":"earlier"}');
  });

  it('reports a stale save as a 409, message and all', async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { type: 'Conflict', message: 'the file changed on disk' } },
        { status: 409 },
      ),
    );
    const error = await saveFlow('a.py', { source: 'x', modified: 'old' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('the file changed on disk');
  });

  it('writes the layout sidecar to its own route', async () => {
    const layout = {
      version: 1,
      positions: { 'stages.0': { x: 1, y: 2 } },
      viewport: null,
      samples: [],
    };
    const mock = mockFetch(() => jsonResponse({ ok: true }));
    await saveLayout('a.py', layout);
    const { url, body } = callOf(mock);
    expect(url).toBe('/api/flows/a.py/layout');
    expect(methodOf(mock)).toBe('PUT');
    expect(JSON.parse(body)).toEqual(layout);
  });

  it('parses source and generates it back', async () => {
    const parse = mockFetch(() => jsonResponse({ model: null, code_only: null, graph: null }));
    await parseSource('import tolquane as tq', 'demo');
    expect(JSON.parse(callOf(parse).body)).toEqual({
      source: 'import tolquane as tq',
      name: 'demo',
    });

    vi.unstubAllGlobals();
    const generate = mockFetch(() => jsonResponse({ source: 'print(1)' }));
    const model = FIXTURES['hello.py']?.model;
    await expect(generateSource(model!)).resolves.toEqual({ source: 'print(1)' });
    expect(callOf(generate).url).toBe('/api/flows/generate');
  });

  it('posts the model tools at the flow that owns them', async () => {
    for (const [call, suffix] of [
      [() => checkFlow('a.py'), 'check'],
      [() => explainFlow('a.py'), 'explain'],
      [() => drawFlow('a.py'), 'draw'],
      [() => optimizeFlow('a.py'), 'optimize'],
    ] as const) {
      vi.unstubAllGlobals();
      const mock = mockFetch(() => jsonResponse({ ok: true, nodes: 1, edges: 0 }));
      await call();
      expect(callOf(mock).url).toBe(`/api/flows/a.py/${suffix}`);
      expect(methodOf(mock)).toBe('POST');
    }
  });

  it('asks optimize whether it may use all-to-all', async () => {
    const mock = mockFetch(() => jsonResponse({ source: '', notes: [], graph: null }));
    await optimizeFlow('a.py', true);
    expect(JSON.parse(callOf(mock).body)).toEqual({ all2all: true });
  });
});
