/**
 * The two-way sync, on a clock we control.
 *
 * Everything here is about who wins: the text always, the model when it is newer than the
 * text, and neither when the answer that came back is about something the person has
 * already typed over.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { FlowModel, FlowResponse } from '../../model';
import { useFlowStore } from '../../store/flow';
import { FIXTURES } from '../../test/fixtures';
import {
  GENERATE_DEBOUNCE_MS,
  PARSE_DEBOUNCE_MS,
  conflictOf,
  nodeSourceTyped,
  reportSaveFailure,
  sourceTyped,
  useCodeSync,
} from './sync';
import { useCodeSyncStore } from './syncStore';

const WORD_COUNT = FIXTURES['word_count.py'] as FlowResponse;

function modelWith(workers: number): FlowModel {
  const model = structuredClone(WORD_COUNT.model) as FlowModel;
  const stages = model.flow.type === 'pipeline' ? model.flow.stages : [];
  const farm = stages[1];
  if (farm?.type === 'farm') farm.workers = workers;
  return model;
}

function workersOf(model: FlowModel | null): number | null {
  const stages = model?.flow.type === 'pipeline' ? model.flow.stages : [];
  const farm = stages[1];
  return farm?.type === 'farm' ? farm.workers : null;
}

/** What `fetch` was called with, whichever of its three shapes it was given. */
function urlOf(input: RequestInfo | URL | undefined): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? '';
}

interface Answer {
  body: unknown;
  status?: number;
}

/** One fetch mock, answering by route, remembering what it was asked. */
function serve(answers: Record<string, Answer | (() => Promise<Answer>)>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    const key = Object.keys(answers).find((route) => url.includes(route));
    const answer = key ? answers[key] : undefined;
    if (!answer) return new Response('{}', { status: 404 });
    const resolved = typeof answer === 'function' ? await answer() : answer;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** Let the timers fire and the promises they started settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the code and the canvas keeping up with each other', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCodeSyncStore.getState().reset();
    act(() => {
      useFlowStore.getState().applyServerFlow(WORD_COUNT);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useFlowStore.getState().clear();
    useCodeSyncStore.getState().reset();
  });

  it('keeps the typed text at once and parses it when the typing stops', async () => {
    const calls = serve({
      '/flows/parse': { body: { model: modelWith(4), code_only: null, graph: WORD_COUNT.graph } },
    });
    renderHook(() => useCodeSync());
    const typed = `${WORD_COUNT.source}\n# a comment\n`;

    act(() => sourceTyped(typed));
    expect(useFlowStore.getState().source).toBe(typed);
    expect(useFlowStore.getState().dirty).toBe(true);
    expect(useFlowStore.getState().sourceStale).toBe(false);
    expect(calls).toHaveLength(0);

    await tick(PARSE_DEBOUNCE_MS - 50);
    expect(calls).toHaveLength(0);

    await tick(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/flows/parse');
    expect((calls[0]?.body as { source: string }).source).toBe(typed);
    expect(workersOf(useFlowStore.getState().model)).toBe(4);
    expect(useFlowStore.getState().source).toBe(typed);
  });

  it('debounces a run of keystrokes into one parse', async () => {
    const calls = serve({
      '/flows/parse': { body: { model: modelWith(2), code_only: null, graph: WORD_COUNT.graph } },
    });
    renderHook(() => useCodeSync());

    for (const text of ['a', 'ab', 'abc']) {
      act(() => sourceTyped(text));
      await tick(200);
    }
    expect(calls).toHaveLength(0);
    await tick(PARSE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.body as { source: string }).source).toBe('abc');
  });

  it('keeps the text when the file drops to code-only, and says why', async () => {
    const reason = "the file does not parse: expected ':' (<unknown>, line 19)";
    serve({ '/flows/parse': { body: { model: null, code_only: { reason }, graph: null } } });
    renderHook(() => useCodeSync());
    const broken = WORD_COUNT.source.replace('def words(line: str):', 'def words(line: str)');

    act(() => sourceTyped(broken));
    await tick(PARSE_DEBOUNCE_MS);

    const state = useFlowStore.getState();
    expect(state.source).toBe(broken);
    expect(state.model).toBeNull();
    expect(state.codeOnly).toEqual({ reason });
    expect(state.expanded).toBe(true);
    expect(useCodeSyncStore.getState().failure).toBeNull();
  });

  it('generates the file again after a canvas edit', async () => {
    const generated = '# generated\n';
    const calls = serve({ '/flows/generate': { body: { source: generated } } });
    renderHook(() => useCodeSync());

    act(() => {
      useFlowStore.getState().setWorkers('stages.1', 8);
    });
    expect(useFlowStore.getState().sourceStale).toBe(true);
    expect(calls).toHaveLength(0);

    await tick(GENERATE_DEBOUNCE_MS + 10);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/flows/generate');
    expect(useFlowStore.getState().source).toBe(generated);
    expect(useFlowStore.getState().sourceStale).toBe(false);
    expect(useFlowStore.getState().dirty).toBe(true);
  });

  it('parses once more after a node body was rewritten', async () => {
    const calls = serve({
      '/flows/generate': { body: { source: '# generated\n' } },
      '/flows/parse': { body: { model: modelWith(2), code_only: null, graph: WORD_COUNT.graph } },
    });
    renderHook(() => useCodeSync());

    const body = '@tq.node\ndef words(line: str):\n    yield line\n';
    act(() => nodeSourceTyped('words', body));
    await tick(GENERATE_DEBOUNCE_MS + 10);
    await tick(0);

    expect(calls.map((call) => call.url.split('/api')[1])).toEqual([
      '/flows/generate',
      '/flows/parse',
    ]);
    // The body went out with the model, and the file that came back is what is on screen;
    // the parse that follows is what puts the canvas back in step with it.
    const sent = (calls[0]?.body as { model: FlowModel }).model;
    expect(sent.nodes.find((entry) => entry.id === 'words')?.source).toBe(body);
    expect(useFlowStore.getState().source).toBe('# generated\n');
    expect(useFlowStore.getState().codeOnly).toBeNull();
  });

  it('drops a parse whose text has already been typed over', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve({
      '/flows/parse': async () => {
        await held;
        return { body: { model: modelWith(99), code_only: null, graph: WORD_COUNT.graph } };
      },
    });
    renderHook(() => useCodeSync());

    act(() => sourceTyped('first'));
    await tick(PARSE_DEBOUNCE_MS + 10);
    act(() => sourceTyped('second'));
    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(useFlowStore.getState().source).toBe('second');
    expect(workersOf(useFlowStore.getState().model)).not.toBe(99);
  });

  it('says nothing was lost when the parse request itself fails', async () => {
    serve({ '/flows/parse': { body: { error: { message: 'the flow timed out' } }, status: 500 } });
    renderHook(() => useCodeSync());

    act(() => sourceTyped('# still mine\n'));
    await tick(PARSE_DEBOUNCE_MS + 10);

    expect(useFlowStore.getState().source).toBe('# still mine\n');
    expect(useCodeSyncStore.getState().failure).toBe('the flow timed out');
    expect(useCodeSyncStore.getState().phase).toBe('idle');
  });
});

