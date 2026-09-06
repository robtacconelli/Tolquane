/**
 * "Apply to editor": the flow the builder wrote becomes the flow on the canvas.
 *
 * The server never writes over the open file (S4: the builder works in a directory of
 * its own), so applying is a local move -- source, model and graph into the flow store,
 * marked dirty -- and the file only changes when the user saves. The `modified` stamp
 * the editor already holds is kept, so that save still guards against a change on disk.
 *
 * The current canvas is pushed onto the undo stack first, because an apply is an edit
 * like any other and Ctrl-Z has to bring the old flow back.
 *
 * It also writes down what the next save should commit with: `AI: <the request>` (section
 * H). The message goes into the flow store rather than being sent anywhere, because the
 * save is the user's -- they may write their own message over it with Cmd/Ctrl+Shift+S,
 * or save plainly and get it only if `auto_commit` is on.
 */

import type { FlowResponse } from '../model/types';
import { useAiStore, type FlowDraft, type Thread } from '../store/ai';
import { useFlowStore } from '../store/flow';

const HISTORY_LIMIT = 100;

/** How much of the request goes in a commit subject line. */
const SUBJECT = 68;

/**
 * The question this draft was the answer to: the user turn before the assistant turn
 * that holds it. Identity, not the last turn in the thread, so applying an older answer
 * quotes the question that produced it.
 */
export function requestFor(thread: Thread | undefined, draft: FlowDraft): string | null {
  if (!thread) return null;
  const at = thread.turns.findIndex((turn) => turn.flow === draft);
  if (at < 0) return null;
  for (let back = at - 1; back >= 0; back -= 1) {
    const turn = thread.turns[back];
    if (turn?.role === 'user' && turn.text.trim()) return turn.text;
  }
  return null;
}

/** `AI: make it read a file` -- the first line of the request, short enough for a log. */
export function commitMessageFor(request: string | null): string | null {
  const first = (request ?? '').split('\n').find((line) => line.trim()) ?? '';
  const text = first.trim();
  if (!text) return null;
  return `AI: ${text.length > SUBJECT ? `${text.slice(0, SUBJECT - 1).trimEnd()}…` : text}`;
}

export function applyDraftToEditor(draft: FlowDraft, path: string): void {
  const flow = useFlowStore.getState();
  const history = flow.model
    ? [...flow.past, { model: flow.model, layout: flow.layout, selected: flow.selected }]
    : flow.past;

  const response: FlowResponse = {
    path: flow.path ?? path,
    source: draft.source,
    // Keep the stamp of the file on disk: this is an unsaved edit to that file.
    modified: flow.modified ?? '',
    model: draft.model,
    code_only: draft.codeOnly,
    graph: draft.graph,
    // Positions the user has already arranged survive; new blocks are laid out by the
    // canvas, which fills in whatever the sidecar does not have.
    layout: flow.layout,
  };

  flow.applyServerFlow(response);
  useFlowStore.setState({
    dirty: true,
    sourceStale: false,
    past: history.slice(-HISTORY_LIMIT),
    // `applyServerFlow` has just cleared this, which is right for opening a file and
    // wrong for an apply: the next save is this change, and this is what it did.
    pendingCommit: commitMessageFor(requestFor(useAiStore.getState().threads[path], draft)),
  });
}
