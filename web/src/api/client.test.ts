import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, health, request } from './client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('request', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefixes /api and parses the JSON body', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ status: 'ok' })));
    await expect(request<{ status: string }>('/health')).resolves.toEqual({ status: 'ok' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/health');
  });

  it('builds a query string and drops empty values', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    await api.get('/runs', { query: { flow: 'a.py', limit: 10, cursor: undefined } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs?flow=a.py&limit=10');
  });

  it('sends a JSON body with the right content type', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ id: 1 })));
    await api.post('/runs', { flow: 'a.py' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"flow":"a.py"}');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('turns a non-2xx answer into an ApiError carrying the detail', async () => {
    mockFetch(() =>
      Promise.resolve(jsonResponse({ detail: 'flow.py is not in the workspace' }, { status: 404 })),
    );
    const error = await request('/flows/flow.py').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe('http');
    expect(apiError.message).toBe('flow.py is not in the workspace');
    expect(apiError.isOffline).toBe(false);
  });

  it('reports an unreachable server as an offline network error', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await request('/health').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('network');
    expect(apiError.status).toBe(0);
    expect(apiError.isOffline).toBe(true);
  });

  it('reports a caller abort as `aborted`, not as a network failure', async () => {
    mockFetch((_input, init) =>
      Promise.reject(
        Object.assign(new Error('aborted'), { name: 'AbortError', cause: init?.signal }),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    const error = await request('/health', { signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect((error as ApiError).code).toBe('aborted');
  });

  it('accepts an empty body', async () => {
    mockFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(api.delete('/flows/a.py')).resolves.toBeNull();
  });

  it('health() asks for /api/health', async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(jsonResponse({ status: 'ok', version: '0.1.0' })),
    );
    await expect(health()).resolves.toEqual({ status: 'ok', version: '0.1.0' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/health');
  });
});
