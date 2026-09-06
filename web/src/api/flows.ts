/**
 * The flow routes of `docs/web-interfaces.md`, S4.
 *
 * Every type here comes from the server's own OpenAPI document through
 * `client.ts`'s `Schemas`; what is written out is only what the schema cannot say. The
 * server passes the S1 model, the expanded graph and the layout sidecar through as
 * plain objects (they are not FastAPI models), so those four fields get their real
 * types back here from `model/types.ts`.
 *
 * Every wrapper stays one line over `request()`: nothing else in the app touches
 * `fetch`, and regenerating the types must never mean rewriting behaviour.
 */

import type { CodeOnly, FlowModel, GraphView, Layout } from '../model/types';
import { type Complete, type Schemas, api } from './client';

const at = (path: string): string => `/flows/${encodeURIComponent(path)}`;

/** The four objects the server hands through untyped, with their S1 types. */
interface FlowShapes {
  model: FlowModel | null;
  code_only: CodeOnly | null;
  graph: GraphView | null;
  layout: Layout | null;
}

/** `GET /api/flows/{path}` and everything else that answers with a whole flow. */
export type FlowDetail = Omit<Complete<Schemas['FlowDetail']>, keyof FlowShapes> & FlowShapes;

/** What `POST /api/flows/parse` says about source that is not saved yet. */
export type ParseResult = Omit<Complete<Schemas['ParseResult']>, keyof FlowShapes> &
  Omit<FlowShapes, 'layout'>;

/** `POST /api/flows/{path}/optimize`: `source` is null until the rewrite has a Python form. */
export type OptimizeResult = Omit<Complete<Schemas['OptimizeResult']>, 'graph'> & {
  graph: GraphView | null;
};

export type CheckResult = Complete<Schemas['CheckResult']>;
export type SaveFlowRequest = Schemas['SaveFlow'];

export type { FlowList, FlowSummary } from './flowsList';

export { listFlows } from './flowsList';

export const getFlow = (path: string) => api.get<FlowDetail>(at(path));

/**
 * `PUT /api/flows/{path}`.
 *
 * `commit: {message}` (section H) asks for the save to be committed as well as written,
 * and the answer's `commit` is the revision that was made -- `null` when nothing changed,
 * when the `auto_commit` setting was off and no message was given, or when git refused a
 * commit the save had already gone through without. A commit asked for in a workspace
 * that is not a repository is a 400 with the file untouched, so the caller may offer it
 * only where `workspaceHistory()` says there is a repository.
 */
export const saveFlow = (path: string, body: SaveFlowRequest) =>
  api.put<FlowDetail>(at(path), body);

export const saveLayout = (path: string, layout: Layout) =>
  api.put<Schemas['Ok']>(`${at(path)}/layout`, layout);

export const parseSource = (source: string, name = 'flow') =>
  api.post<ParseResult>('/flows/parse', { source, name } satisfies Schemas['ParseRequest']);

export const generateSource = (model: FlowModel) =>
  api.post<Schemas['GenerateResult']>('/flows/generate', { model });

export const checkFlow = (path: string) => api.post<CheckResult>(`${at(path)}/check`);

export const explainFlow = (path: string) =>
  api.post<Schemas['ExplainResult']>(`${at(path)}/explain`);

export const drawFlow = (path: string) => api.post<Schemas['DrawResult']>(`${at(path)}/draw`);

export const optimizeFlow = (path: string, all2all = false) =>
  api.post<OptimizeResult>(`${at(path)}/optimize`, {
    all2all,
  } satisfies Schemas['OptimizeRequest']);
