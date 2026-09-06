/**
 * The history routes of `docs/web-interfaces.md`, section H.
 *
 * A workspace that is a git repository already keeps versions of every flow, so Tolquane
 * keeps none of its own: these five wrappers are a window onto that repository -- is
 * there one, make one, what happened to this flow, what did it look like then, put it
 * back. Who is holding the window is a question `src/store/auth.ts` has already asked:
 * only an administrator is offered `git init`, and `useIsAdmin()` says whether the
 * caller is one.
 *
 * Every type comes from the server's OpenAPI through `client.ts`'s `Schemas`, and every
 * wrapper is one line over `request()`, as DESIGN.md requires.
 *
 * A route that has no history to read (git is not installed, or this is not a
 * repository) answers 400 with git's own reason, so every call but `workspaceHistory`
 * can throw an `ApiError` whose message is the sentence to show. `workspaceHistory`
 * always answers: it is the question the tab asks first.
 */

import { type Complete, type Schemas, api } from './client';
import type { FlowDetail } from './flows';

/** The same address the flow routes use; the path is one segment, slashes and all. */
const at = (path: string): string => `/flows/${encodeURIComponent(path)}`;

/** `GET /api/workspace/history`: is this workspace in a repository, and how dirty is it? */
export type HistoryStatus = Complete<Schemas['HistoryStatus']>;

/** One commit that touched a flow. `date` is ISO 8601; `head` marks the current commit. */
export type HistoryEntry = Complete<Schemas['HistoryEntry']>;

export type HistoryList = Complete<Schemas['HistoryList']>;

/** One old version: its whole source, and git's own unified diff against the file now. */
export type HistoryVersion = Complete<Schemas['HistoryVersion']>;

/** The commit a save made, when it made one. */
export type Committed = Complete<Schemas['Committed']>;

export const workspaceHistory = () => api.get<HistoryStatus>('/workspace/history');

export const initHistory = () => api.post<Schemas['Ok']>('/workspace/history/init');

export const flowHistory = (path: string, limit = 50) =>
  api.get<HistoryList>(`${at(path)}/history`, { query: { limit } });

export const flowVersion = (path: string, rev: string) =>
  api.get<HistoryVersion>(`${at(path)}/history/${encodeURIComponent(rev)}`);

export const restoreVersion = (path: string, rev: string) =>
  api.post<FlowDetail>(`${at(path)}/restore`, { rev } satisfies Schemas['RestoreRequest']);
