import { beforeEach, describe, expect, it } from 'vitest';
import { useAiStore } from '../store/ai';
import { useFlowStore } from '../store/flow';
import { applyDraftToEditor, commitMessageFor, requestFor } from './apply';

/* Applying a builder's flow to the editor, and the commit message that comes with it:
 * `AI: <the first line of the request>`, waiting in the flow store for the save the user
 * makes next (docs/web-interfaces.md, section H). */

const KEY = 'hello.py';

/** A thread with one question and the flow the builder answered it with. */
function answer(question: string, source = 'print(1)\n'): void {
  useAiStore.getState().begin(KEY, question, new AbortController());
  useAiStore.getState().setFlow(KEY, { type: 'flow', source, model: null, graph: null });
}

function draftOf(key = KEY) {
  const turns = useAiStore.getState().threads[key]?.turns ?? [];
  const flow = turns.find((turn) => turn.flow)?.flow;
  if (!flow) throw new Error('the thread has no draft');
  return flow;
}

describe('the commit message an apply proposes', () => {
  it('takes the first line that has anything on it', () => {
    expect(commitMessageFor('Make it read a file\nand count the words')).toBe(
      'AI: Make it read a file',
    );
    expect(commitMessageFor('\n\n  Add a sink  \n')).toBe('AI: Add a sink');
  });

  it('is short enough to be a subject line', () => {
    const message = commitMessageFor('x'.repeat(200));
    expect(message?.length).toBeLessThanOrEqual(72);
    expect(message?.endsWith('…')).toBe(true);
  });

  it('is nothing at all when there was no question', () => {
    expect(commitMessageFor(null)).toBeNull();
    expect(commitMessageFor('   ')).toBeNull();
  });

  it('finds the question this very draft answered, not the last one asked', () => {
    useAiStore.getState().clear(KEY);
    answer('First question');
    const first = draftOf();
    useAiStore.getState().settle(KEY);
    answer('Second question', 'print(2)\n');

    const thread = useAiStore.getState().threads[KEY];
    expect(requestFor(thread, first)).toBe('First question');
  });
});

describe('applying a draft to the editor', () => {
  beforeEach(() => {
    useAiStore.getState().clear(KEY);
    useFlowStore.getState().clear();
  });

  it('leaves the message for the next save, and the flow dirty', () => {
    answer('Give the farm four workers');
    applyDraftToEditor(draftOf(), KEY);

    const flow = useFlowStore.getState();
    expect(flow.source).toBe('print(1)\n');
    expect(flow.dirty).toBe(true);
    expect(flow.pendingCommit).toBe('AI: Give the farm four workers');
  });

  it('lets the save that uses it take it away again', () => {
    answer('Give the farm four workers');
    applyDraftToEditor(draftOf(), KEY);

    useFlowStore.getState().markSaved({
      source: 'print(1)\n',
      modified: 'later',
      commit: { rev: 'abcdef0123', short: 'abcdef0' },
    });

    const flow = useFlowStore.getState();
    expect(flow.pendingCommit).toBeNull();
    expect(flow.lastCommit?.short).toBe('abcdef0');
    expect(flow.saves).toBe(1);
  });

  it('proposes nothing when the draft belongs to no conversation', () => {
    applyDraftToEditor(
      { source: 'print(3)\n', model: null, graph: null, codeOnly: null, applied: false },
      KEY,
    );
    expect(useFlowStore.getState().pendingCommit).toBeNull();
  });
});
