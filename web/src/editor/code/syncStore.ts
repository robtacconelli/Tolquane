/**
 * What the code view is doing right now: parsing, generating, or waiting for someone to
 * decide whose version of the file wins.
 *
 * It is a store of its own rather than more fields on the flow store because none of it
 * is the flow: it is the state of the requests that keep the text and the model looking
 * at the same thing. Nothing here imports CodeMirror, so the editor page can drive the
 * sync without pulling the editor into the main bundle.
 */

import { create } from 'zustand';

export type SyncPhase = 'idle' | 'parsing' | 'generating';

/** The file changed on disk while it was open: two versions, one file. */
export interface Conflict {
  path: string;
  /** The text in the editor. */
  mine: string;
  /** The text on disk now. */
  theirs: string;
  /** The stamp that goes with `theirs`; saving over it needs this one. */
  modified: string;
}

export interface CodeSyncState {
  phase: SyncPhase;
  /** A request that failed outright, in words worth showing. */
  failure: string | null;
  /** A counter bumped on every keystroke in the file editor; the driver debounces off it. */
  typed: number;
  /** The next generation should be checked by a parse: a node body was rewritten. */
  verify: boolean;
  conflict: Conflict | null;
  /**
   * The file editor should scroll somewhere: to a node's definition, or to a line. A new
   * token repeats the move, so asking twice for the same place works.
   */
  reveal: { id: string | null; line: number | null; token: number } | null;

  markTyped: () => void;
  markNodeTyped: () => void;
  setPhase: (phase: SyncPhase) => void;
  setFailure: (failure: string | null) => void;
  takeVerify: () => boolean;
  openConflict: (conflict: Conflict) => void;
  closeConflict: () => void;
  revealNode: (id: string) => void;
  revealLine: (line: number) => void;
  reset: () => void;
}

const INITIAL = {
  phase: 'idle' as SyncPhase,
  failure: null,
  typed: 0,
  verify: false,
  conflict: null,
  reveal: null,
};

export const useCodeSyncStore = create<CodeSyncState>((set, get) => ({
  ...INITIAL,

  markTyped: () => set((state) => ({ typed: state.typed + 1, failure: null })),
  markNodeTyped: () => set({ verify: true, failure: null }),
  setPhase: (phase) => set({ phase }),
  setFailure: (failure) => set({ failure }),
  takeVerify: () => {
    const { verify } = get();
    if (verify) set({ verify: false });
    return verify;
  },
  openConflict: (conflict) => set({ conflict, phase: 'idle' }),
  closeConflict: () => set({ conflict: null }),
  revealNode: (id) =>
    set((state) => ({ reveal: { id, line: null, token: (state.reveal?.token ?? 0) + 1 } })),
  revealLine: (line) =>
    set((state) => ({ reveal: { id: null, line, token: (state.reveal?.token ?? 0) + 1 } })),
  reset: () => set({ ...INITIAL }),
}));

/** How the code view says, in three words, whether the canvas is looking at this text. */
export interface Status {
  tone: 'synced' | 'busy' | 'warning';
  text: string;
}

/** The one line at the top right that says whether the canvas is looking at this text. */
export function statusOf(input: {
  phase: SyncPhase;
  failure: string | null;
  codeOnly: string | null;
}): Status {
  if (input.phase === 'parsing') return { tone: 'busy', text: 'Reading the flow…' };
  if (input.phase === 'generating') return { tone: 'busy', text: 'Writing the code…' };
  if (input.failure !== null) return { tone: 'warning', text: 'Not in sync' };
  if (input.codeOnly !== null) return { tone: 'warning', text: 'Canvas read-only' };
  return { tone: 'synced', text: 'Canvas in sync' };
}
