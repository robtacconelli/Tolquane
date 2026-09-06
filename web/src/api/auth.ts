/**
 * The authentication routes of docs/web-interfaces.md, U.
 *
 * The shapes come from the server's OpenAPI through `client.ts`'s `Schemas`; the two
 * unions are what the UI adds, because the server's models spell both as `str`: a role
 * is `admin` or `member`, and a server is in one of three modes. Everything else here is
 * one line over `request()`.
 *
 * `mode` is the page's first question, and the only one that can be asked before signing
 * in: `local` (no login at all: every request is the implicit admin `local`), `users`
 * (a session token is needed, on loopback too) and `token` (the `--token` value is the
 * only key there is, and the first administrator can be made from it).
 */
import { type Complete, type Schemas, api } from './client';

export type Role = 'admin' | 'member';

export type AuthMode = 'local' | 'users' | 'token';

/**
 * Somebody who can sign in.
 *
 * `id` is `0` for the two synthetic users -- `local` on a loopback server with no
 * accounts, and `token` for the `--token` value -- which are not people: they have no
 * password to change and no tokens of their own.
 */
export type User = Omit<Complete<Schemas['UserModel']>, 'role'> & { role: Role };

/** `GET /api/auth/me`: who the caller is, and what kind of server this is. */
export type Me = Omit<Complete<Schemas['MeResult']>, 'user' | 'mode'> & {
  user: User | null;
  mode: AuthMode;
};

/** A session: the token is shown once and kept in this browser, like the `--token` one. */
export type LoginResult = Omit<Complete<Schemas['LoginResult']>, 'user'> & { user: User };

/** A personal API token as it is listed: the token itself is not kept, so it is not here. */
export type ApiTokenRow = Complete<Schemas['TokenModel']>;

/** A token just made. `token` is the only time the string exists outside the script. */
export type IssuedToken = Complete<Schemas['IssuedToken']>;

export type ApiTokenList = Omit<Complete<Schemas['TokenList']>, 'tokens'> & {
  tokens: ApiTokenRow[];
};

/* The app waits for this one before it draws anything, so it does not wait long: a
 * server that is not answering is the shell's own offline state, not a blank page. */
export const getMe = () => api.get<Me>('/auth/me', { timeoutMs: 4000 });

export const login = (name: string, password: string) =>
  api.post<LoginResult>('/auth/login', { name, password } satisfies Schemas['LoginRequest']);

export const logout = () => api.post<Schemas['Ok']>('/auth/logout');

export const setup = (name: string, password: string) =>
  api.post<LoginResult>('/auth/setup', { name, password } satisfies Schemas['LoginRequest']);

export const changePassword = (current: string, next: string) =>
  api.post<Schemas['Ok']>('/auth/password', {
    current,
    new: next,
  } satisfies Schemas['PasswordChange']);

export const listTokens = () => api.get<ApiTokenList>('/auth/tokens');

export const createToken = (label: string) =>
  api.post<IssuedToken>('/auth/tokens', { label } satisfies Schemas['NewToken']);

export const deleteToken = (id: number) => api.delete<Schemas['Ok']>(`/auth/tokens/${id}`);
