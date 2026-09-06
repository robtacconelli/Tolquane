/**
 * The bearer token this browser sends, and what to do when the server refuses it.
 *
 * There are two kinds of token and one slot. `tolquane web --token …` is how a shared
 * machine was served in 1.2: the token is a string the person who started the server
 * already has, pasted in once. A server with users (1.3) issues a session token at
 * `POST /api/auth/login` instead. Both travel the same way, so both live here, under the
 * same key:
 *
 *  - `Authorization: Bearer …` on every `fetch` (`client.ts`, and the chat stream in
 *    `ai.ts`, which reads the body itself and so does its own request);
 *  - `?token=…` on the run WebSocket and the trace download (`runs.ts`), because neither
 *    a `WebSocket` nor a link can set a header.
 *
 * What differs is the answer to a 401, and that is what `serverMode` is for. On a
 * `users` server a 401 means the session is over: forget it and send the reader to
 * `/login`. On a `token` server -- or before the mode is known, which is the same thing,
 * since a `--token` server will not even say who you are without it -- a 401 means this
 * browser has never been given the token, and the answer is the token dialog.
 *
 * This module is deliberately not a React store: `request()` has to read the token from
 * anywhere, with no hook. The subscriptions exist so the shell can notice both facts.
 */

import type { AuthMode } from './auth';

export const TOKEN_KEY = 'tolquane.token';

type Listener = () => void;

const listeners = new Set<Listener>();
let refused = false;
let signInNeeded = false;
let mode: AuthMode | null = null;
/** Bumped whenever the token changes: what the shell remounts its page on. */
let generation = 0;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The token this browser holds, or null. Site data can be blocked; that is no token. */
export function apiToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The header every request carries, or nothing at all when there is no token. */
export function authHeaders(): Record<string, string> {
  const token = apiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Remember a token, or forget it. Clears both refusals and retries what failed. */
export function setApiToken(token: string | null): void {
  try {
    if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* kept for this page only */
  }
  refused = false;
  signInNeeded = false;
  generation += 1;
  notify();
}

/**
 * What kind of server this is, as `GET /api/auth/me` answered it; `null` until it has.
 *
 * The auth store sets it: `api/` does not import a store, so the fact travels this way
 * rather than the other, and `request()` keeps reading it with no hook.
 */
export function setServerMode(next: AuthMode | null): void {
  if (mode === next) return;
  mode = next;
  // A server that turns out to have users cannot want the token dialog: whatever was
  // refused before the mode was known is a sign-in.
  if (mode === 'users' && refused) {
    refused = false;
    signInNeeded = true;
  }
  notify();
}

export function serverMode(): AuthMode | null {
  return mode;
}

/**
 * A request came back 401. Called by the transports, read by the shell.
 *
 * On a server with users this is a session that is over: the token it was carrying is
 * dead, so it goes, and the shell sends the reader to `/login`. Otherwise it is a server
 * that wants its `--token`, and the shell asks for it. Repeats while the question is
 * already on screen change nothing.
 */
export function reportUnauthorized(): void {
  if (mode === 'users') {
    if (signInNeeded) return;
    signInNeeded = true;
    try {
      globalThis.localStorage?.removeItem(TOKEN_KEY);
    } catch {
      /* there was nothing to forget */
    }
    notify();
    return;
  }
  if (refused) return;
  refused = true;
  notify();
}

/** The shell was shown the prompt and the reader closed it without a token. */
export function clearUnauthorized(): void {
  if (!refused && !signInNeeded) return;
  refused = false;
  signInNeeded = false;
  notify();
}

export function isUnauthorized(): boolean {
  return refused;
}

/** True while a 401 on a server with users is waiting to be answered at `/login`. */
export function isSignInNeeded(): boolean {
  return signInNeeded;
}

export function tokenGeneration(): number {
  return generation;
}

export function subscribeToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
