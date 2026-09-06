import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../api/settings';
import { useUiStore } from '../store/ui';
import { SettingsPage } from './SettingsPage';

interface Reply {
  status?: number;
  body: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const seen: { key: string; body: unknown }[] = [];

function serve(routes: Record<string, (body: unknown) => Reply>): void {
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

function lastBody(key: string): unknown {
  return [...seen].reverse().find((call) => call.key === key)?.body;
}

const SETTINGS: Settings = {
  workspace: '/home/me/flows',
  default_runtime: 'threads',
  default_batch: 32,
  exec_timeout: 30,
  max_concurrent_runs: 4,
  cancel_grace: 10,
  theme: 'dark',
  ai: { provider: 'anthropic', model: null, has_anthropic_key: false, has_openai_key: false },
  server: { host: '127.0.0.1', port: 8765, token_set: false },
};

/** The panel a control belongs to, so "Save" means the one the reader is looking at. */
function section(title: string): HTMLElement {
  const panel = screen.getByText(title).closest('section');
  if (!panel) throw new Error(`no settings section titled ${title}`);
  return panel;
}

describe('the settings page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useUiStore.setState({ themeMode: 'system', theme: 'dark' });
  });

  it('shows what the server holds, and never a key', async () => {
    serve({ 'GET /api/settings': () => ({ body: SETTINGS }) });
    render(<SettingsPage />);

    expect(await screen.findByLabelText('Workspace directory')).toHaveValue('/home/me/flows');
    expect(screen.getByLabelText('Default runtime')).toHaveValue('threads');
    expect(screen.getByLabelText('Default batch')).toHaveValue('32');
    expect(screen.getByLabelText('Concurrent runs')).toHaveValue('4');
    expect(screen.getByLabelText('Cancel grace')).toHaveValue('10');
    expect(screen.getByLabelText('Anthropic key')).toHaveValue('');
    expect(within(section('AI builder')).getAllByText('Not set')).toHaveLength(2);
    expect(screen.getByText('127.0.0.1:8765')).toBeInTheDocument();
  });

  it('refuses a number that is not one, and holds the save', async () => {
    const user = userEvent.setup();
    serve({ 'GET /api/settings': () => ({ body: SETTINGS }) });
    render(<SettingsPage />);

    const concurrent = await screen.findByLabelText('Concurrent runs');
    const runs = section('Runs');
    await user.clear(concurrent);
    expect(within(runs).getByText('Enter a number.')).toBeInTheDocument();
    expect(within(runs).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.type(concurrent, 'four');
    expect(within(runs).getByText('Whole numbers only.')).toBeInTheDocument();

    await user.clear(concurrent);
    await user.type(concurrent, '999');
    expect(within(runs).getByText('Between 1 and 64.')).toBeInTheDocument();
    expect(within(runs).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(concurrent);
    await user.type(concurrent, '8');
    expect(within(runs).queryByText(/Between 1 and 64/)).not.toBeInTheDocument();
    expect(within(runs).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('saves one section at a time and says so', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/settings': () => ({ body: SETTINGS }),
      'PUT /api/settings': (body) => ({
        body: { ...SETTINGS, ...(body as Partial<Settings>) },
      }),
    });
    render(<SettingsPage />);

    const batch = await screen.findByLabelText('Default batch');
    const runs = section('Runs');
    await user.clear(batch);
    await user.type(batch, '64');
    expect(within(runs).getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(within(runs).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(runs).getByText('Saved')).toBeInTheDocument());
    expect(lastBody('PUT /api/settings')).toEqual({
      default_runtime: 'threads',
      default_batch: 64,
      exec_timeout: 30,
      max_concurrent_runs: 4,
      cancel_grace: 10,
    });
    // The other sections were not touched by this save.
    expect(within(section('Workspace')).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('discards a section back to what the server holds', async () => {
    const user = userEvent.setup();
    serve({ 'GET /api/settings': () => ({ body: SETTINGS }) });
    render(<SettingsPage />);

    const path = await screen.findByLabelText('Workspace directory');
    const workspace = section('Workspace');
    await user.clear(path);
    await user.type(path, '/tmp/elsewhere');
    expect(within(workspace).getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(within(workspace).getByRole('button', { name: 'Discard' }));
    expect(path).toHaveValue('/home/me/flows');
  });

  it('sends a key once and forgets it', async () => {
    const user = userEvent.setup();
    const secret = 'sk-ant-not-a-real-key';
    serve({
      'GET /api/settings': () => ({ body: SETTINGS }),
      'PUT /api/settings': () => ({
        body: { ...SETTINGS, ai: { ...SETTINGS.ai, has_anthropic_key: true } },
      }),
    });
    render(<SettingsPage />);

    const key = await screen.findByLabelText('Anthropic key');
    const ai = section('AI builder');
    await user.type(key, secret);
    await user.click(within(ai).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(ai).getByText('Saved')).toBeInTheDocument());
    expect(lastBody('PUT /api/settings')).toEqual({
      ai: { provider: 'anthropic', model: null, anthropic_key: secret },
    });

    // The key is gone from the page: the field is empty, the badge is the only trace.
    expect(screen.getByLabelText('Anthropic key')).toHaveValue('');
    expect(
      [...document.querySelectorAll('input')].some((input) => input.value.includes(secret)),
    ).toBe(false);
    expect(document.body.innerHTML).not.toContain(secret);
    expect(within(ai).getByText('Set')).toBeInTheDocument();
  });

  it('shows the server’s refusal in the section that caused it', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/settings': () => ({ body: SETTINGS }),
      'PUT /api/settings': () => ({
        status: 400,
        body: {
          error: { type: 'ValueError', message: '/tmp/elsewhere is not a directory' },
        },
      }),
    });
    render(<SettingsPage />);

    const path = await screen.findByLabelText('Workspace directory');
    const workspace = section('Workspace');
    await user.clear(path);
    await user.type(path, '/tmp/elsewhere');
    await user.click(within(workspace).getByRole('button', { name: 'Save' }));

    expect(
      await within(workspace).findByText('/tmp/elsewhere is not a directory'),
    ).toBeInTheDocument();
  });

  it('keeps the theme working when the server is not there', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<SettingsPage />);

    expect(await screen.findByText('The server is not running')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(useUiStore.getState().theme).toBe('light');
    expect(screen.queryByLabelText('Workspace directory')).not.toBeInTheDocument();
  });
});
