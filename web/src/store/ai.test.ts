import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyOf, isStreaming, threadOf, useAiStore } from './ai';
import { useFlowStore } from './flow';
import { applyDraftToEditor } from '../ai/apply';
import { fixture } from '../test/fixtures';

const KEY = 'hello.py';

function reset(): void {
  useAiStore.setState({ open: false, wantsNewFlow: false, threads: {} });
}

function turnOf(key = KEY) {
  const thread = threadOf(useAiStore.getState(), key);
  return thread.turns[thread.turns.length - 1];
}

describe('the ai store', () => {
  beforeEach(reset);

  it('starts with no thread and hands back an empty one', () => {
    const thread = threadOf(useAiStore.getState(), 'nothing.py');
    expect(thread.turns).toEqual([]);
    expect(isStreaming(thread)).toBe(false);
  });

  it('keeps a thread per flow', () => {
    const store = useAiStore.getState();
    store.begin('a.py', 'about a', new AbortController());
    store.begin('b.py', 'about b', new AbortController());
    expect(threadOf(useAiStore.getState(), 'a.py').turns[0]?.text).toBe('about a');
    expect(threadOf(useAiStore.getState(), 'b.py').turns[0]?.text).toBe('about b');
  });

  it('opens a turn, streams text into it and closes it', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'make it faster', new AbortController());
    expect(isStreaming(threadOf(useAiStore.getState(), KEY))).toBe(true);

    store.appendText(KEY, 'I widened ');
    store.appendText(KEY, 'the farm.');
    store.finish(KEY, { type: 'done', ok: true, summary: 'Widened the farm.' });

    const thread = threadOf(useAiStore.getState(), KEY);
    expect(thread.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(thread.turns[1]?.text).toBe('I widened the farm.');
    expect(thread.turns[1]?.summary).toBe('Widened the farm.');
    expect(isStreaming(thread)).toBe(false);
  });

  it('clears the draft when a turn starts', () => {
    const store = useAiStore.getState();
    store.setDraft(KEY, 'half a question');
    store.begin(KEY, 'the whole question', new AbortController());
    expect(threadOf(useAiStore.getState(), KEY).draft).toBe('');
  });

  it('pairs a tool answer with the call it belongs to', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'write it', new AbortController());
    store.tool(KEY, { type: 'tool', name: 'write_flow', status: 'started', summary: '42 lines' });
    store.tool(KEY, { type: 'tool', name: 'check_flow', status: 'started', summary: '{}' });
    store.tool(KEY, {
      type: 'tool',
      name: 'check_flow',
      status: 'done',
      summary: 'OK: 6 nodes, 6 edges',
      error: false,
    });

    const tools = turnOf()?.tools ?? [];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'write_flow', running: true, result: null });
    expect(tools[1]).toMatchObject({
      name: 'check_flow',
      running: false,
      result: 'OK: 6 nodes, 6 edges',
      error: false,
    });
  });

  it('matches the answer to the most recent call of that tool', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'twice', new AbortController());
    const started = { type: 'tool', name: 'run_flow', status: 'started', summary: '' } as const;
    store.tool(KEY, started);
    store.tool(KEY, { type: 'tool', name: 'run_flow', status: 'done', summary: 'first' });
    store.tool(KEY, started);
    store.tool(KEY, { type: 'tool', name: 'run_flow', status: 'done', summary: 'second' });
    expect((turnOf()?.tools ?? []).map((step) => step.result)).toEqual(['first', 'second']);
  });

  it('marks a failed tool', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'go', new AbortController());
    store.tool(KEY, { type: 'tool', name: 'check_flow', status: 'started', summary: '{}' });
    store.tool(KEY, {
      type: 'tool',
      name: 'check_flow',
      status: 'done',
      summary: 'GraphError: double has no sink',
      error: true,
    });
    expect(turnOf()?.tools[0]).toMatchObject({ error: true, running: false });
  });

  it('keeps the flow the builder wrote until it is applied', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'write it', new AbortController());
    store.setFlow(KEY, { type: 'flow', source: 'print(1)\n', model: null, graph: null });
    expect(turnOf()?.flow).toMatchObject({ source: 'print(1)\n', applied: false });

    const id = turnOf()?.id ?? '';
    store.markApplied(KEY, id);
    expect(turnOf()?.flow?.applied).toBe(true);
  });

  it('records an error and ends the turn', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'go', new AbortController());
    store.fail(KEY, 'no anthropic key: save one in settings');
    expect(turnOf()).toMatchObject({ error: 'no anthropic key: save one in settings', ok: false });
    expect(isStreaming(threadOf(useAiStore.getState(), KEY))).toBe(false);
  });

  it('aborts the request in flight when stopped', () => {
    const controller = new AbortController();
    const store = useAiStore.getState();
    store.begin(KEY, 'go', controller);
    store.stop(KEY);
    expect(controller.signal.aborted).toBe(true);
    expect(turnOf()).toMatchObject({ stopped: true, streaming: false });
  });

  it('aborts an old request when a new turn starts', () => {
    const first = new AbortController();
    const store = useAiStore.getState();
    store.begin(KEY, 'one', first);
    store.begin(KEY, 'two', new AbortController());
    expect(first.signal.aborted).toBe(true);
  });

  it('clears a thread and stops anything running in it', () => {
    const controller = new AbortController();
    const store = useAiStore.getState();
    store.begin(KEY, 'go', controller);
    store.clear(KEY);
    expect(controller.signal.aborted).toBe(true);
    expect(threadOf(useAiStore.getState(), KEY).turns).toEqual([]);
  });

  it('hands a primed question over once', () => {
    const store = useAiStore.getState();
    store.prime(KEY, 'count the words in log.txt');
    expect(store.takePrimed(KEY)).toBe('count the words in log.txt');
    expect(useAiStore.getState().takePrimed(KEY)).toBeNull();
  });

  it('carries the flag from the command palette', () => {
    useAiStore.getState().requestNewFlow();
    expect(useAiStore.getState().wantsNewFlow).toBe(true);
    useAiStore.getState().clearNewFlow();
    expect(useAiStore.getState().wantsNewFlow).toBe(false);
  });
});

