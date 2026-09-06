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
 */

import type { FlowResponse } from '../model/types';
import { useFlowStore } from '../store/flow';
import type { FlowDraft } from '../store/ai';

const HISTORY_LIMIT = 100;

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
  });
}
