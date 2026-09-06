import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api/auth';
import { TOKEN_KEY } from '../api/token';
import { useAuthStore } from '../store/auth';
import { AccountMenu } from './AccountMenu';

/* The foot of the sidebar: who you are, and the three things you can do about it. */

const ALICE: User = {
  id: 1,
  name: 'alice',
  role: 'admin',
  created: '2026-09-01T10:00:00Z',
  disabled: false,
  must_change_password: false,
  last_seen: null,
};

const LOCAL: User = { ...ALICE, id: 0, name: 'local' };

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
      const reply = route ? route(body) : { status: 404, body: { detail: `no route for ${key}` } };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function at(user: User | null, mode: 'local' | 'users' | 'token', canSetup = false): void {
  useAuthStore.setState({ status: 'ready', mode, user, canSetup, error: null });
}

function show(): void {
  render(
    <MemoryRouter>
      <AccountMenu collapsed={false} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  serve({});
});

describe('the account row', () => {
  it('is a name and nothing else on a server with no accounts', () => {
    at(LOCAL, 'local');
    show();
    expect(screen.getByText('local')).toBeInTheDocument();
    expect(screen.getByText('no sign-in on this server')).toBeInTheDocument();
    // Nothing to change, nothing to sign out of: `local` is not a person.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is nothing at all before the server has said who the caller is', () => {
    at(null, 'users');
    show();
    expect(screen.queryByText('local')).not.toBeInTheDocument();
  });

  it('offers the first administrator on a --token server', async () => {
    const user = userEvent.setup();
    at({ ...LOCAL, name: 'token' }, 'token', true);
    show();
    await user.click(screen.getByRole('button', { name: /Account: token/ }));
    expect(
      screen.getByRole('menuitem', { name: /Create the first administrator/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Change password/ })).not.toBeInTheDocument();
  });
});

describe('the menu', () => {
  it('names the person, their role, and the three things they can do', async () => {
    const user = userEvent.setup();
    at(ALICE, 'users');
    show();

    await user.click(screen.getByRole('button', { name: 'Account: alice, admin' }));
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(menu).toHaveTextContent('Administrator');
    expect(screen.getByRole('menuitem', { name: /Change password/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /API tokens/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('changes the password without ending the session', async () => {
    const user = userEvent.setup();
    at(ALICE, 'users');
    localStorage.setItem(TOKEN_KEY, 'session-token');
    serve({ 'POST /api/auth/password': () => ({ body: { ok: true } }) });
    show();

    await user.click(screen.getByRole('button', { name: /Account: alice/ }));
    await user.click(screen.getByRole('menuitem', { name: /Change password/ }));

    await user.type(screen.getByLabelText('Current password'), 'alicepass1');
    await user.type(screen.getByLabelText('New password'), 'a-better-one');
    await user.type(screen.getByLabelText('New password again'), 'a-better-one');
    await user.click(screen.getByRole('button', { name: 'Change the password' }));

    await waitFor(() => {
      expect(screen.getByText('Your password has been changed.')).toBeInTheDocument();
    });
    expect(seen.at(-1)?.body).toEqual({ current: 'alicepass1', new: 'a-better-one' });
    // The browser is still signed in: this is the session that asked.
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
  });

  it('says two passwords that differ are two passwords', async () => {
    const user = userEvent.setup();
    at(ALICE, 'users');
    show();
    await user.click(screen.getByRole('button', { name: /Account: alice/ }));
    await user.click(screen.getByRole('menuitem', { name: /Change password/ }));

    await user.type(screen.getByLabelText('New password'), 'a-better-one');
    await user.type(screen.getByLabelText('New password again'), 'a-different-one');
    await user.click(screen.getByRole('button', { name: 'Change the password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('not the same');
  });

  it('lists the API tokens, makes one that is shown once, and revokes one', async () => {
    const user = userEvent.setup();
    at(ALICE, 'users');
    let tokens = [{ id: 3, label: 'nightly', created: '2026-09-01T10:00:00Z', last_seen: null }];
    serve({
      'GET /api/auth/tokens': () => ({ body: { tokens } }),
      'POST /api/auth/tokens': (body) => {
        const asked = body as { label: string };
        tokens = [
          ...tokens,
          { id: 4, label: asked.label, created: '2026-09-06T10:00:00Z', last_seen: null },
        ];
        return { status: 201, body: { id: 4, token: 'tq-brand-new-token', label: asked.label } };
      },
      'DELETE /api/auth/tokens/3': () => {
        tokens = tokens.filter((token) => token.id !== 3);
        return { body: { ok: true } };
      },
    });
    show();

    await user.click(screen.getByRole('button', { name: /Account: alice/ }));
    await user.click(screen.getByRole('menuitem', { name: /API tokens/ }));
    await screen.findByText('nightly');

    await user.type(screen.getByLabelText('New token'), 'laptop');
    await user.click(screen.getByRole('button', { name: 'Make a token' }));
    await waitFor(() => {
      expect(screen.getByText('tq-brand-new-token')).toBeInTheDocument();
    });
    expect(screen.getByText(/shown this once/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByText('nightly')).not.toBeInTheDocument();
    });
  });

  it('signs out, and forgets the token as it goes', async () => {
    const user = userEvent.setup();
    at(ALICE, 'users');
    localStorage.setItem(TOKEN_KEY, 'session-token');
    serve({
      'POST /api/auth/logout': () => ({ body: { ok: true } }),
      'GET /api/auth/me': () => ({ body: { user: null, mode: 'users', can_setup: false } }),
    });
    show();

    await user.click(screen.getByRole('button', { name: /Account: alice/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });
    expect(seen[0]?.key).toBe('POST /api/auth/logout');
    expect(useAuthStore.getState().user).toBeNull();
  });
});
