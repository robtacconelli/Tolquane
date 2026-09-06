import { useEffect, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { getRunLog, runTraceUrl, type Run } from '../api/runs';
import { Button } from '../components/Button';
import { Dialog } from '../components/form/Dialog';
import { Segmented } from '../components/Page';
import { StatusDot } from '../components/StatusDot';
import { formatWhen, runStatusLook } from '../components/scheduleFormat';
import { elapsedBetween, formatDuration, formatTrigger } from './format';
import { ReportTable } from './ReportTable';
import styles from './RunDialog.module.css';

/*
 * One past run, opened from the history: how it was started, how it went, and the three
 * things worth keeping afterwards -- the report, everything it printed, and whatever went
 * wrong. Re-running from here repeats the same flow, runtime and sample.
 */

type View = 'report' | 'log' | 'problem';

export function RunDialog({
  run,
  busy,
  onClose,
  onRerun,
  onCancel,
}: {
  run: Run;
  busy: boolean;
  onClose: () => void;
  onRerun: (run: Run) => void;
  onCancel: (run: Run) => void;
}): JSX.Element {
  const [view, setView] = useState<View>(run.error ? 'problem' : 'report');
  // The log is stamped with the run it belongs to, so opening another one reads as
  // loading again without an effect that has to empty it first.
  const [fetched, setFetched] = useState<{ id: number; text: string | null; error: string | null }>(
    { id: -1, text: null, error: null },
  );

  useEffect(() => {
    let cancelled = false;
    getRunLog(run.id).then(
      (text) => {
        if (!cancelled) setFetched({ id: run.id, text, error: null });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setFetched({
          id: run.id,
          text: null,
          error: caught instanceof ApiError ? caught.message : 'The log could not be read',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [run.id]);

  const log = fetched.id === run.id ? fetched.text : null;
  const logError = fetched.id === run.id ? fetched.error : null;

  const look = runStatusLook(run.status);
  const elapsed = elapsedBetween(run.started, run.ended);

  const views: { value: View; label: string }[] = [
    { value: 'report', label: 'Report' },
    { value: 'log', label: 'Log' },
  ];
  if (run.error) views.push({ value: 'problem', label: 'Problem' });

  return (
    <Dialog
      title={`Run ${String(run.id)} · ${run.flow}`}
      width={860}
      onClose={onClose}
      description={
        <span className={styles.facts}>
          <span className={styles.fact}>
            <StatusDot state={look.state} title={look.label} />
            {look.label}
          </span>
          <span className={styles.fact}>{formatWhen(run.started)}</span>
          <span className={styles.fact}>{formatDuration(elapsed)}</span>
          <span className={styles.fact}>{run.runtime}</span>
          <span className={styles.fact}>
            {run.sample === null ? 'the flow’s own source' : `sample ${run.sample}`}
          </span>
          <span className={styles.fact}>{formatTrigger(run.trigger)}</span>
        </span>
      }
      footer={
        <>
          {run.trace_path ? (
            <a className={styles.trace} href={runTraceUrl(run.id)} download>
              Download the trace
            </a>
          ) : null}
          {run.live ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                onCancel(run);
              }}
            >
              Cancel this run
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              onRerun(run);
            }}
            data-autofocus
          >
            Run it again
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.views}>
          <Segmented label="What to show" options={views} value={view} onChange={setView} />
        </div>

        {view === 'report' ? (
          run.report ? (
            <div className={styles.scroll}>
              <ReportTable report={run.report} />
            </div>
          ) : (
            <p className={styles.empty}>
              This run has no report: it was {look.label.toLowerCase()} before one was made.
            </p>
          )
        ) : null}

        {view === 'log' ? (
          logError ? (
            <p className={styles.empty}>{logError}</p>
          ) : log === null ? (
            <p className={styles.empty}>Reading the log…</p>
          ) : log === '' ? (
            <p className={styles.empty}>This run printed nothing.</p>
          ) : (
            <pre className={styles.log}>{log}</pre>
          )
        ) : null}

        {view === 'problem' && run.error ? <pre className={styles.log}>{run.error}</pre> : null}
      </div>
    </Dialog>
  );
}
