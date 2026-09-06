/**
 * The bearer token a server started with `--token` wants on every request.
 *
 * `tolquane web --token …` is how a shared machine is served, and the browser has no
 * login to get one from: the token is pasted in once and kept in this browser, next to
 * the theme. It reaches the server three ways, because the three transports the app uses
 * can carry it three different ways:
 *
 *  - `Authorization: Bearer …` on every `fetch` (`client.ts`, and the chat stream in
 *    `ai.ts`, which reads the body itself and so does its own request);
 *  - `?token=…` on the run WebSocket and the trace download (`runs.ts`), because neither
 *    a `WebSocket` nor a link can set a header.
 *
 * This module is deliberately not a React store: `request()` has to read the token from
 * anywhere, with no hook. The subscription exists so the shell can notice a 401 and ask
 * for a token, and can retry what failed once one arrives.
 */

export const TOKEN_KEY = 'tolquane.token';

type Listener = () => void;

const listeners = new Set<Listener>();
let refused = false;
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

/** Remember a token, or forget it. Clears the refusal and retries what failed. */
export function setApiToken(token: string | null): void {
  try {
    if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* kept for this page only */
  }
  refused = false;
  generation += 1;
  notify();
}

/**
 * A request came back 401. Called by the transports, read by the shell, which asks for
 * a token. Repeat 401s while the prompt is already up change nothing.
 */
export function reportUnauthorized(): void {
  if (refused) return;
  refused = true;
  notify();
}

/** The shell was shown the prompt and the reader closed it without a token. */
export function clearUnauthorized(): void {
  if (!refused) return;
  refused = false;
  notify();
}

export function isUnauthorized(): boolean {
  return refused;
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
