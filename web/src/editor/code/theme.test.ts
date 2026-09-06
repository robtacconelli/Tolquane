/**
 * The theme is a map from the design tokens to CodeMirror's classes, so its test is that
 * the map has no holes: every token the theme paints with exists in both palettes, and
 * nothing painted in dark leaks into light.
 */

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
// Read as text: the theme's job is to be a faithful map of the one onto the other, and
// that is a fact about what the two files contain.
import CSS from './code.module.css?raw';
import { SYNTAX_COLORS, codeTheme } from './theme';
import THEME from './theme.ts?raw';

/** The custom properties a CSS rule declares, by the selector it declares them on. */
function declared(selector: string): Set<string> {
  const at = CSS.indexOf(selector);
  if (at === -1) return new Set();
  const body = CSS.slice(at, CSS.indexOf('\n}', at));
  return new Set([...body.matchAll(/(--tq-[a-z-]+):/g)].map((found) => found[1] as string));
}

const base = declared('.surface {');
const light = declared(":global(:root[data-theme='light']) .surface {");

describe('the code editor theme', () => {
  it('paints with tokens only', () => {
    const literals = [...THEME.matchAll(/color:\s*'(#[0-9a-f]+)'/gi)];
    expect(literals).toEqual([]);
  });

  it('declares every token it uses', () => {
    const used = new Set([...THEME.matchAll(/var\((--tq-[a-z-]+)\)/g)].map((f) => f[1] as string));
    const missing = [...used].filter((token) => !base.has(token) && token.startsWith('--tq-code-'));
    expect(missing).toEqual([]);
  });

  it('gives every syntax colour a light value of its own', () => {
    const own = [...base].filter((token) => {
      const value = new RegExp(`${token}: (.+);`).exec(CSS)?.[1] ?? '';
      return value.startsWith('#') || value.startsWith('rgb');
    });
    expect(own.length).toBeGreaterThan(8);
    expect(own.filter((token) => !light.has(token))).toEqual([]);
  });

  it('names a colour for every part of Python the parser tags', () => {
    for (const value of Object.values(SYNTAX_COLORS)) {
      expect(value).toMatch(/^var\(--tq-code-[a-z-]+\)$/);
    }
    expect(SYNTAX_COLORS.decorator).toBe('var(--tq-code-decorator)');
  });

  it('tells CodeMirror which theme is on, and builds each one once', () => {
    const dark = EditorState.create({ extensions: codeTheme('dark') });
    const day = EditorState.create({ extensions: codeTheme('light') });
    expect(dark.facet(EditorView.darkTheme)).toBe(true);
    expect(day.facet(EditorView.darkTheme)).toBe(false);
    expect(codeTheme('dark')).toBe(codeTheme('dark'));
    expect(codeTheme('dark')).not.toBe(codeTheme('dark', true));
  });
});
