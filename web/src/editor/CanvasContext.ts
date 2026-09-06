import { createContext, useContext } from 'react';
import type { RunEdgeStatus, RunNodeStatus } from '../store/run';

/**
 * What every card on the canvas needs but React Flow does not carry: the live run, and
 * the problems `check` found. Both are keyed the way the rest of the app keys them --
 * run status by node name, problems by tree path -- so F4 can fill the first without
 * touching a component here.
 */
export interface CanvasContextValue {
  nodeStatus: Record<string, RunNodeStatus>;
  edgeStatus: Record<string, RunEdgeStatus>;
  /** Worst severity per tree path, from `validateModel` and from the server's check. */
  severity: Record<string, 'error' | 'warning'>;
  /** The tree path the properties panel is editing. */
  selected: string | null;
  readOnly: boolean;
}

export const EMPTY_CANVAS_CONTEXT: CanvasContextValue = {
  nodeStatus: {},
  edgeStatus: {},
  severity: {},
  selected: null,
  readOnly: false,
};

export const CanvasContext = createContext<CanvasContextValue>(EMPTY_CANVAS_CONTEXT);

export function useCanvas(): CanvasContextValue {
  return useContext(CanvasContext);
}
