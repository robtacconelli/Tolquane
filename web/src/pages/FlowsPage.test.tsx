import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import type { FlowSummary } from '../api/flowsList';
import { useAiStore } from '../store/ai';
import { FlowsPage } from './FlowsPage';

/* The server answers of docs/web-interfaces.md, S4 ("Flows"), by hand: the page is
 * exercised through its real request path, with nothing but `fetch` replaced. */

interface Reply {
  status?: number;
  body: unknown;
}

type Route_ = (body: unknown) => Reply;

const seen: { key: string; body: unknown }[] = [];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function serve(routes: Record<string, Route_>): void {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${decodeURIComponent(url.pathname)}`;
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

function offline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('failed to fetch'))),
  );
}

const FLOWS: FlowSummary[] = [
  {
    path: 'hello.py',
    name: 'hello',
    modified: '2026-09-05T10:00:00Z',
    size: 573,
    has_layout: false,
    last_run: null,
  },
  {
    path: 'reports/word_count.py',
    name: 'word_count',
    modified: '2026-09-04T09:30:00Z',
    size: 1310,
    has_layout: true,
    last_run: { id: 12, status: 'done', ended: '2026-09-05T11:00:00Z' },
  },
  {
    path: 'nightly_etl.py',
    name: 'nightly_etl',
    modified: '2026-08-30T22:00:00Z',
    size: 4096,
    has_layout: false,
    last_run: { id: 9, status: 'failed', ended: '2026-09-01T02:00:00Z' },
  },
];

const WORKSPACE = '/home/me/flows';

const listRoute: Route_ = () => ({ body: { workspace: WORKSPACE, flows: FLOWS } });

const emptyRoute: Route_ = () => ({ body: { workspace: WORKSPACE, flows: [] } });

const created = (path: string): Reply => ({
  status: 201,
  body: {
    path,
    source: '',
    modified: '2026-09-06T12:00:00Z',
    model: null,
    code_only: null,
    graph: null,
    layout: null,
  },
});

/** Where the page navigated to, if it did. */
function Opened(): JSX.Element {
  const params = useParams<{ '*': string }>();
  return <div data-testid="opened">{params['*']}</div>;
}

function show(): void {
  render(
    <MemoryRouter initialEntries={['/flows']}>
      <Routes>
        <Route path="/flows" element={<FlowsPage />} />
        <Route path="/flows/*" element={<Opened />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the flows page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useAiStore.setState({ open: false, wantsNewFlow: false, threads: {} });
  });

  it('lists every flow in the workspace with what it last did', async () => {
    serve({ 'GET /api/flows': listRoute });
    show();

    expect(await screen.findByRole('link', { name: 'hello' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'word_count' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'nightly_etl' })).toBeInTheDocument();

    // the folder a flow lives in, its size, and how its last run went
    expect(screen.getByText('reports/')).toBeInTheDocument();
    expect(screen.getByText('573 B')).toBeInTheDocument();
    expect(screen.getByText('1.3 kB')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Never run')).toBeInTheDocument();
    expect(screen.getByTitle(WORKSPACE)).toBeInTheDocument();
  });

  it('opens a flow when its name is clicked', async () => {
    serve({ 'GET /api/flows': listRoute });
    show();
    await userEvent.click(await screen.findByRole('link', { name: 'word_count' }));
    expect(screen.getByTestId('opened')).toHaveTextContent('reports/word_count.py');
  });

  it('filters the list as you type', async () => {
    serve({ 'GET /api/flows': listRoute });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.type(screen.getByLabelText('Filter flows'), 'word');
    expect(screen.getByRole('link', { name: 'word_count' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'hello' })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Filter flows'));
    await userEvent.type(screen.getByLabelText('Filter flows'), 'nothing here');
    expect(screen.getByText(/No flow matches/)).toBeInTheDocument();
  });

  it('creates a flow from a template and opens it', async () => {
    serve({
      'GET /api/flows': listRoute,
      'POST /api/flows': (body) => created((body as { path: string }).path),
    });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: /New flow/ }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Word frequency');
    expect(within(dialog).getByText('word_frequency.py')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('radio', { name: /Hello/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create flow' }));

    await waitFor(() => expect(screen.getByTestId('opened')).toBeInTheDocument());
    expect(seen.find((call) => call.key === 'POST /api/flows')?.body).toEqual({
      path: 'word_frequency.py',
      template: 'hello',
    });
    expect(screen.getByTestId('opened')).toHaveTextContent('word_frequency.py');
  });

  it('refuses a name that is already in the workspace', async () => {
    serve({ 'GET /api/flows': listRoute });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: /New flow/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'hello');
    expect(screen.getByText('hello.py is already in the workspace.')).toBeInTheDocument();
  });

  it('hands a described flow to the AI panel and opens the editor', async () => {
    serve({
      'GET /api/flows': listRoute,
      'POST /api/flows': (body) => created((body as { path: string }).path),
    });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: /Build with AI/ }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText('What should it do?'),
      'count words per line in log.txt',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create and build' }));

    await waitFor(() => expect(screen.getByTestId('opened')).toBeInTheDocument());
    const path = 'count_words_per_line.py';
    expect(seen.find((call) => call.key === 'POST /api/flows')?.body).toEqual({
      path,
      template: 'empty',
    });
    expect(useAiStore.getState().open).toBe(true);
    expect(useAiStore.getState().threads[path]?.primed).toBe('count words per line in log.txt');
  });

  it('opens the describe dialog when the command palette asks for it', async () => {
    serve({ 'GET /api/flows': listRoute });
    show();
    await screen.findByRole('link', { name: 'hello' });

    useAiStore.getState().requestNewFlow();
    expect(await screen.findByLabelText('What should it do?')).toBeInTheDocument();
    expect(useAiStore.getState().wantsNewFlow).toBe(false);
  });

  it('renames a flow', async () => {
    serve({
      'GET /api/flows': listRoute,
      'POST /api/flows/hello.py/rename': (body) => created((body as { path: string }).path),
    });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: 'Rename hello.py' }));
    const field = screen.getByLabelText('Path in the workspace');
    await userEvent.clear(field);
    await userEvent.type(field, 'greeting.py');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(screen.getByText('Renamed hello.py to greeting.py.')).toBeInTheDocument(),
    );
    expect(seen.find((call) => call.key === 'POST /api/flows/hello.py/rename')?.body).toEqual({
      path: 'greeting.py',
    });
  });

  it('deletes a flow only after the question is answered', async () => {
    serve({
      'GET /api/flows': listRoute,
      'DELETE /api/flows/hello.py': () => ({ body: { ok: true } }),
    });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete hello.py' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete this flow?');
    expect(seen.some((call) => call.key.startsWith('DELETE'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await waitFor(() => expect(screen.getByText('Deleted hello.py.')).toBeInTheDocument());
    expect(seen.some((call) => call.key === 'DELETE /api/flows/hello.py')).toBe(true);
  });

  it('says what went wrong when a delete is refused', async () => {
    serve({
      'GET /api/flows': listRoute,
      'DELETE /api/flows/hello.py': () => ({
        status: 400,
        body: { error: { type: 'OSError', message: 'hello.py is read-only' } },
      }),
    });
    show();
    await screen.findByRole('link', { name: 'hello' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete hello.py' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    expect(await screen.findByText('hello.py is read-only')).toBeInTheDocument();
  });

  it('offers both ways to start when the workspace is empty', async () => {
    serve({ 'GET /api/flows': emptyRoute });
    show();
    expect(await screen.findByText('No flows yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New flow/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Build with AI/ })).toHaveLength(2);
  });

  it('says the server is down rather than that the workspace is empty', async () => {
    offline();
    show();
    expect(await screen.findByText('The server is not running')).toBeInTheDocument();
  });
});
