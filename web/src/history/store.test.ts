import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canInitialize, gitMissing, useHistoryStore } from './store';

/* The two questions the store answers before the tab can say anything -- is there git,
 * is there a repository -- and the rule that keeps two flows from being confused. */

/** The server's own two sentences (`tolquane/web/history.py`), which is what is read. */
const NO_GIT = 'git is not on PATH; install git to keep a history of this workspace';
const NO_REPO =
  'the workspace is not in a git repository; an administrator can make one from the ' +
  "History tab, or run 'git init' in it";

const status = (over: Partial<Parameters<typeof gitMissing>[0] & object>) => ({
  available: false,
  reason: null,
  repo: false,
  root: null,
  dirty: 0,
  ...over,
});

describe('what the workspace answered', () => {
  it('tells no git apart from no repository', () => {
    expect(gitMissing(status({ reason: NO_GIT }))).toBe(true);
    expect(gitMissing(status({ reason: NO_REPO }))).toBe(false);
    expect(gitMissing(null)).toBe(false);
  });

  it('offers to initialize only where git could do it', () => {
    expect(canInitialize(status({ reason: NO_REPO }))).toBe(true);
    expect(canInitialize(status({ reason: NO_GIT }))).toBe(false);
    expect(canInitialize({ available: true, reason: null, repo: true, root: '/w', dirty: 0 })).toBe(
      false,
    );
  });
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('asking twice', () => {
  beforeEach(() => {
    useHistoryStore.setState({
      status: null,
      path: null,
      entries: [],
      uncommitted: false,
      loading: false,
      error: null,
    });
  });

  /** Every answer takes `delay` milliseconds, so a slow flow can be overtaken by a fast one. */
  function serve(entries: Record<string, { short: string; delay: number }>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = urlOf(input);
        const body = url.includes('/workspace/history')
          ? { available: true, reason: null, repo: true, root: '/w', dirty: 1 }
          : null;
        const match = Object.entries(entries).find(([path]) => url.includes(encodeURI(path)));
        const delay = body ? 0 : (match?.[1].delay ?? 0);
        const payload =
          body ??
          ({
            entries: [
              {
                rev: `${match?.[1].short ?? 'x'}0000`,
                short: match?.[1].short ?? 'x',
                author: 'ada',
                date: '2026-09-06T10:00:00Z',
                message: 'a commit',
                head: true,
              },
            ],
            uncommitted: false,
          } as unknown);
        return new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify(payload), {
                  headers: { 'content-type': 'application/json' },
                }),
              ),
            delay,
          );
        });
      }),
    );
  }

  it('keeps the answer for the flow that is open, not the one that was', async () => {
    serve({
      'slow.py': { short: 'slow111', delay: 40 },
      'fast.py': { short: 'fast222', delay: 0 },
    });
    const { refresh } = useHistoryStore.getState();
    const first = refresh('slow.py');
    const second = refresh('fast.py');
    await Promise.all([first, second]);

    const state = useHistoryStore.getState();
    expect(state.path).toBe('fast.py');
    expect(state.entries[0]?.short).toBe('fast222');
    expect(state.loading).toBe(false);
  });
});
