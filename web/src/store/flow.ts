/**
 * The open flow: the model the canvas edits, its layout sidecar, the selection and the
 * undo stack.
 *
 * Nothing here talks to the server. `src/api/flows.ts` does that, the page calls it, and
 * the answer arrives through `applyServerFlow`; what goes back out is `toSaveRequest()`.
 * That keeps the store testable without a fetch mock and leaves the request policy
 * (when to generate, when to save the sidecar) in one place, the editor page.
 *
 * Every edit goes through `edit()`, which snapshots the model for undo, re-keys the
 * layout with `pathsAfterEdit` so cards keep their positions when stages move, follows
 * the selection to wherever its block went, and revalidates.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
// A type only: the store still talks to nothing. `Committed` is what a save answers with
// when it committed, and the History tab and the toolbar both read it from here.
import type { Committed } from '../api/history';
import {
  appendStage as appendStageEdit,
  emptyLayout,
  insertAfter as insertAfterEdit,
  insertBefore as insertBeforeEdit,
  insertStage as insertStageEdit,
  moveStage as moveStageEdit,
  normalizeLayout,
  normalizeModel,
  pathRenames,
  pathsAfterEdit,
  removeAt as removeAtEdit,
  replaceAt as replaceAtEdit,
  addParam as addParamEdit,
  newParamName,
  removeParam as removeParamEdit,
  renameParam as renameParamEdit,
  setBlockName as setBlockNameEdit,
  setCrossBlock as setCrossBlockEdit,
  setFarmOptions as setFarmOptionsEdit,
  setMerge as setMergeEdit,
  setParam as setParamEdit,
  setWorkers as setWorkersEdit,
  terminalKind,
  unwrap as unwrapEdit,
  validateModel,
  wrapInFarm,
  wrapInFeedback,
  hasPath,
  ROOT,
} from '../model';
import type {
  CodeOnly,
  NodeDef,
  FarmOptions,
  FlowModel,
  FlowParam,
  FlowResponse,
  GraphView,
  Layout,
  Position,
  Problem,
  Tree,
  Viewport,
} from '../model';

export type EditorView = 'canvas' | 'code';

interface Snapshot {
  model: FlowModel;
  layout: Layout;
  selected: string | null;
}

const HISTORY_LIMIT = 100;

export interface FlowState {
  /** The flow's path inside the workspace, as the routes address it. */
  path: string | null;
  /** The Python as the server last gave or generated it. */
  source: string;
  /** The `modified` stamp to send back on save; a newer one on disk answers 409. */
  modified: string | null;
  model: FlowModel | null;
  codeOnly: CodeOnly | null;
  /** The expanded graph, for the threads view. */
  graph: GraphView | null;
  layout: Layout;

  /** The model has changed since the file was written. */
  dirty: boolean;
  /** The sidecar has changed since it was written. */
  layoutDirty: boolean;
  /** `source` is older than `model`: generate before saving. */
  sourceStale: boolean;

  selected: string | null;
  view: EditorView;
  /** The canvas is showing the expanded graph (threads), read-only. */
  expanded: boolean;

  /**
   * The message the next save should commit with, or null for a plain save.
   *
   * It lives here rather than in the History panel because the two things that set it --
   * the save-with-message dialog and "apply to editor", which proposes `AI: <the
   * request>` -- both happen away from the panel, and the save that uses it is the
   * page's. `markSaved` clears it: a message belongs to one save.
   */
  pendingCommit: string | null;
  /** The commit the last save made, when it made one (section H). */
  lastCommit: Committed | null;
  /** How many times this flow has been written; the History tab refreshes on it. */
  saves: number;

  /** From `validateModel`, refreshed on every edit. */
  problems: Problem[];
  /** From `POST /check`, kept until the next check or edit. */
  serverProblems: Problem[];

  past: Snapshot[];
  future: Snapshot[];

  applyServerFlow: (response: FlowResponse) => void;
  /** After `POST /flows/generate`, or after the code view re-parses (F3). */
  setSource: (source: string) => void;
  /**
   * The code editor typed. The text is the artifact, so it goes in as it is and the model
   * follows a moment later through `applyParse`; nothing here rewrites what was typed.
   */
  editSource: (source: string) => void;
  /**
   * The answer to `POST /flows/parse` for the text that is in `source` now. `positions`
   * is the sidecar re-keyed for the tree that came back, when the caller could re-key it.
   */
  applyParse: (
    result: { model: FlowModel | null; code_only: CodeOnly | null; graph: GraphView | null },
    positions?: Record<string, Position>,
  ) => void;
  /** The property panel's body editor: this node's text is now that. */
  setNodeSource: (id: string, source: string) => void;
  markSaved: (response: { source: string; modified: string; commit?: Committed | null }) => void;
  /** The message the next save commits with; `null` puts it back to a plain save. */
  setPendingCommit: (message: string | null) => void;
  clear: () => void;

  select: (path: string | null) => void;
  setView: (view: EditorView) => void;
  setExpanded: (expanded: boolean) => void;

  /** Snapshot the current state for undo without changing anything (a drag is starting). */
  beginChange: () => void;
  /** The one way the model changes: a pure rewrite of the tree, plus any new nodes. */
  edit: (
    rewrite: (tree: Tree) => Tree,
    options?: { select?: string | null; addNodes?: NodeDef[] },
  ) => void;
  /** The node the flow starts from when it is run without a sample. */
  setStart: (id: string | null) => void;

  /*
   * `build()`'s keyword-only parameters (section E). They are not part of the tree, so
   * they do not go through `edit()`: nothing on the canvas moves when one is added, and
   * there are no paths to re-key. They are still a model edit -- undoable, and the code
   * is generated again from the model as for any other.
   */
  /** Add a parameter; without a name it gets one nothing else has. */
  addParam: (param?: Partial<FlowParam>) => void;
  /** Rename one. `paramNameError` says first whether the new name will do. */
  renameParam: (from: string, to: string) => void;
  /** Retype one: a new default literal, a new annotation, or both. */
  setParam: (name: string, patch: Partial<FlowParam>) => void;
  removeParam: (name: string) => void;

  appendBlock: (block: Tree, addNodes?: NodeDef[]) => void;
  insertAfter: (path: string, block: Tree, addNodes?: NodeDef[]) => void;
  insertBefore: (path: string, block: Tree, addNodes?: NodeDef[]) => void;
  removeBlock: (path: string) => void;
  moveStage: (path: string, toIndex: number) => void;
  wrapBlock: (path: string, kind: 'farm' | 'feedback') => void;
  unwrapBlock: (path: string) => void;
  replaceBlock: (path: string, block: Tree) => void;
  setFarmOptions: (path: string, patch: Partial<FarmOptions>) => void;
  setWorkers: (path: string, workers: number) => void;
  setBlockName: (path: string, name: string | null) => void;
  setMerge: (path: string, merge: boolean) => void;
  setCrossBlock: (path: string, which: 'R' | 'G', block: Tree | null) => void;

  setPosition: (path: string, position: Position) => void;
  /**
   * `dirty` is false when the canvas is only filling in positions the sidecar never had:
   * laying a flow out for the first time is not a change to save.
   */
  setPositions: (positions: Record<string, Position>, dirty?: boolean) => void;
  setViewport: (viewport: Viewport) => void;
  markLayoutSaved: () => void;

  setServerProblems: (problems: Problem[]) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  toSaveRequest: () => { path: string; source: string; modified: string } | null;
}

