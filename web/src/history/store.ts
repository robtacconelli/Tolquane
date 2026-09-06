/**
 * What the editor knows about this flow's history: is there a repository, what has
 * happened to the file, and does it differ from the last commit.
 *
 * It is a store rather than component state because two places read it. The panel shows
 * the entries; the toolbar shows a dot on Save while the file is uncommitted, and that
 * has to be true whether or not the tab was ever opened. `useFlowHistory` in the editor
 * page keeps it pointed at the open flow and refreshes it after every save, so both are
 * looking at the same answer rather than asking the server twice.
 *
 * One version at a time is *not* in here: a version and its diff belong to the panel
 * that asked for them, and are gone when it closes.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { ApiError } from '../api/client';
import {
  flowHistory,
  workspaceHistory,
  type HistoryEntry,
  type HistoryStatus,
} from '../api/history';
import { useFlowStore } from '../store/flow';

/**
 * Git is not installed, as opposed to this directory not being a repository.
 *
 * The two look the same over the wire -- `available: false`, `repo: false` -- and only
 * the reason tells them apart, so the reason is what this reads. They need telling apart:
 * one of them is fixed by a button on this panel, and the other by a package manager.
 */
export function gitMissing(status: HistoryStatus | null): boolean {
  return status !== null && !status.available && /not on path/i.test(status.reason ?? '');
}

/** There is a workspace, git can see it, and it is simply not a repository yet. */
export function canInitialize(status: HistoryStatus | null): boolean {
  return status !== null && !status.available && !status.repo && !gitMissing(status);
}

export interface HistoryState {
  /** The right-hand column is showing History rather than the properties or the builder. */
  open: boolean;
  /** The workspace's answer, or null before the first one has arrived. */
  status: HistoryStatus | null;
  /** The flow the entries below belong to. */
  path: string | null;
  entries: HistoryEntry[];
  /** The file differs from the last commit of it: the dot on the Save button. */
  uncommitted: boolean;
  loading: boolean;
  /** Why the entries could not be read; the workspace status has its own `reason`. */
  error: string | null;

  setOpen: (open: boolean) => void;
  /** Ask again: the workspace's status and, when there is one, this flow's commits. */
  refresh: (path: string) => Promise<void>;
}

function reasonOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The history could not be read';
}

export const useHistoryStore = create<HistoryState>((set) => {
  /* Answers are numbered so a slow one for the flow that was open a moment ago cannot
   * land on top of the flow that is open now. */
  let sequence = 0;

  return {
    open: false,
    status: null,
    path: null,
    entries: [],
    uncommitted: false,
    loading: false,
    error: null,

    setOpen: (open) => set({ open }),

    refresh: async (path) => {
      const mine = (sequence += 1);
      set((state) =>
        state.path === path
          ? { loading: true, error: null }
          : { loading: true, error: null, path, entries: [], uncommitted: false },
      );
      try {
        const status = await workspaceHistory();
        if (mine !== sequence) return;
        set({ status });
        if (!status.available || !path) {
          set({ entries: [], uncommitted: false, loading: false });
          return;
        }
        const list = await flowHistory(path);
        if (mine !== sequence) return;
        set({
          entries: list.entries,
          uncommitted: list.uncommitted,
          loading: false,
          error: null,
        });
      } catch (error: unknown) {
        if (mine !== sequence) return;
        set({ loading: false, error: reasonOf(error) });
      }
    },
  };
});

/**
 * Keep the store on the open flow, and refresh it whenever the file is written.
 *
 * Mounted by the editor page, not by the panel: the Save button's dot is part of the
 * toolbar and has to be right before anyone opens the tab.
 */
export function useFlowHistory(path: string): void {
  const saves = useFlowStore((state) => state.saves);
  const refresh = useHistoryStore((state) => state.refresh);
  useEffect(() => {
    if (!path) return;
    void refresh(path);
  }, [path, saves, refresh]);
}
