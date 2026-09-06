/**
 * The keys a Python editor needs: Enter that indents, Tab that moves by four, and
 * Cmd/Ctrl+/ that comments a block out.
 *
 * These are the handful of commands the app uses, written against the language's own
 * indentation service so `def`, `for` and a hanging bracket all behave.
 */

import { IndentContext, getIndentation, indentString, indentUnit } from '@codemirror/language';
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type StateCommand,
} from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';

/** The lines a selection touches, once each. */
function linesOf(state: EditorState): { from: number; to: number; number: number; text: string }[] {
  const seen = new Set<number>();
  const out: { from: number; to: number; number: number; text: string }[] = [];
  for (const range of state.selection.ranges) {
    let position = range.from;
    do {
      const line = state.doc.lineAt(position);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        out.push({ from: line.from, to: line.to, number: line.number, text: line.text });
      }
      position = line.to + 1;
    } while (position <= range.to);
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Enter: a new line, indented the way the language says this one should continue. */
export const newlineAndIndent: StateCommand = (target) => {
  const state = target.state;
  if (state.readOnly) return false;
  const changes = state.changeByRange((range) => {
    const context = new IndentContext(state, { simulateBreak: range.from });
    const indent = getIndentation(context, range.from) ?? 0;
    const insert = state.lineBreak + indentString(state, indent);
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  target.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

function unitOf(state: EditorState): string {
  return state.facet(indentUnit);
}

/** Tab: indent the lines under the selection, or move to the next stop. */
export const indentMore: StateCommand = (target) => {
  const state = target.state;
  if (state.readOnly) return false;
  const unit = unitOf(state);
  const range = state.selection.main;
  if (range.empty && state.selection.ranges.length === 1) {
    const line = state.doc.lineAt(range.head);
    const column = range.head - line.from;
    const insert = unit.slice(0, Math.max(1, unit.length - (column % unit.length)));
    target.dispatch(
      state.update({
        changes: { from: range.head, insert },
        selection: { anchor: range.head + insert.length },
        userEvent: 'input.indent',
      }),
    );
    return true;
  }
  const changes: ChangeSpec[] = linesOf(state).map((line) => ({ from: line.from, insert: unit }));
  target.dispatch(state.update({ changes, userEvent: 'input.indent' }));
  return true;
};

/** Shift-Tab: take one indent unit off every line the selection touches. */
export const indentLess: StateCommand = (target) => {
  const state = target.state;
  if (state.readOnly) return false;
  const unit = unitOf(state);
  const changes: ChangeSpec[] = [];
  for (const line of linesOf(state)) {
    const blank = /^[ \t]*/.exec(line.text)?.[0] ?? '';
    if (blank === '') continue;
    const take = blank.startsWith(unit) ? unit.length : Math.min(blank.length, unit.length);
    changes.push({ from: line.from, to: line.from + take });
  }
  if (changes.length === 0) return false;
  target.dispatch(state.update({ changes, userEvent: 'delete.dedent' }));
  return true;
};

/** Cmd/Ctrl+/: comment the selected lines out, or put them back. */
export const toggleComment: StateCommand = (target) => {
  const state = target.state;
  if (state.readOnly) return false;
  const lines = linesOf(state).filter((line) => line.text.trim() !== '');
  if (lines.length === 0) return false;
  const commented = lines.every((line) => line.text.trimStart().startsWith('#'));
  const changes: ChangeSpec[] = [];
  if (commented) {
    for (const line of lines) {
      const at = line.from + (/^[ \t]*/.exec(line.text)?.[0].length ?? 0);
      const rest = state.doc.sliceString(at, line.to);
      changes.push({ from: at, to: at + (rest.startsWith('# ') ? 2 : 1) });
    }
  } else {
    const column = Math.min(...lines.map((line) => /^[ \t]*/.exec(line.text)?.[0].length ?? 0));
    for (const line of lines) changes.push({ from: line.from + column, insert: '# ' });
  }
  target.dispatch(state.update({ changes, userEvent: commented ? 'delete' : 'input' }));
  return true;
};

const selectAll: StateCommand = (target) => {
  const state = target.state;
  target.dispatch(state.update({ selection: { anchor: 0, head: state.doc.length } }));
  return true;
};

export const CODE_KEYMAP: readonly KeyBinding[] = [
  { key: 'Enter', run: newlineAndIndent, shift: newlineAndIndent },
  { key: 'Tab', run: indentMore, shift: indentLess, preventDefault: true },
  { key: 'Mod-/', run: toggleComment, preventDefault: true },
  { key: 'Mod-a', run: selectAll },
];

export const codeKeymap = keymap.of([...CODE_KEYMAP]);
