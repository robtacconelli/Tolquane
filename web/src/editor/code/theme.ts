/**
 * The CodeMirror theme, built from the design tokens.
 *
 * Every colour here is a `var(--tq-...)`: the tokens live on the surface the editor is
 * mounted in (`code.module.css`), so light and dark share one theme object and switching
 * themes is a repaint, not a re-mount. The only thing that has to be told which theme is
 * on is CodeMirror's own `dark` flag, which decides the class it puts on the editor.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** The syntax palette, as the tokens that paint it. Read by the theme and by its test. */
export const SYNTAX_COLORS = {
  comment: 'var(--tq-code-comment)',
  keyword: 'var(--tq-code-keyword)',
  operator: 'var(--tq-code-operator)',
  string: 'var(--tq-code-string)',
  number: 'var(--tq-code-number)',
  function: 'var(--tq-code-function)',
  class: 'var(--tq-code-class)',
  decorator: 'var(--tq-code-decorator)',
  builtin: 'var(--tq-code-builtin)',
  property: 'var(--tq-code-property)',
  invalid: 'var(--tq-code-invalid)',
} as const;

/**
 * Python as Tolquane reads it. Decorators take the accent: a flow file is a handful of
 * `@tq.` lines and the eye should find them first.
 */
export const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: SYNTAX_COLORS.comment },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: SYNTAX_COLORS.keyword },
  { tag: [t.self, t.null, t.bool], color: SYNTAX_COLORS.keyword },
  {
    tag: [t.operator, t.operatorKeyword, t.punctuation, t.separator, t.bracket],
    color: SYNTAX_COLORS.operator,
  },
  { tag: [t.string, t.special(t.string), t.docString], color: SYNTAX_COLORS.string },
  { tag: [t.number, t.integer, t.float], color: SYNTAX_COLORS.number },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: SYNTAX_COLORS.function },
  {
    tag: [t.definition(t.variableName), t.definition(t.function(t.variableName))],
    color: SYNTAX_COLORS.function,
  },
  { tag: [t.className, t.definition(t.className), t.typeName], color: SYNTAX_COLORS.class },
  { tag: [t.meta, t.annotation], color: SYNTAX_COLORS.decorator },
  { tag: [t.standard(t.variableName), t.atom], color: SYNTAX_COLORS.builtin },
  { tag: [t.propertyName, t.attributeName], color: SYNTAX_COLORS.property },
  { tag: t.invalid, color: SYNTAX_COLORS.invalid },
]);

const BASE = {
  '&': {
    color: 'var(--tq-code-text)',
    backgroundColor: 'var(--tq-code-bg)',
    fontSize: 'var(--tq-text-base)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--tq-font-mono)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: 'var(--tq-space-4) 0 var(--tq-space-10)',
    caretColor: 'var(--tq-accent)',
  },
  '.cm-line': { padding: '0 var(--tq-space-5) 0 var(--tq-space-3)' },

  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--tq-accent)',
    marginLeft: '-1px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--tq-code-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--tq-code-match)' },
  '.cm-activeLine': { backgroundColor: 'var(--tq-code-line)' },
  '&:not(.cm-focused) .cm-activeLine': { backgroundColor: 'transparent' },

  '.cm-gutters': {
    color: 'var(--tq-text-subtle)',
    backgroundColor: 'var(--tq-code-gutter)',
    borderRight: '1px solid var(--tq-border-subtle)',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 var(--tq-space-3) 0 var(--tq-space-5)',
    minWidth: '2.5ch',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-activeLineGutter': {
    color: 'var(--tq-text)',
    backgroundColor: 'var(--tq-code-line)',
  },

  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    color: 'var(--tq-accent)',
    backgroundColor: 'var(--tq-accent-soft)',
    outline: '1px solid var(--tq-accent-line)',
  },
  '.cm-nonmatchingBracket': { color: 'var(--tq-danger)' },

  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--tq-text)' },
  '.cm-panels.cm-panels-top': { borderBottom: 'none' },

  '.cm-searchMatch': {
    backgroundColor: 'var(--tq-code-match)',
    borderRadius: 'var(--tq-radius-xs)',
  },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--tq-code-match-active)' },

  '.cm-problemLine': { backgroundColor: 'var(--tq-danger-soft)' },
  '.cm-problemGutter': {
    width: '10px',
    padding: '0 0 0 var(--tq-space-2)',
  },
  '.cm-problemMarker': {
    display: 'block',
    width: '6px',
    height: '6px',
    marginTop: '7px',
    borderRadius: 'var(--tq-radius-pill)',
    backgroundColor: 'var(--tq-danger)',
  },
  '.cm-problemMarker[data-severity="warning"]': { backgroundColor: 'var(--tq-warning)' },

  '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    borderRadius: 'var(--tq-radius-pill)',
    backgroundColor: 'var(--tq-scrollbar)',
    border: '2px solid transparent',
    backgroundClip: 'content-box',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': { backgroundColor: 'var(--tq-scrollbar-hover)' },
} as const satisfies Spec;

const COMPACT = {
  '&': { fontSize: 'var(--tq-text-sm)' },
  '.cm-content': { padding: 'var(--tq-space-3) 0' },
  // The panel is narrow, so lines wrap; a hanging indent keeps the wrap from reading as
  // a new statement at column zero.
  '.cm-line': {
    padding: '0 var(--tq-space-4) 0 calc(var(--tq-space-4) + 3ch)',
    textIndent: '-3ch',
  },
  '.cm-scroller': { lineHeight: '1.55' },
} as const satisfies Spec;

type Spec = Record<string, Record<string, string>>;

/** Per selector, not per spec: the compact rules refine the base rules, they don't drop them. */
function merge(base: Spec, extra: Spec): Spec {
  const out: Spec = { ...base };
  for (const [selector, rules] of Object.entries(extra)) {
    out[selector] = { ...(base[selector] ?? {}), ...rules };
  }
  return out;
}

const cache = new Map<string, Extension>();

/**
 * The whole look: the theme, the syntax highlighting, and nothing else. Memoised per
 * (theme, density) pair so React re-renders never rebuild the StyleModule.
 */
export function codeTheme(theme: 'light' | 'dark', compact = false): Extension {
  const key = `${theme}:${String(compact)}`;
  const found = cache.get(key);
  if (found) return found;
  const built: Extension = [
    EditorView.theme(compact ? merge(BASE, COMPACT) : BASE, { dark: theme === 'dark' }),
    syntaxHighlighting(highlightStyle),
  ];
  cache.set(key, built);
  return built;
}
