import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { flowHistory, flowVersion, initHistory, restoreVersion, workspaceHistory } from './history';

/* The five history routes of docs/web-interfaces.md, section H. Each wrapper is a line,
 * so what is worth testing is the line: the address, the method, and what goes in the
 * body. (Who the caller is comes from `store/auth.ts`, which asks `me` for the app.) */

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
  method: string | undefined;
  body: string;
} {
  const call = mock.mock.calls[0];
  const init = call?.[1] ?? {};
  return {
    url: typeof call?.[0] === 'string' ? call[0] : '',
    method: init.method,
    body: typeof init.body === 'string' ? init.body : '',
  };
}

const ENTRY = {
  rev: '6c72ce416038098bdbfda22cc359cda9cc856a71',
  short: '6c72ce4',
  author: 'test',
  date: '2026-09-06T19:57:52Z',
  message: 'Add a comment to hello',
  head: true,
};

describe('the history routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the workspace whether it has a history at all', async () => {
    const mock = mockFetch(() =>
      jsonResponse({ available: true, reason: null, repo: true, root: '/w', dirty: 2 }),
    );
    await expect(workspaceHistory()).resolves.toEqual({
      available: true,
      reason: null,
      repo: true,
      root: '/w',
      dirty: 2,
    });
    expect(callOf(mock).url).toBe('/api/workspace/history');
    expect(callOf(mock).method).toBe('GET');
  });

  it('makes a repository with a post and no body', async () => {
    const mock = mockFetch(() => jsonResponse({ ok: true }));
    await expect(initHistory()).resolves.toEqual({ ok: true });
    expect(callOf(mock).url).toBe('/api/workspace/history/init');
    expect(callOf(mock).method).toBe('POST');
    expect(callOf(mock).body).toBe('');
  });

  it("reads a flow's entries by its path, with the limit as a query", async () => {
    const mock = mockFetch(() => jsonResponse({ entries: [ENTRY], uncommitted: true }));
    const answer = await flowHistory('reports/word_count.py', 5);
    expect(answer.entries[0]?.short).toBe('6c72ce4');
    expect(answer.uncommitted).toBe(true);
    expect(callOf(mock).url).toBe('/api/flows/reports%2Fword_count.py/history?limit=5');
  });

  it('asks for fifty entries when nobody says otherwise', async () => {
    const mock = mockFetch(() => jsonResponse({ entries: [], uncommitted: false }));
    await flowHistory('hello.py');
    expect(callOf(mock).url).toBe('/api/flows/hello.py/history?limit=50');
  });

  it('reads one version, revision and all', async () => {
    const mock = mockFetch(() =>
      jsonResponse({ rev: ENTRY.rev, source: 'print(1)\n', diff: '--- a\n+++ b\n' }),
    );
    const version = await flowVersion('hello.py', ENTRY.rev);
    expect(version.source).toBe('print(1)\n');
    expect(callOf(mock).url).toBe(`/api/flows/hello.py/history/${ENTRY.rev}`);
  });

  it('restores a revision and gets the whole flow back', async () => {
    const mock = mockFetch(() => jsonResponse({ path: 'hello.py', source: 'x', modified: 'now' }));
    await restoreVersion('hello.py', ENTRY.rev);
    const call = callOf(mock);
    expect(call.url).toBe('/api/flows/hello.py/restore');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ rev: ENTRY.rev });
  });

  it('reports a workspace with no repository as the 400 it is', async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { type: 'HistoryError', message: 'the workspace is not in a git repository' } },
        { status: 400 },
      ),
    );
    const error = await flowHistory('hello.py').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe('the workspace is not in a git repository');
  });
});
