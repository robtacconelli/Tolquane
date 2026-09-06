/** The two versions of a file, and the question the dialog asks about them. */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FlowResponse } from '../../model';
import { useFlowStore } from '../../store/flow';
import { FIXTURES } from '../../test/fixtures';
import { ConflictDialog } from './ConflictDialog';
import { diffCounts, diffRows } from './diff';
import { useCodeSyncStore } from './syncStore';

const WORD_COUNT = FIXTURES['word_count.py'] as FlowResponse;

/** What `fetch` was called with, whichever of its three shapes it was given. */
function urlOf(input: RequestInfo | URL | undefined): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? '';
}

describe('the difference between two files', () => {
  it('marks what each side has', () => {
    const rows = diffRows('a\nb\nc\n', 'a\nB\nc\n');
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'same:a',
      'del:b',
      'add:B',
      'same:c',
    ]);
    expect(diffCounts(rows)).toEqual({ added: 1, removed: 1 });
  });

  it('numbers the lines on both sides', () => {
    const rows = diffRows('a\nb\n', 'a\nb\nc\n');
    const added = rows.find((row) => row.kind === 'add');
    expect(added).toMatchObject({ text: 'c', left: null, right: 3 });
  });

  it('folds away the long stretches nobody needs to read', () => {
    const same = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n');
    const rows = diffRows(`${same}\n`, `${same}\nlast\n`);
    const gap = rows.find((row) => row.kind === 'gap');
    expect(gap?.text).toBe('37 unchanged lines');
    expect(rows).toHaveLength(5);
  });

  it('sees a file that only grew', () => {
    expect(diffCounts(diffRows('a\n', 'a\nb\n'))).toEqual({ added: 1, removed: 0 });
  });
});

describe('the dialog about a file changed on disk', () => {
  const open = (): void => {
    useFlowStore.getState().applyServerFlow(WORD_COUNT);
    useCodeSyncStore.getState().openConflict({
      path: 'word_count.py',
      mine: 'a\nmine\n',
      theirs: 'a\ntheirs\n',
      modified: '2026-09-06T12:00:00Z',
    });
  };

  it('shows both versions and offers one of each', () => {
    open();
    render(<ConflictDialog />);
    expect(screen.getByText('This file changed on disk')).toBeInTheDocument();
    expect(screen.getByText('mine')).toBeInTheDocument();
    expect(screen.getByText('theirs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take theirs' })).toBeInTheDocument();
  });

  it('saves this text over the newer file when mine wins', async () => {
    open();
    const saved = { ...WORD_COUNT, source: 'a\nmine\n', modified: '2026-09-06T12:01:00Z' };
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(saved), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ConflictDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe('/api/flows/word_count.py');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toMatchObject({
      source: 'a\nmine\n',
      modified: '2026-09-06T12:00:00Z',
    });
    expect(useFlowStore.getState().source).toBe('a\nmine\n');
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(useCodeSyncStore.getState().conflict).toBeNull();
  });

  it('opens the file from disk when theirs wins', async () => {
    open();
    const theirs = { ...WORD_COUNT, source: 'a\ntheirs\n' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Response(JSON.stringify(theirs), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    render(<ConflictDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Take theirs' }));

    expect(useFlowStore.getState().source).toBe('a\ntheirs\n');
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(useCodeSyncStore.getState().conflict).toBeNull();
  });
});
