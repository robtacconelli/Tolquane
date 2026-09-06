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
  setBlockName as setBlockNameEdit,
  setCrossBlock as setCrossBlockEdit,
  setFarmOptions as setFarmOptionsEdit,
  setMerge as setMergeEdit,
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

  /** From `validateModel`, refreshed on every edit. */
  problems: Problem[];
  /** From `POST /check`, kept until the next check or edit. */
  serverProblems: Problem[];

  past: Snapshot[];
  future: Snapshot[];

  applyServerFlow: (response: FlowResponse) => void;
  /** After `POST /flows/generate`, or after the code view re-parses (F3). */
  setSource: (source: string) => void;
  markSaved: (response: { source: string; modified: string }) => void;
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
        selected: null,
        expanded: model === null,
        problems: model ? validateModel(model) : [],
        serverProblems: [],
        past: [],
        future: [],
      });
    },

    setSource: (source) => set({ source, sourceStale: false }),

    markSaved: (response) =>
      set({
        source: response.source,
        modified: response.modified,
        dirty: false,
        sourceStale: false,
      }),

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
