import type { JSX } from 'react';
import type { RunReport } from '../api/runs';
import { StatusDot } from '../components/StatusDot';
import type { RunNodeStatus } from '../store/run';
import { formatCount, formatSeconds, formatShare } from './format';
import styles from './Run.module.css';

/*
 * `Report.to_dict()` as the table `print(report)` shows in a terminal, plus the one thing
 * a terminal cannot do: the busiest node picked out, and the busy share drawn as a bar
 * behind its own number so the column can be read without reading any of it.
 *
 * Shared by the editor's Report tab and the run history, which show the same table for a
 * run that has just finished and for one from last week.
 */

const COLUMNS = ['Node', 'In', 'Out', 'Dropped', 'Busy', 'Busy %', 'Wait in', 'Wait out'] as const;

export function ReportTable({
  report,
  states,
}: {
  report: RunReport;
  /** The live node states, when there are any: the dot beside each name. */
  states?: Record<string, RunNodeStatus>;
}): JSX.Element {
  const busiest = report.busiest[0] ?? null;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          {COLUMNS.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Object.entries(report.nodes).map(([name, stats]) => (
          <tr key={name} className={name === busiest ? styles.busiest : undefined}>
            <td>
              <span className={styles.nodeCell}>
                <StatusDot state={states?.[name]?.state ?? 'done'} />
                {name}
              </span>
              {name === busiest ? <span className={styles.chip}>busiest</span> : null}
            </td>
            <td>{formatCount(stats.items_in)}</td>
            <td>{formatCount(stats.items_out)}</td>
            <td>{stats.dropped === 0 ? '—' : formatCount(stats.dropped)}</td>
            <td>{formatSeconds(stats.busy)}</td>
            <td>
              <span className={styles.bar}>
                <span
                  className={styles.barFill}
                  style={{ width: `${String(Math.round(Math.min(1, stats.busy_share) * 100))}%` }}
                />
                <span className={styles.barValue}>{formatShare(stats.busy_share)}</span>
              </span>
            </td>
            <td>{formatSeconds(stats.wait_in)}</td>
            <td>{formatSeconds(stats.wait_out)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
