import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changePassword,
  createToken,
  deleteToken,
  getMe,
  listTokens,
  login,
  logout,
  setup,
} from './auth';
import { ApiError, request } from './client';
import {
  TOKEN_KEY,
  clearUnauthorized,
  isSignInNeeded,
  isUnauthorized,
  setApiToken,
  setServerMode,
} from './token';
import { createUser, deleteUser, listUsers, updateUser } from './users';

/* The wrappers of docs/web-interfaces.md, U, and the one piece of behaviour that is not
 * a wrapper: what a 401 means, which is not the same thing on the three kinds of server. */

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const seen: { method: string; path: string; body: unknown }[] = [];

function serve(reply: () => { status?: number; body: unknown }): void {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), 'http://localhost');
      seen.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const answer = reply();
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  setServerMode(null);
  clearUnauthorized();
  serve(() => ({ body: { ok: true } }));
});

describe('the auth wrappers', () => {
  it('each ask for the route the contract names', async () => {
    await getMe();
    await login('alice', 'secret123');
    await logout();
    await setup('alice', 'secret123');
    await changePassword('old', 'new-one-please');
    await listTokens();
    await createToken('nightly');
    await deleteToken(7);

    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/auth/me',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/setup',
      'POST /api/auth/password',
      'GET /api/auth/tokens',
      'POST /api/auth/tokens',
      'DELETE /api/auth/tokens/7',
    ]);
    expect(seen[1]?.body).toEqual({ name: 'alice', password: 'secret123' });
    // The field is `new`, which is a keyword everywhere but on the wire.
    expect(seen[4]?.body).toEqual({ current: 'old', new: 'new-one-please' });
    expect(seen[6]?.body).toEqual({ label: 'nightly' });
  });
});

describe('the users wrappers', () => {
  it('each ask for the route the contract names', async () => {
    await listUsers();
    await createUser({ name: 'bob', role: 'member', password: 'temporary1' });
    await updateUser(2, { role: 'admin' });
    await updateUser(2, { disabled: true });
    await deleteUser(2);

    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/users',
      'POST /api/users',
      'PUT /api/users/2',
      'PUT /api/users/2',
      'DELETE /api/users/2',
    ]);
    expect(seen[1]?.body).toEqual({ name: 'bob', role: 'member', password: 'temporary1' });
    expect(seen[2]?.body).toEqual({ role: 'admin' });
    expect(seen[3]?.body).toEqual({ disabled: true });
  });
});

describe('a 401', () => {
  beforeEach(() => {
    serve(() => ({ status: 401, body: { error: { type: 'Unauthorized', message: 'no' } } }));
  });

  it('asks for the server token when the mode is not known yet', async () => {
    await expect(request('/flows')).rejects.toBeInstanceOf(ApiError);
    expect(isUnauthorized()).toBe(true);
    expect(isSignInNeeded()).toBe(false);
  });

  it('asks for the server token on a --token server', async () => {
    setServerMode('token');
    await expect(request('/flows')).rejects.toBeInstanceOf(ApiError);
    expect(isUnauthorized()).toBe(true);
    expect(isSignInNeeded()).toBe(false);
  });

  it('sends the reader to sign in, and forgets the dead session, on a users server', async () => {
    setServerMode('users');
    setApiToken('a-session-that-has-ended');
    await expect(request('/flows')).rejects.toBeInstanceOf(ApiError);
    expect(isSignInNeeded()).toBe(true);
    expect(isUnauthorized()).toBe(false);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('turns a token prompt into a sign-in when the mode arrives afterwards', async () => {
    await expect(request('/flows')).rejects.toBeInstanceOf(ApiError);
    expect(isUnauthorized()).toBe(true);
    setServerMode('users');
    expect(isUnauthorized()).toBe(false);
    expect(isSignInNeeded()).toBe(true);
  });

  it('is an answer, not a lost session, on the three routes about a password', async () => {
    setServerMode('users');
    await expect(login('alice', 'wrong')).rejects.toBeInstanceOf(ApiError);
    await expect(changePassword('wrong', 'another-one')).rejects.toBeInstanceOf(ApiError);
    await expect(setup('alice', 'wrong')).rejects.toBeInstanceOf(ApiError);
    expect(isSignInNeeded()).toBe(false);
    expect(isUnauthorized()).toBe(false);
  });
});
