/**
 * The code editor: CodeMirror 6, Python, the design tokens, and nothing that is not used.
 *
 * It is a controlled component -- `value` is the truth, `onChange` reports typing -- with
 * one rule that matters for the two-way sync: text that arrives through `value` is
 * dispatched with the `external` annotation, so it never comes back out through
 * `onChange` and never lands on the undo stack as if a person had typed it.
 */

import { indentOnInput, indentUnit, bracketMatching } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import { useEffect, useRef, type JSX } from 'react';
import { useUiStore } from '../../store/ui';
import styles from './code.module.css';
import { codeHistory, external, resetHistory } from './history';
import { codeKeymap } from './keymap';
import { codeProblems, revealLine, setProblems, type CodeProblem } from './problems';
import { codeSearch } from './search';
import { codeTheme } from './theme';

export type { CodeProblem };

export interface CodeMirrorProps {
  /** The text. Changing it replaces the document without disturbing the cursor. */
  value: string;
  /** Called on every change a person makes, never on one that came in through `value`. */
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** The property panel's density: smaller type, no line numbers, room for a few lines. */
  compact?: boolean;
  problems?: readonly CodeProblem[];
  /** Bring a one-based line into view; a new `token` repeats the move. */
  reveal?: { line: number; token: number } | null;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  autoFocus?: boolean;
}

interface Slots {
  theme: Compartment;
  editable: Compartment;
}

function extensions(props: {
  compact: boolean;
  readOnly: boolean;
  theme: 'light' | 'dark';
  placeholder: string | undefined;
  slots: Slots;
  onChange: (value: string) => void;
}): Extension[] {
  const { compact, readOnly, theme, slots, onChange } = props;
  return [
    python(),
    ...(compact
      ? // A body in a 320px panel has nowhere to scroll sideways to, so it wraps instead.
        [EditorView.lineWrapping]
      : [lineNumbers(), highlightActiveLineGutter(), codeProblems()]),
    highlightSpecialChars(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    indentOnInput(),
    indentUnit.of('    '),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(4),
    codeHistory(),
    codeSearch(),
    codeKeymap,
    ...(props.placeholder === undefined ? [] : [placeholderExtension(props.placeholder)]),
    slots.theme.of(codeTheme(theme, compact)),
    slots.editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.some((tr) => tr.annotation(external) === true)) return;
      onChange(update.state.doc.toString());
    }),
  ];
}

export function CodeMirror({
  value,
  onChange,
  readOnly = false,
  compact = false,
  problems,
  reveal = null,
  placeholder,
  ariaLabel,
  className,
  autoFocus = false,
}: CodeMirrorProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The callback changes on every render of the page; the editor is built once.
  const latest = useRef(onChange);
  const theme = useUiStore((state) => state.theme);
  // One compartment pair per editor: two of them share this module.
  const slots = useRef<Slots>({ theme: new Compartment(), editable: new Compartment() });
  const startedWith = useRef({ value, readOnly, compact, theme, placeholder });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const start = startedWith.current;
    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: start.value,
        extensions: extensions({
          compact: start.compact,
          readOnly: start.readOnly,
          theme: start.theme,
          placeholder: start.placeholder,
          slots: slots.current,
          onChange: (text) => latest.current?.(text),
        }),
      }),
    });
    view.current = instance;
    if (autoFocus) instance.focus();
    return () => {
      instance.destroy();
      view.current = null;
    };
    // The editor is created once and told about every later change through effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);

  /* Text from outside: a save, a regeneration from the canvas, a file taken from disk. */
  useEffect(() => {
    const instance = view.current;
    if (!instance || instance.state.doc.toString() === value) return;
    const previous = instance.state.selection.main;
    const anchor = Math.min(previous.anchor, value.length);
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
      selection: { anchor, head: Math.min(previous.head, value.length) },
      annotations: external.of(true),
      effects: resetHistory(),
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: slots.current.theme.reconfigure(codeTheme(theme, compact)),
    });
  }, [theme, compact]);

  useEffect(() => {
    view.current?.dispatch({
      effects: slots.current.editable.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const instance = view.current;
    if (!instance || compact) return;
    instance.dispatch({ effects: setProblems.of(problems ?? []) });
  }, [problems, compact]);

  useEffect(() => {
    const instance = view.current;
    if (!instance || !reveal) return;
    revealLine(instance, reveal.line);
    instance.focus();
  }, [reveal]);

  return (
    <div
      ref={host}
      className={className ? `${styles.editor ?? ''} ${className}` : styles.editor}
      role="group"
      aria-label={ariaLabel ?? 'Python code'}
    />
  );
}

export default CodeMirror;
