import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { UsersPage } from './UsersPage';

/* The administrator's page: docs/web-interfaces.md, U. Every rule about who may do what
 * belongs to the server, so what is tested here is that the page asks, and that it shows
 * the answer where the reader is looking. */

const ALICE: User = {
  id: 1,
  name: 'alice',
  role: 'admin',
  created: '2026-09-01T10:00:00Z',
  disabled: false,
  must_change_password: false,
  last_seen: '2026-09-06T09:00:00Z',
};

const BOB: User = {
  id: 2,
  name: 'bob',
  role: 'member',
  created: '2026-09-03T10:00:00Z',
  disabled: false,
  must_change_password: true,
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

/** The last body sent to a route: a row is changed one field at a time. */
function bodyOf(key: string): Record<string, unknown> | undefined {
  for (let index = seen.length - 1; index >= 0; index -= 1) {
    const call = seen[index];
    if (call?.key === key) return call.body as Record<string, unknown>;
  }
  return undefined;
}

function signedInAs(user: User): void {
  useAuthStore.setState({ status: 'ready', mode: 'users', user, canSetup: false, error: null });
}

function show(): void {
  render(
    <MemoryRouter>
      <UsersPage />
    </MemoryRouter>,
  );
}

/** The list, as it comes back after whatever has just been done to it. */
function listing(users: User[]): () => Reply {
  return () => ({ body: { users } });
}

beforeEach(() => {
  localStorage.clear();
  signedInAs(ALICE);
});

describe('the list', () => {
  it('shows everybody, their role, when they were made and when they were last seen', async () => {
    serve({ 'GET /api/users': listing([ALICE, { ...BOB, disabled: true }]) });
    show();

    await screen.findByText('alice');
    expect(screen.getByLabelText('Role for alice')).toHaveValue('admin');
    expect(screen.getByLabelText('Role for bob')).toHaveValue('member');
    // The reader is marked, and so is an account nobody can sign in to.
    expect(screen.getByText('you')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    expect(screen.getByText('never')).toBeInTheDocument();
    expect(screen.getByText('2 people')).toBeInTheDocument();
  });

  it('refuses a member outright, with a way back', () => {
    serve({});
    signedInAs(BOB);
    show();
    expect(screen.getByText('Users is for administrators')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the flows' })).toHaveAttribute(
      'href',
      '/flows',
    );
  });
});

describe('adding somebody', () => {
  it('makes the password itself and shows it exactly once', async () => {
    const user = userEvent.setup();
    let users = [ALICE];
    serve({
      'GET /api/users': () => ({ body: { users } }),
      'POST /api/users': (body) => {
        const asked = body as { name: string; role: string };
        users = [ALICE, { ...BOB, name: asked.name, role: 'member' }];
        return { status: 201, body: users[1] };
      },
    });
    show();
    await screen.findByText('alice');

    await user.click(screen.getByRole('button', { name: /Add a user/ }));
    await user.type(screen.getByLabelText('Name'), 'Carol');
    await user.click(screen.getByRole('button', { name: 'Add the user' }));

    const sent = bodyOf('POST /api/users');
    await waitFor(() => {
      expect(screen.getByText(/is shown once/)).toBeInTheDocument();
    });
    expect(sent?.name).toBe('carol');
    expect(sent?.role).toBe('member');
    // The password on screen is the one that was sent, and it is long enough to be one.
    const password = String(sent?.password);
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(screen.getByText(password)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.getByText('carol')).toBeInTheDocument();
    });
    expect(screen.queryByText(password)).not.toBeInTheDocument();
  });

  it('shows what the server says about a name it will not take', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/users': listing([ALICE]),
      'POST /api/users': () => ({
        status: 400,
        body: { error: { type: 'BadRequest', message: "'alice' is taken" } },
      }),
    });
    show();
    await screen.findByText('alice');

    await user.click(screen.getByRole('button', { name: /Add a user/ }));
    await user.type(screen.getByLabelText('Name'), 'alice');
    await user.click(screen.getByRole('button', { name: 'Add the user' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('is taken');
    });
  });
});

describe('changing somebody', () => {
  it('sends the new role, and the disabled flag, one field at a time', async () => {
    const user = userEvent.setup();
    let bob = { ...BOB };
    serve({
      'GET /api/users': () => ({ body: { users: [ALICE, bob] } }),
      'PUT /api/users/2': (body) => {
        bob = { ...bob, ...(body as Partial<User>) };
        return { body: bob };
      },
    });
    show();
    await screen.findByText('bob');

    await user.selectOptions(screen.getByLabelText('Role for bob'), 'admin');
    await waitFor(() => {
      expect(bodyOf('PUT /api/users/2')).toEqual({ role: 'admin' });
    });

    await user.click(screen.getByRole('switch', { name: 'Disable bob' }));
    await waitFor(() => {
      expect(bodyOf('PUT /api/users/2')).toEqual({ disabled: true });
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable bob' })).toBeInTheDocument();
    });
  });

  it('resets a password to one it shows once', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/users': listing([ALICE, BOB]),
      'PUT /api/users/2': () => ({ body: { ...BOB, must_change_password: true } }),
    });
    show();
    await screen.findByText('bob');

    const row = screen.getByText('bob').closest('div');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /A new password for bob/ })).toBeInTheDocument();
    });
    const sent = String(bodyOf('PUT /api/users/2')?.password);
    expect(sent.length).toBeGreaterThanOrEqual(8);
    expect(screen.getByText(sent)).toBeInTheDocument();
  });

  it('shows a refusal on the row it was refused for', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/users': listing([ALICE, BOB]),
      'PUT /api/users/1': () => ({
        status: 400,
        body: {
          error: {
            type: 'BadRequest',
            message:
              'alice is the last administrator who can sign in; make somebody else an administrator first',
          },
        },
      }),
    });
    show();
    await screen.findByText('alice');

    await user.selectOptions(screen.getByLabelText('Role for alice'), 'member');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('last administrator');
    });
  });
});

describe('deleting somebody', () => {
  it('asks first, then does it', async () => {
    const user = userEvent.setup();
    let users = [ALICE, BOB];
    serve({
      'GET /api/users': () => ({ body: { users } }),
      'DELETE /api/users/2': () => {
        users = [ALICE];
        return { body: { ok: true } };
      },
    });
    show();
    await screen.findByText('bob');

    await user.click(screen.getByRole('button', { name: 'Delete bob' }));
    expect(screen.getByRole('dialog', { name: 'Delete bob?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete the user' }));

    await waitFor(() => {
      expect(screen.queryByText('bob')).not.toBeInTheDocument();
    });
    expect(seen.some((call) => call.key === 'DELETE /api/users/2')).toBe(true);
  });

  it('shows what the server said when it will not', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/users': listing([ALICE, BOB]),
      'DELETE /api/users/1': () => ({
        status: 400,
        body: {
          error: {
            type: 'BadRequest',
            message:
              'you cannot delete yourself; another administrator can, or disable the account',
          },
        },
      }),
    });
    show();
    await screen.findByText('alice');

    await user.click(screen.getByRole('button', { name: 'Delete alice' }));
    await user.click(screen.getByRole('button', { name: 'Delete the user' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('cannot delete yourself');
    });
  });
});