describe('a file that changed on disk', () => {
  beforeEach(() => {
    useCodeSyncStore.getState().reset();
    act(() => {
      useFlowStore.getState().applyServerFlow(WORD_COUNT);
    });
  });

  const conflictError = new ApiError({
    message: 'word_count.py changed on disk since you opened it; merge the two versions',
    status: 409,
    code: 'http',
    url: '/api/flows/word_count.py',
    detail: {
      error: {
        type: 'Conflict',
        message: 'changed on disk',
        detail: { source: '# theirs\n', modified: '2026-09-06T12:00:00Z' },
      },
    },
  });

  it('reads both versions out of the 409', () => {
    const conflict = conflictOf(conflictError, 'word_count.py', '# mine\n');
    expect(conflict).toEqual({
      path: 'word_count.py',
      mine: '# mine\n',
      theirs: '# theirs\n',
      modified: '2026-09-06T12:00:00Z',
    });
  });

  it('is not raised for any other failure', () => {
    const other = new ApiError({ message: 'nope', status: 400, code: 'http', url: '/api' });
    expect(conflictOf(other, 'word_count.py', '# mine\n')).toBeNull();
    expect(reportSaveFailure(other)).toBe(false);
    expect(useCodeSyncStore.getState().conflict).toBeNull();
  });

  it('opens the dialog with the editor text as "mine"', () => {
    act(() => sourceTyped('# mine\n'));
    expect(reportSaveFailure(conflictError)).toBe(true);
    const conflict = useCodeSyncStore.getState().conflict;
    expect(conflict?.mine).toBe('# mine\n');
    expect(conflict?.theirs).toBe('# theirs\n');
    expect(conflict?.path).toBe('word_count.py');
  });
});
