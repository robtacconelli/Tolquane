/**
 * Find in this file: Cmd/Ctrl+F, a panel across the top of the editor, every match
 * highlighted and the current one carried into view.
 *
 * It is a plain substring search because that is what a flow file needs -- find the
 * farm, find the node -- and because a few kilobytes of Python can be scanned on every
 * keystroke without anyone noticing. The panel is built from the design tokens like the
 * rest of the app rather than from CodeMirror's default chrome.
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  showPanel,
  type DecorationSet,
  type Panel,
} from '@codemirror/view';
import styles from './code.module.css';

export interface SearchState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  /** Which match is the current one; clamped when the matches change. */
  index: number;
}

const CLOSED: SearchState = { open: false, query: '', caseSensitive: false, index: 0 };

export const setSearch = StateEffect.define<Partial<SearchState>>();

export const searchState = StateField.define<SearchState>({
  create: () => CLOSED,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setSearch)) next = { ...next, ...effect.value };
    }
    if (tr.docChanged && next === value) next = { ...value };
    return next;
  },
});

/** Every match of `query` in `text`, as [from, to] pairs, in order. */
export function matchesOf(text: string, query: string, caseSensitive: boolean): [number, number][] {
  if (query === '') return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: [number, number][] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1 && out.length < 5000) {
    out.push([at, at + needle.length]);
    at = haystack.indexOf(needle, at + Math.max(1, needle.length));
  }
  return out;
}

/** The current match, with the index wrapped into range. */
export function currentMatch(
  matches: readonly [number, number][],
  index: number,
): { from: number; to: number; at: number } | null {
  if (matches.length === 0) return null;
  const at = ((index % matches.length) + matches.length) % matches.length;
  const [from, to] = matches[at] as [number, number];
  return { from, to, at };
}

const match = Decoration.mark({ class: 'cm-searchMatch' });
const selected = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

const highlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, tr) {
    const state = tr.state.field(searchState);
    if (!state.open || state.query === '') return Decoration.none;
    const found = matchesOf(tr.state.doc.toString(), state.query, state.caseSensitive);
    const current = currentMatch(found, state.index);
    return Decoration.set(
      found.map(([from, to], index) =>
        (current && index === current.at ? selected : match).range(from, to),
      ),
    );
  },
  provide: (field) => EditorView.decorations.from(field),
});

function apply(view: EditorView, patch: Partial<SearchState>): void {
  view.dispatch({ effects: setSearch.of(patch) });
  const state = view.state.field(searchState);
  const found = matchesOf(view.state.doc.toString(), state.query, state.caseSensitive);
  const current = currentMatch(found, state.index);
  if (!current) return;
  view.dispatch({
    selection: { anchor: current.from, head: current.to },
    effects: EditorView.scrollIntoView(current.from, { y: 'center' }),
  });
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = styles.searchButton ?? '';
  element.textContent = label;
  element.title = title;
  element.setAttribute('aria-label', title);
  element.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return element;
}

function searchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = styles.searchPanel ?? '';
  dom.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.className = styles.searchInput ?? '';
  input.type = 'text';
  input.placeholder = 'Find in this file';
  input.setAttribute('aria-label', 'Find in this file');
  input.spellcheck = false;

  const count = document.createElement('span');
  count.className = styles.searchCount ?? '';
  count.setAttribute('aria-live', 'polite');

  const previous = button('↑', 'Previous match', () => {
    apply(view, { index: view.state.field(searchState).index - 1 });
  });
  const next = button('↓', 'Next match', () => {
    apply(view, { index: view.state.field(searchState).index + 1 });
  });
  const casing = button('Aa', 'Match case', () => {
    const on = !view.state.field(searchState).caseSensitive;
    casing.setAttribute('aria-pressed', String(on));
    apply(view, { caseSensitive: on, index: 0 });
  });
  casing.setAttribute('aria-pressed', 'false');
  const close = button('✕', 'Close search', () => {
    view.dispatch({ effects: setSearch.of({ open: false }) });
    view.focus();
  });

  input.addEventListener('input', () => {
    apply(view, { query: input.value, index: 0 });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply(view, { index: view.state.field(searchState).index + (event.shiftKey ? -1 : 1) });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      view.dispatch({ effects: setSearch.of({ open: false }) });
      view.focus();
    }
  });

  dom.append(input, count, previous, next, casing, close);

  const refresh = (): void => {
    const state = view.state.field(searchState);
    if (input.value !== state.query) input.value = state.query;
    const found = matchesOf(view.state.doc.toString(), state.query, state.caseSensitive);
    const current = currentMatch(found, state.index);
    count.textContent =
      state.query === ''
        ? ''
        : found.length === 0
          ? 'no matches'
          : `${String((current?.at ?? 0) + 1)} of ${String(found.length)}`;
  };

  return {
    dom,
    top: true,
    mount: () => {
      refresh();
      input.focus();
      input.select();
    },
    update: () => refresh(),
  };
}

/** Open the panel, seeded with the selection when it is a word rather than a paragraph. */
export function openSearch(view: EditorView): boolean {
  const range = view.state.selection.main;
  const seed = range.empty ? '' : view.state.sliceDoc(range.from, range.to);
  const query =
    seed.includes('\n') || seed.length > 80 ? view.state.field(searchState).query : seed;
  view.dispatch({ effects: setSearch.of({ open: true, ...(query ? { query, index: 0 } : {}) }) });
  return true;
}

export function codeSearch(): Extension {
  return [
    searchState,
    highlights,
    showPanel.from(searchState, (state) => (state.open ? searchPanel : null)),
    keymap.of([
      { key: 'Mod-f', run: openSearch, preventDefault: true, stopPropagation: true },
      {
        key: 'Mod-g',
        run: (view) => {
          apply(view, { index: view.state.field(searchState).index + 1 });
          return true;
        },
        shift: (view) => {
          apply(view, { index: view.state.field(searchState).index - 1 });
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(searchState).open) return false;
          view.dispatch({ effects: setSearch.of({ open: false }) });
          return true;
        },
      },
    ]),
  ];
}
