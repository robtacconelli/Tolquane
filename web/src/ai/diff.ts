/**
 * A line diff, for "show me what the builder changed before I apply it".
 *
 * Longest common subsequence over whole lines: flow files are a few hundred lines, so
 * the quadratic table is a fraction of a millisecond, and the result is the one thing a
 * reader wants -- which lines went, which came, and the untouched code between them
 * folded away.
 */

export type DiffKind = 'same' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old text, `null` for an added line. */
  before: number | null;
  /** 1-based line number in the new text, `null` for a removed line. */
  after: number | null;
}

/** A run of unchanged lines the view folds away. */
export interface DiffGap {
  kind: 'gap';
  count: number;
}

export type DiffRow = DiffLine | DiffGap;

/** Above this many cells the table is not worth building; the file is replaced instead. */
const MAX_CELLS = 4_000_000;

function split(text: string): string[] {
  if (text === '') return []; // an empty file has no lines, not one empty one
  const lines = text.split('\n');
  // A trailing newline is a line ending, not an empty last line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = split(before);
  const b = split(after);

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text, index): DiffLine => ({
        kind: 'remove',
        text,
        before: index + 1,
        after: null,
      })),
      ...b.map((text, index): DiffLine => ({ kind: 'add', text, before: null, after: index + 1 })),
    ];
  }

  // lcs[i][j] is the length of the longest common subsequence of a[i:] and b[j:].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] ?? '', before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      rows.push({ kind: 'remove', text: a[i] ?? '', before: i + 1, after: null });
      i += 1;
    } else {
      rows.push({ kind: 'add', text: b[j] ?? '', before: null, after: j + 1 });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    rows.push({ kind: 'remove', text: a[i] ?? '', before: i + 1, after: null });
  }
  for (; j < b.length; j += 1) {
    rows.push({ kind: 'add', text: b[j] ?? '', before: null, after: j + 1 });
  }
  return rows;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(rows: readonly DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'remove') removed += 1;
  }
  return { added, removed };
}

/**
 * The same rows with long runs of untouched lines replaced by one gap, keeping `context`
 * lines either side of every change. A diff with no changes folds to nothing.
 */
export function collapse(rows: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    for (let at = index - context; at <= index + context; at += 1) {
      if (at >= 0 && at < rows.length) keep[at] = true;
    }
  });

  const out: DiffRow[] = [];
  let gap = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (gap > 0) {
        out.push({ kind: 'gap', count: gap });
        gap = 0;
      }
      out.push(row);
    } else {
      gap += 1;
    }
  });
  if (gap > 0) out.push({ kind: 'gap', count: gap });
  return out;
}
