import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api/auth';
import {
  TOKEN_KEY,
  clearUnauthorized,
  isSignInNeeded,
  isUnauthorized,
  serverMode,
  setServerMode,
} from '../api/token';
import { isAdmin, loadAuth, mode, useAuthStore } from './auth';

/* Who is signed in and what kind of server this is, from the one question that answers
 * both: `GET /api/auth/me` (docs/web-interfaces.md, U). */

const ALICE: User = {
  id: 1,
  name: 'alice',
  role: 'admin',
  created: '2026-09-01T10:00:00Z',
  disabled: false,
  must_change_password: false,
  last_seen: '2026-09-06T10:00:00Z',
};

function answer(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  setServerMode(null);
  clearUnauthorized();
  useAuthStore.setState({
    status: 'loading',
    mode: null,
    user: null,
    canSetup: false,
    error: null,
  });
});

describe('loading who the caller is', () => {
  it('reads the implicit administrator of a local server', async () => {
    answer({
      user: { ...ALICE, id: 0, name: 'local' },
      mode: 'local',
      can_setup: false,
    });
    await loadAuth();
    expect(useAuthStore.getState().status).toBe('ready');
    expect(mode()).toBe('local');
    expect(isAdmin()).toBe(true);
    // The transports need the mode too, and they cannot read a store.
    expect(serverMode()).toBe('local');
  });

  it('reads a users server with nobody signed in', async () => {
    answer({ user: null, mode: 'users', can_setup: false });
    await loadAuth();
    expect(mode()).toBe('users');
    expect(useAuthStore.getState().user).toBeNull();
    expect(isAdmin()).toBe(false);
  });

  it('reads a member as a member', async () => {
    answer({ user: { ...ALICE, id: 2, name: 'bob', role: 'member' }, mode: 'users' });
    await loadAuth();
    expect(useAuthStore.getState().user?.name).toBe('bob');
    expect(isAdmin()).toBe(false);
  });

  it('reads the setup offer of a --token server', async () => {
    answer({ user: { ...ALICE, id: 0, name: 'token' }, mode: 'token', can_setup: true });
    await loadAuth();
    expect(mode()).toBe('token');
    expect(useAuthStore.getState().canSetup).toBe(true);
  });

  it('leaves the mode unknown when the answer is a 401, and asks for no sign-in', async () => {
    answer({ error: { type: 'Unauthorized', message: 'a token is required' } }, 401);
    await loadAuth();
    expect(useAuthStore.getState().status).toBe('ready');
    expect(mode()).toBeNull();
    // A --token server keeps `me` behind the token as well: the token dialog is the answer.
    expect(isUnauthorized()).toBe(true);
    expect(isSignInNeeded()).toBe(false);
  });

  it('says the server is unreachable rather than that nobody is signed in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await loadAuth();
    expect(useAuthStore.getState().status).toBe('unreachable');
    expect(mode()).toBeNull();
    expect(isSignInNeeded()).toBe(false);
  });

  it('ignores a mode it does not know rather than demanding a sign-in for it', async () => {
    answer({ ok: true, version: '1.1.0', runs_live: 0 });
    await loadAuth();
    expect(mode()).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe('signing in and out', () => {
  it('keeps the session token where every request will find it', async () => {
    answer({ token: 'session-token', user: ALICE });
    const user = await useAuthStore.getState().signIn('alice', 'alicepass1');
    expect(user.name).toBe('alice');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
    expect(mode()).toBe('users');
    expect(serverMode()).toBe('users');
    expect(isAdmin()).toBe(true);
  });

  it('makes the first administrator the same way', async () => {
    answer({ token: 'session-token', user: ALICE });
    await useAuthStore.getState().createFirstAdmin('alice', 'alicepass1');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
    expect(useAuthStore.getState().canSetup).toBe(false);
  });

  it('keeps nothing when the pair is refused', async () => {
    answer(
      { error: { type: 'Unauthorized', message: 'that name and password do not go together' } },
      401,
    );
    await expect(useAuthStore.getState().signIn('alice', 'wrong')).rejects.toThrow(
      'that name and password do not go together',
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    // A wrong password is not a lost session: nothing has been asked for.
    expect(isSignInNeeded()).toBe(false);
  });

  it('forgets the token on the way out, even when the server has already forgotten it', async () => {
    answer({ token: 'session-token', user: ALICE });
    await useAuthStore.getState().signIn('alice', 'alicepass1');
    answer({ error: { type: 'Unauthorized', message: 'gone' } }, 401);
    await useAuthStore.getState().signOut();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });
});
