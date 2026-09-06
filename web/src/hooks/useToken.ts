import { useSyncExternalStore } from 'react';
import { isSignInNeeded, isUnauthorized, subscribeToken, tokenGeneration } from '../api/token';

/*
 * The three facts about the server token that React needs to re-render on. The token
 * itself is not a store (see `api/token.ts`: `request()` reads it with no hook), so these
 * subscribe to it from the outside.
 */

/** True while a request has come back 401 and no token has been accepted since. */
export function useUnauthorized(): boolean {
  return useSyncExternalStore(subscribeToken, isUnauthorized, () => false);
}

/** Bumped whenever the token changes: what the shell remounts the open page on. */
export function useTokenGeneration(): number {
  return useSyncExternalStore(subscribeToken, tokenGeneration, () => 0);
}

/**
 * True when a 401 arrived on a server with users: the session is over and the shell
 * sends the reader to `/login`. The token dialog is for the other kind of server.
 */
export function useSignInNeeded(): boolean {
  return useSyncExternalStore(subscribeToken, isSignInNeeded, () => false);
}
