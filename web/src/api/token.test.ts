import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chat } from './ai';
import { ApiError, api, request } from './client';
import {
  TOKEN_KEY,
  apiToken,
  authHeaders,
  clearUnauthorized,
  isUnauthorized,
  setApiToken,
  subscribeToken,
} from './token';

/* The token of a server started with `--token`: kept in this browser, sent on every
 * request, and asked for the moment one comes back 401. */

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

function headerOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(() => {
  localStorage.clear();
  clearUnauthorized();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  clearUnauthorized();
});

describe('the stored token', () => {
  it('is nothing until one is set, and comes back once it is', () => {
    expect(apiToken()).toBeNull();
    expect(authHeaders()).toEqual({});

    setApiToken('s3cret');
    expect(apiToken()).toBe('s3cret');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('s3cret');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer s3cret' });

    setApiToken(null);
    expect(apiToken()).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('tells its subscribers when it changes', () => {
    const seen = vi.fn();
    const stop = subscribeToken(seen);
    setApiToken('one');
    setApiToken(null);
    stop();
    setApiToken('two');
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('every request', () => {
  it('carries the token when there is one, and no header when there is not', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ ok: true })));
    await api.get('/health');
    expect(headerOf(fetchMock.mock.calls[0]?.[1])).toBeUndefined();

    setApiToken('s3cret');
    await api.get('/health');
    expect(headerOf(fetchMock.mock.calls[1]?.[1])).toBe('Bearer s3cret');
  });

  it('lets a caller send its own token instead, to try one out', async () => {
    setApiToken('stored');
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ ok: true })));
    await api.get('/health', { headers: { Authorization: 'Bearer candidate' } });
    expect(headerOf(fetchMock.mock.calls[0]?.[1])).toBe('Bearer candidate');
  });

  it('asks for a token when the server answers 401', async () => {
    mockFetch(() =>
      Promise.resolve(jsonResponse({ detail: 'a token is required' }, { status: 401 })),
    );
    expect(isUnauthorized()).toBe(false);

    const error = await request('/flows').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(isUnauthorized()).toBe(true);

    // A token that is accepted puts the question away again.
    setApiToken('s3cret');
    expect(isUnauthorized()).toBe(false);
  });
});

describe('the chat stream', () => {
  it('carries the token too, and asks for one on a 401', async () => {
    setApiToken('s3cret');
    const fetchMock = mockFetch(() =>
      Promise.resolve(new Response('data: {"type":"done","ok":true,"summary":""}\n\n')),
    );
    await chat({ messages: [{ role: 'user', content: 'hello' }] }, {});
    expect(headerOf(fetchMock.mock.calls[0]?.[1])).toBe('Bearer s3cret');

    setApiToken(null);
    mockFetch(() => Promise.resolve(new Response('no', { status: 401 })));
    await expect(chat({ messages: [] }, {})).rejects.toBeInstanceOf(ApiError);
    expect(isUnauthorized()).toBe(true);
  });
});
