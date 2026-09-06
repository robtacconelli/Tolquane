import { describe, expect, it } from 'vitest';
import { collapse, diffLines, diffStat } from './diff';

const shape = (rows: readonly { kind: string }[]): string =>
  rows.map((row) => row.kind[0]).join('');

describe('diffLines', () => {
  it('sees nothing between two identical texts', () => {
    const rows = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(shape(rows)).toBe('sss');
    expect(diffStat(rows)).toEqual({ added: 0, removed: 0 });
  });

  it('finds an inserted line', () => {
    const rows = diffLines('a\nc\n', 'a\nb\nc\n');
    expect(rows.map((row) => `${row.kind[0] ?? ''}${row.text}`)).toEqual(['sa', 'ab', 'sc']);
    expect(diffStat(rows)).toEqual({ added: 1, removed: 0 });
  });

  it('finds a removed line', () => {
    const rows = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(diffStat(rows)).toEqual({ added: 0, removed: 1 });
    expect(rows.find((row) => row.kind === 'remove')?.text).toBe('b');
  });

  it('reads a changed line as one out and one in', () => {
    const rows = diffLines('workers=4\n', 'workers=8\n');
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 });
  });

  it('numbers both sides', () => {
    const rows = diffLines('a\nb\n', 'a\nx\nb\n');
    expect(rows.map((row) => [row.before, row.after])).toEqual([
      [1, 1],
      [null, 2],
      [2, 3],
    ]);
  });

  it('handles an empty side', () => {
    expect(shape(diffLines('', 'a\nb\n'))).toBe('aa');
    expect(shape(diffLines('a\nb\n', ''))).toBe('rr');
  });

  it('does not invent a last empty line', () => {
    expect(diffLines('a\n', 'a\n')).toHaveLength(1);
    expect(diffLines('a', 'a\n')).toHaveLength(1);
  });

  it('keeps the common run of a real edit', () => {
    const before = ['import tolquane as tq', '', 'def build():', '    return a >> b', ''].join(
      '\n',
    );
    const after = ['import tolquane as tq', '', 'def build():', '    return a >> c >> b', ''].join(
      '\n',
    );
    const rows = diffLines(before, after);
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 });
    expect(rows.filter((row) => row.kind === 'same')).toHaveLength(3);
  });
});

describe('collapse', () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n');
  const after = before.replace('line 15', 'line fifteen');

  it('folds the untouched middle away, keeping context', () => {
    const rows = collapse(diffLines(before, after), 3);
    expect(rows.filter((row) => row.kind === 'gap')).toHaveLength(2);
    const kept = rows.filter((row) => row.kind !== 'gap');
    // three lines either side of the one change, plus the two lines of the change itself
    expect(kept).toHaveLength(8);
  });

  it('folds a diff with no changes to one gap', () => {
    expect(collapse(diffLines(before, before))).toEqual([{ kind: 'gap', count: 30 }]);
  });

  it('keeps a short diff whole', () => {
    const rows = collapse(diffLines('a\nb\n', 'a\nc\n'), 3);
    expect(rows.some((row) => row.kind === 'gap')).toBe(false);
  });
});
