/**
 * Two-way sync between the file and the canvas.
 *
 * The rule the whole thing hangs on: the text is the artifact and the model is derived
 * from it, so typing never loses a character and never waits for a request. What the
 * requests do is catch the model up.
 *
 *   typing in the code view  -> the text goes into the store at once,
 *                               `POST /flows/parse` 600 ms after the last keystroke,
 *                               the answer replaces the model (or says why it cannot)
 *   editing on the canvas    -> `POST /flows/generate` 350 ms after the last edit,
 *                               its answer replaces the text
 *   editing a node's body    -> a model edit, so it generates, and then parses once more
 *                               to show whatever the new body did to the file
 *
 * A request whose input has been overtaken is dropped rather than applied: the newer one
 * is already on its way, and applying an old answer is how a code editor eats a keystroke.
 */

import { useEffect } from 'react';
import { ApiError } from '../../api/client';
import { generateSource, getFlow, parseSource, saveFlow, type ParseResult } from '../../api/flows';
import { normalizeModel } from '../../model';
import { useFlowStore } from '../../store/flow';
import { relayout } from './locate';
import { useCodeSyncStore, type Conflict } from './syncStore';

/** After the last keystroke in the code view, before the file is parsed. */
export const PARSE_DEBOUNCE_MS = 600;
/** After the last canvas edit, before the file is written out again. */
export const GENERATE_DEBOUNCE_MS = 350;

/** Requests are numbered so an answer that has been overtaken can be dropped. */
let sequence = 0;

/** The flow's module name, which is what the parser calls it. */
function flowName(path: string | null): string {
  const file = (path ?? 'flow').split('/').pop() ?? 'flow';
  return file.replace(/\.py$/, '') || 'flow';
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** The code editor typed: the text is the truth now, the model follows in a moment. */
export function sourceTyped(text: string): void {
  useFlowStore.getState().editSource(text);
  useCodeSyncStore.getState().markTyped();
}

/** A node's body was rewritten in the property panel. */
export function nodeSourceTyped(id: string, text: string): void {
  const before = useFlowStore.getState().model;
  useFlowStore.getState().setNodeSource(id, text);
  if (useFlowStore.getState().model !== before) useCodeSyncStore.getState().markNodeTyped();
}

/** Apply a parse answer to the store, re-keying the layout as far as the names allow. */
export function applyParse(result: ParseResult): void {
  const state = useFlowStore.getState();
  const positions = result.model
    ? relayout(state.model?.flow ?? null, normalizeModel(result.model).flow, state.layout.positions)
    : state.layout.positions;
  state.applyParse(result, positions);
}

/**
 * Parse whatever is in the store's `source` right now. The answer is dropped when the
 * text has moved on: the keystroke that moved it has already scheduled the next parse.
 */
export async function runParse(): Promise<void> {
  const mine = ++sequence;
  const { source, path } = useFlowStore.getState();
  const sync = useCodeSyncStore.getState();
  sync.setPhase('parsing');
  try {
    const result = await parseSource(source, flowName(path));
    if (mine !== sequence) return;
    if (useFlowStore.getState().source !== source) return;
    applyParse(result);
    useCodeSyncStore.getState().setFailure(null);
  } catch (error: unknown) {
    if (mine !== sequence) return;
    useCodeSyncStore.getState().setFailure(reasonOf(error, 'The file could not be parsed'));
  } finally {
    if (mine === sequence) useCodeSyncStore.getState().setPhase('idle');
  }
}

/**
 * Write the model back out as Python. The answer is dropped when the model has moved on,
 * for the same reason as above; the edit that moved it has scheduled the next generation.
 */
export async function runGenerate(): Promise<void> {
  const mine = ++sequence;
  const model = useFlowStore.getState().model;
  if (!model) return;
  const sync = useCodeSyncStore.getState();
  sync.setPhase('generating');
  const verify = sync.takeVerify();
  try {
    const { source } = await generateSource(model);
    if (mine !== sequence) return;
    if (useFlowStore.getState().model !== model) return;
    useFlowStore.getState().setSource(source);
    useCodeSyncStore.getState().setFailure(null);
    if (verify) {
      useCodeSyncStore.getState().setPhase('idle');
      await runParse();
    }
  } catch (error: unknown) {
    if (mine !== sequence) return;
    useCodeSyncStore.getState().setFailure(reasonOf(error, 'The code could not be generated'));
  } finally {
    if (mine === sequence) useCodeSyncStore.getState().setPhase('idle');
  }
}

/** The 409 a save answers with when the file changed underneath it, as two versions. */
export function conflictOf(error: unknown, path: string, mine: string): Conflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const envelope = (error.detail as { error?: { detail?: unknown } } | null)?.error?.detail;
  const theirs = (envelope as { source?: unknown; modified?: unknown } | undefined) ?? {};
  if (typeof theirs.source !== 'string' || typeof theirs.modified !== 'string') return null;
  return { path, mine, theirs: theirs.source, modified: theirs.modified };
}

/** Report a failed save; true when it was a conflict and the dialog is now open. */
export function reportSaveFailure(error: unknown): boolean {
  const state = useFlowStore.getState();
  const conflict = state.path === null ? null : conflictOf(error, state.path, state.source);
  if (!conflict) return false;
  useCodeSyncStore.getState().openConflict(conflict);
  return true;
}

/** Save over the newer file on disk: this text wins. */
export async function keepMine(): Promise<void> {
  const conflict = useCodeSyncStore.getState().conflict;
  if (!conflict) return;
  const saved = await saveFlow(conflict.path, {
    source: conflict.mine,
    modified: conflict.modified,
  });
  useFlowStore.getState().markSaved({ source: saved.source, modified: saved.modified });
  applyParse({ model: saved.model, code_only: saved.code_only, graph: saved.graph });
  useCodeSyncStore.getState().closeConflict();
}

/** Throw this text away and open what is on disk. */
export async function takeTheirs(): Promise<void> {
  const conflict = useCodeSyncStore.getState().conflict;
  if (!conflict) return;
  useFlowStore.getState().applyServerFlow(await getFlow(conflict.path));
  useCodeSyncStore.getState().closeConflict();
}

/**
 * The driver. It lives on the editor page rather than in the code view because a canvas
 * edit has to reach the file whichever view is on screen -- the property panel edits node
 * bodies with the canvas showing -- and because mounting it here keeps CodeMirror out of
 * the main bundle: nothing in this module imports it.
 */
export function useCodeSync(): void {
  const typed = useCodeSyncStore((state) => state.typed);
  const path = useFlowStore((state) => state.path);
  const model = useFlowStore((state) => state.model);
  const sourceStale = useFlowStore((state) => state.sourceStale);

  // A different file is a different conversation: forget what the last one was doing.
  useEffect(() => {
    useCodeSyncStore.getState().reset();
  }, [path]);

  useEffect(() => {
    if (typed === 0) return;
    const timer = window.setTimeout(() => void runParse(), PARSE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    if (!sourceStale || !model) return;
    const timer = window.setTimeout(() => void runGenerate(), GENERATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sourceStale, model]);
}
