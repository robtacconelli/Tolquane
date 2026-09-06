/**
 * The editor's own behaviour, without a browser: history, search, indentation.
 *
 * All three are commands over an `EditorState`, so they can be driven exactly as a
 * keystroke drives them and asserted on the document that comes out.
 */

import { python } from '@codemirror/lang-python';
import { indentUnit } from '@codemirror/language';
import { EditorState, type Transaction } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_MS, codeHistory, external, redoCode, undoCode } from './history';
import { indentLess, indentMore, newlineAndIndent, toggleComment } from './keymap';
import { currentMatch, matchesOf } from './search';

/** A command's target: the state, and somewhere for the transaction to land. */
function driver(state: EditorState) {
  const target = {
    state,
    dispatch: (tr: Transaction) => {
      target.state = tr.state;
    },
  };
  return target;
}

function type(state: EditorState, at: number, text: string): EditorState {
  return state.update({ changes: { from: at, insert: text }, userEvent: 'input.type' }).state;
}

describe('undo and redo', () => {
  const start = (doc: string): EditorState =>
    EditorState.create({ doc, extensions: [codeHistory()] });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('puts back what was typed, one burst at a time', () => {
    let state = start('x = 1');
    state = type(state, 5, '0');
    state = type(state, 6, '0');
    const target = driver(state);

    expect(undoCode(target)).toBe(true);
    expect(target.state.doc.toString()).toBe('x = 1');
    expect(undoCode(target)).toBe(false);
  });

  it('starts a new step once the typing pauses', () => {
    let state = start('x = 1');
    state = type(state, 5, '0');
    vi.advanceTimersByTime(GROUP_MS + 100);
    state = type(state, 6, '0');
    const target = driver(state);

    expect(undoCode(target)).toBe(true);
    expect(target.state.doc.toString()).toBe('x = 10');
    expect(undoCode(target)).toBe(true);
    expect(target.state.doc.toString()).toBe('x = 1');
  });

  it('redoes what it undid', () => {
    const target = driver(type(start('a'), 1, 'b'));
    undoCode(target);
    expect(target.state.doc.toString()).toBe('a');
    expect(redoCode(target)).toBe(true);
    expect(target.state.doc.toString()).toBe('ab');
  });

  it('forgets the stack when the document comes from somewhere else', () => {
    let state = type(start('a'), 1, 'b');
    state = state.update({
      changes: { from: 0, to: state.doc.length, insert: '# regenerated' },
      annotations: external.of(true),
    }).state;
    expect(undoCode(driver(state))).toBe(false);
  });
});

describe('typing Python', () => {
  // The indentation is the language's, so the language has to be there for it to be asked.
  const PYTHON = [python(), indentUnit.of('    ')];
  const start = (doc: string, at = doc.length): EditorState =>
    EditorState.create({ doc, selection: { anchor: at }, extensions: PYTHON });

  it('indents the next line under a block that just opened', () => {
    const target = driver(start('def f():'));
    expect(newlineAndIndent(target)).toBe(true);
    expect(target.state.doc.toString()).toBe('def f():\n    ');
  });

  it('moves to the next stop with Tab and back with Shift-Tab', () => {
    const target = driver(start('x'));
    indentMore(target);
    expect(target.state.doc.toString()).toBe('x   ');
    const line = driver(
      EditorState.create({ doc: '    x = 1', selection: { anchor: 9 }, extensions: PYTHON }),
    );
    expect(indentLess(line)).toBe(true);
    expect(line.state.doc.toString()).toBe('x = 1');
  });

  it('comments a run of lines out and back in', () => {
    const doc = '    a = 1\n    b = 2';
    const target = driver(
      EditorState.create({ doc, selection: { anchor: 0, head: doc.length }, extensions: PYTHON }),
    );
    expect(toggleComment(target)).toBe(true);
    expect(target.state.doc.toString()).toBe('    # a = 1\n    # b = 2');
    toggleComment(target);
    expect(target.state.doc.toString()).toBe(doc);
  });
});

describe('find in this file', () => {
  const doc = 'farm(words, 2)\nfarm(Count, 3)\nFARM';

  it('finds every match, case sensitive or not', () => {
    expect(matchesOf(doc, 'farm', true)).toEqual([
      [0, 4],
      [15, 19],
    ]);
    expect(matchesOf(doc, 'farm', false)).toHaveLength(3);
    expect(matchesOf(doc, '', false)).toEqual([]);
  });

  it('wraps round the ends', () => {
    const found = matchesOf(doc, 'farm', true);
    expect(currentMatch(found, 0)?.at).toBe(0);
    expect(currentMatch(found, 2)?.at).toBe(0);
    expect(currentMatch(found, -1)?.at).toBe(1);
    expect(currentMatch([], 0)).toBeNull();
  });
});
