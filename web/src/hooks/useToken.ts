import { useSyncExternalStore } from 'react';
import { isUnauthorized, subscribeToken, tokenGeneration } from '../api/token';

/*
 * The two facts about the server token that React needs to re-render on. The token
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
