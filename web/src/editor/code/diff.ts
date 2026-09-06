/**
 * The two versions of a file, line by line.
 *
 * `diffLines` gives runs of added, removed and unchanged text; what a person needs to see
 * is those runs as numbered lines with the long stretches of agreement folded away, so
 * the disagreement is the whole of what is on screen.
 */

import { diffLines } from 'diff';

export interface DiffRow {
  kind: 'same' | 'add' | 'del' | 'gap';
  text: string;
  /** The line number on disk, when the row has one. */
  left: number | null;
  /** The line number in the editor, when the row has one. */
  right: number | null;
}

/** How many unchanged lines stay either side of a change. */
export const CONTEXT = 3;

function split(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `theirs` is what is on disk, `mine` is what is in the editor: removals are theirs,
 * additions are mine, which is the way round a "keep mine or take theirs" question reads.
 */
export function diffRows(theirs: string, mine: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let left = 0;
  let right = 0;
  for (const change of diffLines(theirs, mine)) {
    for (const text of split(change.value)) {
      if (change.added) {
        right += 1;
        rows.push({ kind: 'add', text, left: null, right });
      } else if (change.removed) {
        left += 1;
        rows.push({ kind: 'del', text, left, right: null });
      } else {
        left += 1;
        right += 1;
        rows.push({ kind: 'same', text, left, right });
      }
    }
  }
  return fold(rows);
}

/** Runs of agreement longer than twice the context become one "N unchanged lines" row. */
function fold(rows: DiffRow[]): DiffRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    for (let at = index - CONTEXT; at <= index + CONTEXT; at += 1) keep.add(at);
  });
  const out: DiffRow[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (row.kind !== 'same' || keep.has(index)) {
      if (hidden > 0) {
        out.push({
          kind: 'gap',
          text: `${String(hidden)} unchanged line${hidden === 1 ? '' : 's'}`,
          left: null,
          right: null,
        });
        hidden = 0;
      }
      out.push(row);
      return;
    }
    hidden += 1;
  });
  if (hidden > 0) {
    out.push({
      kind: 'gap',
      text: `${String(hidden)} unchanged line${hidden === 1 ? '' : 's'}`,
      left: null,
      right: null,
    });
  }
  return out;
}

/** How much changed, for the sentence over the diff. */
export function diffCounts(rows: readonly DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((row) => row.kind === 'add').length,
    removed: rows.filter((row) => row.kind === 'del').length,
  };
}