const INITIAL = {
  path: null,
  source: '',
  modified: null,
  model: null,
  codeOnly: null,
  graph: null,
  layout: emptyLayout(),
  dirty: false,
  layoutDirty: false,
  sourceStale: false,
  pendingCommit: null,
  lastCommit: null as Committed | null,
  saves: 0,
  selected: null,
  view: 'canvas' as EditorView,
  expanded: false,
  problems: [] as Problem[],
  serverProblems: [] as Problem[],
  past: [] as Snapshot[],
  future: [] as Snapshot[],
};

export const useFlowStore = create<FlowState>((set, get) => {
  function snapshot(): Snapshot {
    const state = get();
    return {
      model: state.model as FlowModel,
      layout: state.layout,
      selected: state.selected,
    };
  }

  function pushHistory(): Snapshot[] {
    const state = get();
    if (!state.model) return state.past;
    return [...state.past, snapshot()].slice(-HISTORY_LIMIT);
  }

  /** The one way the parameter list changes: snapshot, rewrite, revalidate. */
  function editParams(
    model: FlowModel,
    rewrite: (params: readonly FlowParam[]) => FlowParam[],
  ): void {
    const params = rewrite(model.params);
    const next: FlowModel = { ...model, params };
    set({
      past: pushHistory(),
      future: [],
      model: next,
      dirty: true,
      sourceStale: true,
      problems: validateModel(next),
      serverProblems: [],
    });
  }

  function restore(entry: Snapshot, other: Snapshot[], into: 'past' | 'future'): void {
    set({
      model: entry.model,
      layout: entry.layout,
      selected: entry.selected,
      problems: validateModel(entry.model),
      serverProblems: [],
      dirty: true,
      layoutDirty: true,
      sourceStale: true,
      ...(into === 'past' ? { past: other } : { future: other }),
    });
  }

  return {
    ...INITIAL,

    applyServerFlow: (response) => {
      const model = response.model ? normalizeModel(response.model) : null;
      set({
        path: response.path,
        source: response.source,
        modified: response.modified,
        model,
        codeOnly: response.code_only,
        graph: response.graph,
        layout: response.layout ? normalizeLayout(response.layout) : emptyLayout(),
        dirty: false,
        layoutDirty: false,
        sourceStale: false,
        // A message belongs to the flow it was written for; this is another file, or the
        // same one read back from the server. "Apply to editor" sets its own afterwards.
        pendingCommit: null,
        lastCommit: null,
        selected: null,
        expanded: model === null,
        problems: model ? validateModel(model) : [],
        serverProblems: [],
        past: [],
        future: [],
      });
    },

    setSource: (source) => set({ source, sourceStale: false }),

    editSource: (source) =>
      set((state) => (state.source === source ? {} : { source, dirty: true, sourceStale: false })),

    applyParse: (result, positions) => {
      const model = result.model ? normalizeModel(result.model) : null;
      set((state) => ({
        model,
        codeOnly: result.code_only,
        graph: result.graph,
        // A file that cannot be modelled has only its threads to show; one that can be
        // modelled again goes back to the blocks the person was looking at before.
        expanded: model === null ? true : state.codeOnly !== null ? false : state.expanded,
        ...(positions && positions !== state.layout.positions
          ? { layout: { ...state.layout, positions }, layoutDirty: true }
          : {}),
        selected:
          model && state.selected !== null && hasPath(model.flow, state.selected)
            ? state.selected
            : null,
        problems: model ? validateModel(model) : [],
        serverProblems: [],
      }));
    },

    setNodeSource: (id, source) => {
      const model = get().model;
      if (!model) return;
      const index = model.nodes.findIndex((node) => node.id === id);
      const current = model.nodes[index];
      if (!current || current.source === source) return;
      const nodes = [...model.nodes];
      nodes[index] = { ...current, source };
      const next: FlowModel = { ...model, nodes };
      set({
        past: pushHistory(),
        future: [],
        model: next,
        dirty: true,
        sourceStale: true,
        problems: validateModel(next),
        serverProblems: [],
      });
    },

    markSaved: (response) =>
      set((state) => ({
        source: response.source,
        modified: response.modified,
        dirty: false,
        sourceStale: false,
        pendingCommit: null,
        lastCommit: response.commit ?? null,
        saves: state.saves + 1,
      })),

    setPendingCommit: (message) => set({ pendingCommit: message?.trim() ? message.trim() : null }),

    clear: () => set({ ...INITIAL, layout: emptyLayout() }),

    select: (path) => set({ selected: path }),
    setView: (view) => set({ view }),
    setExpanded: (expanded) => set({ expanded }),

    beginChange: () => set({ past: pushHistory(), future: [] }),

    edit: (rewrite, options) => {
      const state = get();
      const model = state.model;
      if (!model) return;
      const before = model.flow;
      const after = rewrite(before);
      if (after === before && !options?.addNodes?.length) return;
      const renames = pathRenames(before, after);
      const selected =
        options && 'select' in options
          ? (options.select ?? null)
          : state.selected === null
            ? null
            : (renames[state.selected] ?? (hasPath(after, state.selected) ? state.selected : null));
      const added = options?.addNodes ?? [];
      const next: FlowModel = {
        ...model,
        flow: after,
        ...(added.length > 0 ? { nodes: [...model.nodes, ...added] } : {}),
      };
      set({
        past: pushHistory(),
        future: [],
        model: next,
        layout: {
          ...state.layout,
          positions: pathsAfterEdit(before, after, state.layout.positions),
        },
        dirty: true,
        layoutDirty: true,
        sourceStale: true,
        selected,
        problems: validateModel(next),
        serverProblems: [],
      });
    },

    setStart: (id) => {
      const model = get().model;
      if (!model) return;
      const next: FlowModel = { ...model, start: id };
      set({
        past: pushHistory(),
        future: [],
        model: next,
        dirty: true,
        sourceStale: true,
        problems: validateModel(next),
        serverProblems: [],
      });
    },

    addParam: (param) => {
      const model = get().model;
      if (!model) return;
      const name = param?.name ?? newParamName(model.params);
      editParams(model, (params) =>
        addParamEdit(params, {
          name,
          default: param?.default ?? 'None',
          annotation: param?.annotation ?? null,
        }),
      );
    },

    renameParam: (from, to) => {
      const model = get().model;
      if (!model) return;
      editParams(model, (params) => renameParamEdit(params, from, to));
    },

    setParam: (name, patch) => {
      const model = get().model;
      if (!model) return;
      editParams(model, (params) => setParamEdit(params, name, patch));
    },

    removeParam: (name) => {
      const model = get().model;
      if (!model) return;
      editParams(model, (params) => removeParamEdit(params, name));
    },

    /**
     * Adding a block from the palette puts it where it can work: a source goes first, a
     * sink last, and anything else in front of the sink that is already there, so a
     * click never leaves a flow that cannot run.
     */
    appendBlock: (block, addNodes = []) => {
      const model = get().model;
      if (!model) return;
      const withNodes: FlowModel = { ...model, nodes: [...model.nodes, ...addNodes] };
      const stages = model.flow.type === 'pipeline' ? model.flow.stages : [model.flow];
      const last = stages[stages.length - 1];
      const tailIsSink = last ? terminalKind(last, withNodes, 'last') === 'sink' : false;
      let index = stages.length;
      if (terminalKind(block, withNodes, 'first') === 'source') index = 0;
      else if (tailIsSink && terminalKind(block, withNodes, 'last') !== 'sink') index -= 1;
      get().edit(
        (tree) =>
          tree.type === 'pipeline'
            ? insertStageEdit(tree, ROOT, index, block)
            : appendStageEdit(tree, block),
        { select: `stages.${String(Math.max(0, index))}`, addNodes },
      );
    },
    insertAfter: (path, block, addNodes = []) =>
      get().edit((tree) => insertAfterEdit(tree, path, block), { addNodes }),
    insertBefore: (path, block, addNodes = []) =>
      get().edit((tree) => insertBeforeEdit(tree, path, block), { addNodes }),
    removeBlock: (path) => get().edit((tree) => removeAtEdit(tree, path), { select: null }),
    moveStage: (path, toIndex) => get().edit((tree) => moveStageEdit(tree, path, toIndex)),
    wrapBlock: (path, kind) =>
      get().edit(
        (tree) => (kind === 'farm' ? wrapInFarm(tree, path) : wrapInFeedback(tree, path)),
        {
          select: path,
        },
      ),
    unwrapBlock: (path) => get().edit((tree) => unwrapEdit(tree, path), { select: path }),
    replaceBlock: (path, block) => get().edit((tree) => replaceAtEdit(tree, path, block)),
    setFarmOptions: (path, patch) => get().edit((tree) => setFarmOptionsEdit(tree, path, patch)),
    setWorkers: (path, workers) => get().edit((tree) => setWorkersEdit(tree, path, workers)),
    setBlockName: (path, name) => get().edit((tree) => setBlockNameEdit(tree, path, name)),
    setMerge: (path, merge) => get().edit((tree) => setMergeEdit(tree, path, merge)),
    setCrossBlock: (path, which, block) =>
      get().edit((tree) => setCrossBlockEdit(tree, path, which, block)),

    setPosition: (path, position) =>
      set((state) => ({
        layout: { ...state.layout, positions: { ...state.layout.positions, [path]: position } },
        layoutDirty: true,
      })),

    setPositions: (positions, dirty = true) =>
      set((state) => ({
        layout: { ...state.layout, positions: { ...state.layout.positions, ...positions } },
        layoutDirty: state.layoutDirty || dirty,
      })),

    setViewport: (viewport) => set((state) => ({ layout: { ...state.layout, viewport } })),

    markLayoutSaved: () => set({ layoutDirty: false }),

    setServerProblems: (problems) => set({ serverProblems: problems }),

    undo: () => {
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (!entry) return;
      set({ future: [...state.future, snapshot()] });
      restore(entry, state.past.slice(0, -1), 'past');
    },

    redo: () => {
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (!entry) return;
      set({ past: [...state.past, snapshot()].slice(-HISTORY_LIMIT) });
      restore(entry, state.future.slice(0, -1), 'future');
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    toSaveRequest: () => {
      const { path, source, modified } = get();
      if (path === null || modified === null) return null;
      return { path, source, modified };
    },
  };
});

/** Everything wrong with the flow right now: what the model can see, and what the server said. */
export function allProblems(state: FlowState): Problem[] {
  return state.serverProblems.length === 0
    ? state.problems
    : [...state.problems, ...state.serverProblems];
}

/**
 * The same, as a hook. It has to be one: a selector that builds a new array every time it
 * runs makes `useSyncExternalStore` believe the store changed on every render.
 */
export function useProblems(): Problem[] {
  const problems = useFlowStore((state) => state.problems);
  const server = useFlowStore((state) => state.serverProblems);
  return useMemo(
    () => (server.length === 0 ? problems : [...problems, ...server]),
    [problems, server],
  );
}

/** The block the properties panel is editing. */
export const selectedPath = (state: FlowState): string => state.selected ?? ROOT;
