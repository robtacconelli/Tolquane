/**
 * Saving, with or without a commit.
 *
 * Two lines of policy the editor page would otherwise carry: what goes in the request
 * body when a message is waiting, and what the toolbar says afterwards. They are here so
 * they can be read on their own -- and tested without a page, a store or a fetch.
 */

import type { Committed } from '../api/history';
import type { SaveFlowRequest } from '../api/flows';

/** The `commit` part of `PUT /api/flows/{path}`: present only when a message is waiting. */
export function commitBody(pending: string | null): Pick<SaveFlowRequest, 'commit'> {
  const message = (pending ?? '').trim();
  return message ? { commit: { message } } : {};
}

/**
 * What the save said, in one line.
 *
 * A commit nobody asked for is the `auto_commit` setting doing its job, and it says so: a
 * revision appearing out of a plain Cmd/Ctrl+S is otherwise a mystery. A commit that was
 * asked for and did not happen says so too -- almost always because the file was already
 * what the last commit holds, and otherwise because git refused, which the server logs.
 */
export function savedText(commit: Committed | null, asked: boolean): string {
  if (!commit) return asked ? 'Saved. There was nothing to commit.' : 'Saved';
  return asked
    ? `Saved and committed as ${commit.short}`
    : `Saved and committed as ${commit.short}, because auto-commit is on`;
}
