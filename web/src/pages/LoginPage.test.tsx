import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api/auth';
import { TOKEN_KEY, clearUnauthorized, setServerMode } from '../api/token';
import { useAuthStore, type AuthState } from '../store/auth';
import { LoginPage } from './LoginPage';

/* The four faces of `/login`, chosen by the server rather than by the reader: sign in,
 * choose a new password, make the first administrator, and -- before any of those on a
 * `--token` server -- paste the token. */

const ALICE: User = {
  id: 1,
  name: 'alice',
  role: 'admin',
  created: '2026-09-01T10:00:00Z',
  disabled: false,
  must_change_password: false,
  last_seen: null,
};

interface Reply {
  status?: number;
  body: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const seen: { key: string; body: unknown }[] = [];

function serve(routes: Record<string, () => Reply>): void {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      seen.push({
        key,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const route = routes[key];
      const reply = route ? route() : { status: 404, body: { detail: `no route for ${key}` } };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function at(state: Partial<AuthState>): void {
  useAuthStore.setState({
    status: 'ready',
    mode: 'users',
    user: null,
    canSetup: false,
    error: null,
    ...state,
  });
}

function show(): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/runs' } }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/runs" element={<h1>the runs</h1>} />
        <Route path="/flows" element={<h1>the flows</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setServerMode('users');
  clearUnauthorized();
});

describe('signing in', () => {
  it('says what the server said about a wrong pair, and keeps no token', async () => {
    const user = userEvent.setup();
    serve({
      'POST /api/auth/login': () => ({
        status: 401,
        body: {
          error: { type: 'Unauthorized', message: 'that name and password do not go together' },
        },
      }),
    });
    at({});
    show();

    await user.type(screen.getByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('do not go together');
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    // The password field is emptied; the name is not, because it was probably right.
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Name')).toHaveValue('alice');
  });

  it('says so when the account is disabled', async () => {
    const user = userEvent.setup();
    serve({
      'POST /api/auth/login': () => ({
        status: 403,
        body: {
          error: {
            type: 'Forbidden',
            message: 'the account bob is disabled; an administrator can enable it again',
          },
        },
      }),
    });
    at({});
    show();

    await user.type(screen.getByLabelText('Name'), 'bob');
    await user.type(screen.getByLabelText('Password'), 'bobpass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('bob is disabled');
    });
  });

  it('keeps the session and puts the reader back where they were going', async () => {
    const user = userEvent.setup();
    serve({
      'POST /api/auth/login': () => ({ body: { token: 'session-token', user: ALICE } }),
      'GET /api/auth/me': () => ({ body: { user: ALICE, mode: 'users', can_setup: false } }),
    });
    at({});
    show();

    await user.type(screen.getByLabelText('Name'), 'Alice');
    await user.type(screen.getByLabelText('Password'), 'alicepass1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'the runs' })).toBeInTheDocument();
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
    // Names are lower case: the server would refuse "Alice" and the reader meant alice.
    expect(seen[0]?.body).toEqual({ name: 'alice', password: 'alicepass1' });
  });
});

describe('the password the administrator chose', () => {
  it('has to be replaced before anything else, and asks for it only once', async () => {
    const user = userEvent.setup();
    let changed = false;
    serve({
      'POST /api/auth/login': () => ({
        body: { token: 'session-token', user: { ...ALICE, must_change_password: true } },
      }),
      'POST /api/auth/password': () => {
        changed = true;
        return { body: { ok: true } };
      },
      'GET /api/auth/me': () => ({
        body: {
          user: { ...ALICE, must_change_password: !changed },
          mode: 'users',
          can_setup: false,
        },
      }),
    });
    at({});
    show();

    await user.type(screen.getByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'temporary1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Choose a password' })).toBeInTheDocument();
    });
    // The one just used is the current one: nobody types it twice.
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('New password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters');

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'a-better-one');
    await user.type(screen.getByLabelText('New password again'), 'a-different-one');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('not the same');

    await user.clear(screen.getByLabelText('New password again'));
    await user.type(screen.getByLabelText('New password again'), 'a-better-one');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'the runs' })).toBeInTheDocument();
    });
    expect(seen.find((call) => call.key === 'POST /api/auth/password')?.body).toEqual({
      current: 'temporary1',
      new: 'a-better-one',
    });
  });

  it('asks for the current one when the page was reloaded in the middle', () => {
    at({ user: { ...ALICE, must_change_password: true } });
    serve({});
    show();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });
});

describe('the first administrator', () => {
  it('is offered on a --token server with no users, and signs in as them', async () => {
    const user = userEvent.setup();
    serve({
      'POST /api/auth/setup': () => ({
        status: 201,
        body: { token: 'session-token', user: ALICE },
      }),
      'GET /api/auth/me': () => ({ body: { user: ALICE, mode: 'users', can_setup: false } }),
    });
    // The `--token` value is a user of sorts -- id 0, named `token`, an administrator --
    // and it must not count as somebody who is signed in and has nothing to do here.
    at({
      mode: 'token',
      canSetup: true,
      user: { ...ALICE, id: 0, name: 'token' },
    });
    show();

    expect(
      screen.getByRole('heading', { name: 'Create the first administrator' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'alicepass1');
    await user.type(screen.getByLabelText('Password again'), 'alicepass1');
    await user.click(screen.getByRole('button', { name: 'Create the administrator' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'the runs' })).toBeInTheDocument();
    });
    expect(seen[0]?.key).toBe('POST /api/auth/setup');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
  });
});

describe('a server whose mode is not known', () => {
  it('asks for the token, tries it, and keeps it only when it works', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/health': () => ({ body: { ok: true, version: '1.3.0', runs_live: 0 } }),
      'GET /api/auth/me': () => ({ body: { user: null, mode: 'token', can_setup: true } }),
    });
    at({ mode: null, user: null });
    setServerMode(null);
    show();

    expect(screen.getByRole('heading', { name: 'This server wants a token' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Server token'), 'opensesame');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe('opensesame');
    });
  });
});

describe('a server with no accounts at all', () => {
  it('has nothing to sign in to, so the page steps out of the way', () => {
    serve({});
    at({ mode: 'local', user: { ...ALICE, id: 0, name: 'local' } });
    show();
    expect(screen.getByRole('heading', { name: 'the runs' })).toBeInTheDocument();
  });
});
