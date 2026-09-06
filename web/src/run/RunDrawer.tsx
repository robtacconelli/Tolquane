import { useEffect, useMemo, useState, type JSX } from 'react';
import { StatusDot } from '../components/StatusDot';
import { runStatusLook } from '../components/scheduleFormat';
import type { Problem } from '../model';
import { useRunStore } from '../store/run';
import { ConsolePane } from './ConsolePane';
import { formatDuration } from './format';
import { ProblemsPane } from './ProblemsPane';
import { ReportPane } from './ReportPane';
import { TapsPane } from './TapsPane';
import styles from './Run.module.css';

/*
 * The drawer under the canvas: four ways of looking at the same run.
 *
 * The tab a person is on belongs to the page, not to this component -- pressing Check
 * takes them to Problems -- so it comes in as a prop. Everything else is read from the
 * run store, which is the only thing the socket writes to.
 */

export type DrawerTab = 'Console' | 'Taps' | 'Report' | 'Problems';

const TABS: readonly DrawerTab[] = ['Console', 'Taps', 'Report', 'Problems'];

/** How a run reads while it is going: `done` only once the run says so. */
function useElapsed(): number {
  const status = useRunStore((state) => state.status);
  const startedAt = useRunStore((state) => state.startedAt);
  const elapsed = useRunStore((state) => state.elapsed);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== 'running' || startedAt === null) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 200);
    return () => {
      window.clearInterval(timer);
    };
  }, [status, startedAt]);

  if (status !== 'running' || startedAt === null) return elapsed;
  // Snapshots arrive every half second; the clock in between is this page's own.
  return Math.max(elapsed, (now - startedAt) / 1000);
}

export function RunDrawer({
  tab,
  onTab,
  problems,
  selected,
  onSelectProblem,
}: {
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  /** F2's problems: the model's own and the server's last `check`. */
  problems: readonly Problem[];
  selected: string | null;
  onSelectProblem: (path: string) => void;
}): JSX.Element {
  const status = useRunStore((state) => state.status);
  const nodes = useRunStore((state) => state.nodes);
  const edges = useRunStore((state) => state.edges);
  const report = useRunStore((state) => state.report);
  const runProblems = useRunStore((state) => state.problems);
  const lines = useRunStore((state) => state.lines);
  const aliases = useRunStore((state) => state.aliases);
  const selectEdge = useRunStore((state) => state.selectEdge);
  const elapsed = useElapsed();

  const look = runStatusLook(status === 'idle' ? null : status);

  const tapped = useMemo(
    () =>
      Object.entries(edges).filter(([key, edge]) => !(key in aliases.edges) && edge.taps.length > 0)
        .length,
    [edges, aliases],
  );

  const handled = useMemo(() => {
    // The items the flow has taken in: the sources' output, which is every item that
    // entered the graph, without counting the same item again at every stage.
    let items = 0;
    for (const [name, node] of Object.entries(nodes)) {
      if (name in aliases.nodes) continue;
      items = Math.max(items, node.items_out);
    }
    return items;
  }, [nodes, aliases]);

  /*
   * Clicking an edge on the canvas shows its items. The canvas is F2's and has no
   * handler for it, but React Flow marks every edge in the DOM with its own id, and an
   * id is `source~target~kind`: enough to name the edge the run store knows.
   */
  useEffect(() => {
    function onClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const edge = target.closest<HTMLElement>('.react-flow__edge[data-id]');
      const id = edge?.dataset.id;
      if (!id) return;
      const parts = id.split('~');
      if (parts.length < 2) return;
      const key = `${parts[0] ?? ''}->${parts[1] ?? ''}`;
      if (!(key in useRunStore.getState().edges)) return;
      selectEdge(key);
      onTab('Taps');
    }
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
  }, [onTab, selectEdge]);

  const errors = problems.filter((problem) => problem.severity === 'error').length;
  const counts: Record<DrawerTab, number> = {
    Console: lines.length,
    Taps: tapped,
    Report: report ? Object.keys(report.nodes).length : 0,
    Problems: problems.length + runProblems.length,
  };

  return (
    <div className={styles.drawer}>
      <div className={styles.tabs} role="tablist" aria-label="Run output">
        {TABS.map((name) => {
          const bad = name === 'Problems' && (errors > 0 || runProblems.length > 0);
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === tab}
              className={name === tab ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => {
                onTab(name);
              }}
            >
              {name}
              <span className={bad ? `${styles.tabCount} ${styles.tabCountBad}` : styles.tabCount}>
                {counts[name]}
              </span>
            </button>
          );
        })}

        <span className={styles.tabSpacer} />

        <span className={styles.summary} data-status={status}>
          <span className={styles.summaryState}>
            <StatusDot state={look.state} title={look.label} />
            {status === 'idle' ? 'No run yet' : look.label}
          </span>
          {status === 'idle' ? null : (
            <>
              <span className={styles.summaryDivider} />
              <span className={styles.summaryFigure}>{formatDuration(elapsed)}</span>
              <span className={styles.summaryDivider} />
              <span className={styles.summaryFigure}>{handled.toLocaleString()} items</span>
            </>
          )}
        </span>
      </div>

      {tab === 'Console' ? (
        <ConsolePane />
      ) : tab === 'Taps' ? (
        <TapsPane />
      ) : tab === 'Report' ? (
        <ReportPane />
      ) : (
        <ProblemsPane problems={problems} selected={selected} onSelect={onSelectProblem} />
      )}
    </div>
  );
}
