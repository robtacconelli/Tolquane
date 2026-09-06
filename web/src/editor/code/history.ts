/**
 * Undo and redo for the code editor.
 *
 * CodeMirror's own history package is not one of this app's dependencies and a flow file
 * is a few kilobytes, so the cheapest correct history is the honest one: keep the
 * document as it was and put it back. A run of typing inside half a second collapses into
 * one step, so undo moves by words rather than by letters.
 *
 * A document that arrives from outside the editor -- a save, a regeneration from the
 * canvas, "take theirs" -- is marked `external` and clears the stack: it is not this
 * person's typing, and undoing into it would put back text nobody wrote.
 */

import {
  Annotation,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type StateCommand,
} from '@codemirror/state';
import { keymap } from '@codemirror/view';

/** Set on every transaction the editor did not get from the keyboard. */
export const external = Annotation.define<boolean>();

/** Set on the transactions history dispatches itself, so it does not record its own work. */
const fromHistory = Annotation.define<boolean>();

interface Entry {
  doc: string;
  anchor: number;
  head: number;
  at: number;
}

export interface HistoryState {
  done: Entry[];
  undone: Entry[];
}

const EMPTY: HistoryState = { done: [], undone: [] };

const setHistory = StateEffect.define<HistoryState>();
const clearHistory = StateEffect.define<null>();

/** How long a run of typing stays one undo step. */
export const GROUP_MS = 500;
const LIMIT = 200;

function entryOf(state: EditorState, at: number): Entry {
  const range = state.selection.main;
  return { doc: state.doc.toString(), anchor: range.anchor, head: range.head, at };
}

/** Typing joins the step before it; anything else starts a new one. */
function joins(previous: Entry, at: number, kind: 'type' | 'delete' | 'other'): boolean {
  return kind !== 'other' && at - previous.at <= GROUP_MS;
}

export const historyField = StateField.define<HistoryState>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(clearHistory)) return EMPTY;
      if (effect.is(setHistory)) return effect.value;
    }
    if (!tr.docChanged) return value;
    if (tr.annotation(fromHistory) === true) return value;
    if (tr.annotation(external) === true) return EMPTY;
    const at = Date.now();
    const kind = tr.isUserEvent('input.type')
      ? 'type'
      : tr.isUserEvent('delete')
        ? 'delete'
        : 'other';
    const previous = value.done[value.done.length - 1];
    // Grouping keeps the *older* document (the step's starting point) and only moves its
    // clock forward, so a burst of keystrokes undoes back to where the burst began.
    const done =
      previous && joins(previous, at, kind)
        ? [...value.done.slice(0, -1), { ...previous, at }]
        : [...value.done, entryOf(tr.startState, at)].slice(-LIMIT);
    return { done, undone: [] };
  },
});

function step(from: 'done' | 'undone'): StateCommand {
  return (target) => {
    const state = target.state;
    const history = state.field(historyField, false);
    if (!history) return false;
    const stack = history[from];
    const entry = stack[stack.length - 1];
    if (!entry) return false;
    const back = entryOf(state, Date.now());
    const next: HistoryState =
      from === 'done'
        ? { done: stack.slice(0, -1), undone: [...history.undone, back] }
        : { done: [...history.done, back], undone: stack.slice(0, -1) };
    const at = (position: number): number => Math.min(position, entry.doc.length);
    target.dispatch(
      state.update({
        changes: { from: 0, to: state.doc.length, insert: entry.doc },
        selection: { anchor: at(entry.anchor), head: at(entry.head) },
        annotations: fromHistory.of(true),
        effects: setHistory.of(next),
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

/** Undo one step of typing. */
export const undoCode: StateCommand = step('done');
/** Put back what `undoCode` took away. */
export const redoCode: StateCommand = step('undone');

/** Drop everything the editor remembers: the document came from somewhere else. */
export function resetHistory(): StateEffect<null> {
  return clearHistory.of(null);
}

/** True when there is a step to undo, for a toolbar that wants to grey a button out. */
export function canUndoCode(state: EditorState): boolean {
  return (state.field(historyField, false)?.done.length ?? 0) > 0;
}

export function codeHistory(): Extension {
  return [
    historyField,
    keymap.of([
      { key: 'Mod-z', run: undoCode, preventDefault: true },
      { key: 'Mod-Shift-z', run: redoCode, preventDefault: true },
      { key: 'Mod-y', run: redoCode, preventDefault: true },
    ]),
  ];
}
