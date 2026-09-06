import type { JSX } from 'react';
import { runTraceUrl } from '../api/runs';
import { useRunStore } from '../store/run';
import { formatDuration } from './format';
import { ReportTable } from './ReportTable';
import styles from './Run.module.css';

/* The report of the run in the editor, once it has one. */

export function ReportPane(): JSX.Element {
  const report = useRunStore((state) => state.report);
  const runId = useRunStore((state) => state.runId);
  const nodes = useRunStore((state) => state.nodes);
  const status = useRunStore((state) => state.status);
  const trace = useRunStore((state) => state.options.trace);

  if (!report) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>
          {status === 'running'
            ? 'The report arrives when the run ends: items in and out, time busy and time waiting, per node.'
            : status === 'idle'
              ? 'Run the flow to see where its time went.'
              : 'This run produced no report; the Problems tab says why.'}
        </p>
      </div>
    );
  }

  const busiest = report.busiest[0] ?? null;

  return (
    <div className={styles.pane}>
      <div className={styles.paneBar}>
        <span className={styles.paneLabel}>Report</span>
        <span className={styles.paneFact}>
          {report.runtime} · {formatDuration(report.elapsed)} · {Object.keys(report.nodes).length}{' '}
          nodes
        </span>
        {busiest ? (
          <span className={styles.paneFact}>
            · busiest <span className={styles.paneName}>{busiest}</span>
          </span>
        ) : null}
        <span className={styles.paneSpacer} />
        {trace && runId !== null ? (
          <a className={styles.link} href={runTraceUrl(runId)} download>
            Download the trace
          </a>
        ) : null}
      </div>

      <div className={styles.tableWrap}>
        <ReportTable report={report} states={nodes} />
      </div>
    </div>
  );
}
