import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth';
import { useFlowStore } from '../store/flow';
import { HistoryPanel } from './HistoryPanel';
import { useHistoryStore } from './store';

/* The tab, in every state section H can put it in: no git, no repository, a repository
 * with commits, a file that differs from the last one, one version's difference, and a
 * restore. The server is the contract of docs/web-interfaces.md answered by hand. */

interface Reply {
  status?: number;
  body: unknown;
}

type Route = (body: unknown) => Reply;

const seen: { key: string; body: unknown }[] = [];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function serve(routes: Record<string, Route>): void {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      seen.push({ key, body });
      const route = routes[key];
      const reply: Reply = route
        ? route(body)
        : { status: 404, body: { error: { type: 'KeyError', message: `no route for ${key}` } } };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const NO_GIT = 'git is not on PATH; install git to keep a history of this workspace';
const NO_REPO =
  'the workspace is not in a git repository; an administrator can make one from the ' +
  "History tab, or run 'git init' in it";

const HEAD = {
  rev: '6c72ce416038098bdbfda22cc359cda9cc856a71',
  short: '6c72ce4',
  author: 'ada',
  date: new Date(Date.now() - 3_600_000).toISOString(),
  message: 'Give the farm four workers',
  head: true,
};

const OLDER = {
  rev: 'b3e51b9a8134a3552c95e50df7c579a3ea7b2fdc',
  short: 'b3e51b9',
  author: 'grace',
  date: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  message: 'Add hello.py',
  head: false,
};

const NOW = 'one\ntwo\nthree\n';
const THEN = 'one\ntwo and a half\nthree\n';

const available: Route = () => ({
  body: { available: true, reason: null, repo: true, root: '/w', dirty: 1 },
});

const entries =
  (uncommitted: boolean): Route =>
  () => ({ body: { entries: [HEAD, OLDER], uncommitted } });

/** Signed in as somebody: only an administrator is offered `git init` (section U). */
function signedIn(role: 'admin' | 'member'): void {
  useAuthStore.setState({
    status: 'ready',
    mode: 'users',
    user: {
      id: 1,
      name: 'ada',
      role,
      created: '2026-09-01T08:00:00Z',
      disabled: false,
      must_change_password: false,
      last_seen: null,
    },
    canSetup: false,
    error: null,
  });
}

function reset(): void {
  useHistoryStore.setState({
    open: true,
    status: null,
    path: null,
    entries: [],
    uncommitted: false,
    loading: false,
    error: null,
  });
  useFlowStore.getState().clear();
  useFlowStore.setState({ path: 'hello.py', source: NOW, modified: 'stamp' });
  signedIn('admin');
}

/** Ask the server, the way the editor page does, before the panel is on screen. */
async function load(path = 'hello.py'): Promise<void> {
  await act(async () => {
    await useHistoryStore.getState().refresh(path);
  });
}

function panel(onSaveWithMessage = vi.fn()): void {
  render(
    <HistoryPanel
      path="hello.py"
      onProperties={vi.fn()}
      onAi={vi.fn()}
      onSaveWithMessage={onSaveWithMessage}
    />,
  );
}

describe('the History tab', () => {
  beforeEach(() => {
    reset();
  });

  it('says so, and nothing else, when there is no git', async () => {
    serve({
      'GET /api/workspace/history': () => ({
        body: { available: false, reason: NO_GIT, repo: false, root: null, dirty: 0 },
      }),
    });
    await load();
    panel();

    expect(screen.getByText('History needs git')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(NO_GIT))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Initialize history' })).not.toBeInTheDocument();
  });

  it('offers to make a repository, and makes one', async () => {
    let repo = false;
    serve({
      'GET /api/workspace/history': () =>
        repo
          ? { body: { available: true, reason: null, repo: true, root: '/w', dirty: 0 } }
          : { body: { available: false, reason: NO_REPO, repo: false, root: null, dirty: 0 } },
      'POST /api/workspace/history/init': () => {
        repo = true;
        return { body: { ok: true } };
      },
      'GET /api/flows/hello.py/history': entries(false),
    });
    await load();
    panel();

    expect(screen.getByText('This workspace has no history')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Initialize history' }));

    expect(await screen.findByText('Give the farm four workers')).toBeInTheDocument();
    expect(seen.some((call) => call.key === 'POST /api/workspace/history/init')).toBe(true);
  });

  it('tells a member the reason instead of offering the button', async () => {
    serve({
      'GET /api/workspace/history': () => ({
        body: { available: false, reason: NO_REPO, repo: false, root: null, dirty: 0 },
      }),
    });
    signedIn('member');
    await load();
    panel();

    expect(screen.queryByRole('button', { name: 'Initialize history' })).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp("run 'git init'"))).toBeInTheDocument();
  });

  it('lists the commits newest first, with the head marked and the dates in words', async () => {
    serve({
      'GET /api/workspace/history': available,
      'GET /api/flows/hello.py/history': entries(false),
    });
    await load();
    panel();

    const rows = screen.getAllByRole('button', { name: /Give the farm|Add hello/ });
    expect(within(rows[0] as HTMLElement).getByText('Give the farm four workers')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('head')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('6c72ce4')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('ada')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('1 hour ago')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('3 days ago')).toBeVisible();
    expect(within(rows[1] as HTMLElement).queryByText('head')).not.toBeInTheDocument();
  });

  it('puts uncommitted changes on top, with a way to commit them', async () => {
    const commit = vi.fn();
    serve({
      'GET /api/workspace/history': available,
      'GET /api/flows/hello.py/history': entries(true),
    });
    await load();
    panel(commit);

    expect(screen.getByText('Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByText('Not in 6c72ce4')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Commit…' }));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('shows one version against the file as it is now', async () => {
    serve({
      'GET /api/workspace/history': available,
      'GET /api/flows/hello.py/history': entries(true),
      [`GET /api/flows/hello.py/history/${OLDER.rev}`]: () => ({
        body: { rev: OLDER.rev, source: THEN, diff: '' },
      }),
    });
    await load();
    panel();

    await userEvent.click(screen.getByRole('button', { name: /Add hello\.py/ }));

    const diff = await screen.findByRole('table', { name: /Difference between b3e51b9/ });
    expect(within(diff).getByText('two and a half')).toBeInTheDocument();
    expect(within(diff).getByText('two')).toBeInTheDocument();
    expect(screen.getByText('1 added, 1 removed')).toBeInTheDocument();
    expect(screen.getByText('− b3e51b9')).toBeInTheDocument();
  });

  it('restores a version after a confirmation, and says it is not committed', async () => {
    serve({
      'GET /api/workspace/history': available,
      'GET /api/flows/hello.py/history': entries(true),
      [`GET /api/flows/hello.py/history/${OLDER.rev}`]: () => ({
        body: { rev: OLDER.rev, source: THEN, diff: '' },
      }),
      'POST /api/flows/hello.py/restore': () => ({
        body: {
          path: 'hello.py',
          source: THEN,
          modified: 'later',
          model: null,
          code_only: { reason: 'a fixture' },
          graph: null,
          layout: null,
        },
      }),
    });
    await load();
    panel();

    await userEvent.click(screen.getByRole('button', { name: /Add hello\.py/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));

    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(useFlowStore.getState().source).toBe(THEN);
    });
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(
      await screen.findByText(/Restored from b3e51b9\. The file is written, and not committed\./),
    ).toBeInTheDocument();
    expect(seen.filter((call) => call.key === 'POST /api/flows/hello.py/restore')).toHaveLength(1);
  });

  it('reports a history it could not read rather than an empty list', async () => {
    serve({
      'GET /api/workspace/history': available,
      'GET /api/flows/hello.py/history': () => ({
        status: 400,
        body: { error: { type: 'HistoryError', message: 'git log did not answer within 15s' } },
      }),
    });
    await load();
    panel();

    // The tab asks again as it opens, so the failure is awaited rather than assumed.
    expect(await screen.findByText('The history could not be read')).toBeInTheDocument();
    expect(screen.getByText('git log did not answer within 15s')).toBeInTheDocument();
  });
});