describe('historyOf', () => {
  beforeEach(reset);

  it('sends the words of both sides and the new question last', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'explain it', new AbortController());
    store.appendText(KEY, 'It reads lines and counts words.\n');
    store.finish(KEY, { type: 'done', ok: true, summary: '' });

    expect(historyOf(threadOf(useAiStore.getState(), KEY), 'now make it faster')).toEqual([
      { role: 'user', content: 'explain it' },
      { role: 'assistant', content: 'It reads lines and counts words.' },
      { role: 'user', content: 'now make it faster' },
    ]);
  });

  it('leaves out a turn that never said anything', () => {
    const store = useAiStore.getState();
    store.begin(KEY, 'go', new AbortController());
    store.fail(KEY, 'no key');
    expect(historyOf(threadOf(useAiStore.getState(), KEY), 'again')).toEqual([
      { role: 'user', content: 'go' },
      { role: 'user', content: 'again' },
    ]);
  });
});

describe('applyDraftToEditor', () => {
  beforeEach(() => {
    reset();
    useFlowStore.getState().clear();
  });

  it('puts the flow on the canvas, dirty, keeping the stamp of the file on disk', () => {
    const hello = fixture('hello.py');
    useFlowStore.getState().applyServerFlow(hello);
    const wordCount = fixture('word_count.py');

    applyDraftToEditor(
      {
        source: wordCount.source,
        model: wordCount.model,
        graph: wordCount.graph,
        codeOnly: null,
        applied: false,
      },
      'hello.py',
    );

    const state = useFlowStore.getState();
    expect(state.source).toBe(wordCount.source);
    expect(state.model?.name).toBe('word_count');
    expect(state.path).toBe('hello.py');
    expect(state.modified).toBe(hello.modified);
    expect(state.dirty).toBe(true);
    expect(state.sourceStale).toBe(false);
  });

  it('can be undone back to the flow that was there', () => {
    const hello = fixture('hello.py');
    useFlowStore.getState().applyServerFlow(hello);
    const wordCount = fixture('word_count.py');

    applyDraftToEditor(
      {
        source: wordCount.source,
        model: wordCount.model,
        graph: wordCount.graph,
        codeOnly: null,
        applied: false,
      },
      'hello.py',
    );
    expect(useFlowStore.getState().canUndo()).toBe(true);
    useFlowStore.getState().undo();
    expect(useFlowStore.getState().model?.name).toBe('hello');
  });
});

describe('sendTurn', () => {
  beforeEach(reset);

  it('drives a whole turn from the stream', async () => {
    const { sendTurn } = await import('../ai/send');
    const events = [
      { type: 'text', delta: 'Widening the farm.' },
      { type: 'tool', name: 'write_flow', status: 'started', summary: '30 lines' },
      { type: 'tool', name: 'write_flow', status: 'done', summary: 'written', error: false },
      { type: 'flow', source: 'print(2)\n', model: null, graph: null },
      { type: 'done', ok: true, summary: 'Done.' },
    ];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })),
    );

    await sendTurn({ key: KEY, path: KEY, question: 'make it faster' });

    const thread = threadOf(useAiStore.getState(), KEY);
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[1]).toMatchObject({ text: 'Widening the farm.', streaming: false });
    expect(thread.turns[1]?.tools[0]).toMatchObject({ name: 'write_flow', running: false });
    expect(thread.turns[1]?.flow?.source).toBe('print(2)\n');
  });

  it('shows a dead server in the turn rather than throwing', async () => {
    const { sendTurn } = await import('../ai/send');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('failed to fetch')));
    await sendTurn({ key: KEY, path: KEY, question: 'hello' });
    expect(turnOf()?.error).toBe('Could not reach the Tolquane server');
  });
});
