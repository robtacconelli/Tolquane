import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The handful of actions the command palette cannot reach on its own.
 *
 * Most of what the palette does is a route change or a store write, and stores are
 * global, so it just does them. Running and cancelling a flow are the exception: they
 * belong to the run button, which owns the request, the abort and the busy flag. Rather
 * than lifting all of that into a store to be called from one menu, the button registers
 * its own action while it is on screen and takes it back when it leaves.
 */

export type CommandId = 'run' | 'cancel' | 'check' | 'save';

/**
 * A dialog the palette asked a page to open on arrival.
 *
 * The palette navigates; the page that lands owns the dialog. The page reads this once
 * on the way in and clears it, so a reload or a step back does not open it again.
 */
export type Intent = { kind: 'new-flow' } | { kind: 'schedule'; flow: string };

export interface CommandsState {
  handlers: Partial<Record<CommandId, () => void>>;
  intent: Intent | null;
  register: (id: CommandId, handler: () => void) => void;
  unregister: (id: CommandId) => void;
  ask: (intent: Intent) => void;
  clearIntent: () => void;
}

export const useCommandsStore = create<CommandsState>((set) => ({
  handlers: {},
  intent: null,
  register: (id, handler) => {
    set((state) => ({ handlers: { ...state.handlers, [id]: handler } }));
  },
  unregister: (id) => {
    set((state) => {
      const handlers = { ...state.handlers };
      delete handlers[id];
      return { handlers };
    });
  },
  ask: (intent) => {
    set({ intent });
  },
  clearIntent: () => {
    set({ intent: null });
  },
}));

/**
 * Take the intent waiting for this page, if it is of `kind`.
 *
 * Called from a `useState` initialiser (the page is opening for it) and from a store
 * subscription (the page was already there); both read it and clear it in one go.
 */
export function takeIntent<K extends Intent['kind']>(
  kind: K,
  intent: Intent | null = useCommandsStore.getState().intent,
): Extract<Intent, { kind: K }> | null {
  if (intent?.kind !== kind) return null;
  useCommandsStore.getState().clearIntent();
  return intent as Extract<Intent, { kind: K }>;
}

/** Offer `handler` as `id` for as long as the component is mounted. */
export function useCommand(id: CommandId, handler: (() => void) | null): void {
  useEffect(() => {
    if (!handler) return;
    const { register, unregister } = useCommandsStore.getState();
    register(id, handler);
    return () => {
      unregister(id);
    };
  }, [id, handler]);
}
