/**
 * What the editor page mounts. CodeMirror is a lazy chunk, so this file loads it through
 * `lazy()` and nothing it imports statically reaches the main bundle; the sync driver
 * (`useCodeSync`) and the store live in modules of their own for the same reason.
 */

import { lazy, Suspense, type CSSProperties, type JSX } from 'react';
import { useCodeSyncStore } from './syncStore';

const Stage = lazy(() => import('./CodeStage'));
const Conflict = lazy(() => import('./ConflictDialog'));

const LOADING: CSSProperties = {
  display: 'flex',
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 'var(--tq-text-sm)',
  color: 'var(--tq-text-subtle)',
  background: 'var(--tq-surface-sunken)',
};

/** The Code view of the editor page. */
export function CodeStage(): JSX.Element {
  return (
    <Suspense fallback={<div style={LOADING}>Loading the editor…</div>}>
      <Stage />
    </Suspense>
  );
}

/** The dialogs the code view owns: for now, the one about a file changed on disk. */
export function CodeDialogs(): JSX.Element | null {
  const conflict = useCodeSyncStore((state) => state.conflict);
  if (!conflict) return null;
  return (
    <Suspense fallback={null}>
      <Conflict />
    </Suspense>
  );
}
