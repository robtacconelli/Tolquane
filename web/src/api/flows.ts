/**
 * The flow routes of `docs/web-interfaces.md`, S4.
 *
 * Hand-typed from the contract for now and regenerated from the server's OpenAPI later,
 * so every wrapper here stays one line over `request()`: the generator will rewrite
 * exactly these lines, and nothing else in the app touches `fetch`.
 */

import type { FlowModel, FlowResponse, GraphView, Layout } from '../model/types';
import { api } from './client';

const at = (path: string): string => `/flows/${encodeURIComponent(path)}`;

export interface FlowSummary {
  path: string;
  name: string;
  modified: string;
  size: number;
  has_layout: boolean;
  last_run: { id: number; status: string; ended: string } | null;
}

export interface FlowList {
  workspace: string;
  flows: FlowSummary[];
}

export interface SaveFlowRequest {
  source: string;
  /** The `modified` that came with the flow; a newer one on disk answers 409. */
  modified: string;
}

export interface ParseResult {
  model: FlowModel | null;
  code_only: { reason: string } | null;
  graph: GraphView | null;
}

export interface CheckResult {
  ok: boolean;
  nodes: number;
  edges: number;
}

export interface OptimizeResult {
  source: string;
  notes: string[];
  graph: GraphView;
}

export const listFlows = () => api.get<FlowList>('/flows');

export const getFlow = (path: string) => api.get<FlowResponse>(at(path));

export const saveFlow = (path: string, body: SaveFlowRequest) =>
  api.put<FlowResponse>(at(path), body);

export const saveLayout = (path: string, layout: Layout) =>
  api.put<{ ok: true }>(`${at(path)}/layout`, layout);

export const parseSource = (source: string, name = 'flow') =>
  api.post<ParseResult>('/flows/parse', { source, name });

export const generateSource = (model: FlowModel) =>
  api.post<{ source: string }>('/flows/generate', { model });

export const checkFlow = (path: string) => api.post<CheckResult>(`${at(path)}/check`);

export const explainFlow = (path: string) => api.post<{ text: string }>(`${at(path)}/explain`);

export const drawFlow = (path: string) => api.post<{ mermaid: string }>(`${at(path)}/draw`);

export const optimizeFlow = (path: string, all2all = false) =>
  api.post<OptimizeResult>(`${at(path)}/optimize`, { all2all });
