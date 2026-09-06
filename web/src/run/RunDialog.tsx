import { useEffect, useMemo, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import {
  getRunLog,
  getRunNotifications,
  runTraceUrl,
  type Run,
  type RunNotification,
} from '../api/runs';
import { Button } from '../components/Button';
import { Dialog } from '../components/form/Dialog';
import { Segmented } from '../components/Page';
import { StatusDot } from '../components/StatusDot';
import { formatWhen, runStatusLook } from '../components/scheduleFormat';
import { toPythonLiteral } from '../inputs/params';
import { elapsedBetween, formatDuration, formatTrigger, parseTrigger, retryChain } from './format';
import { ReportTable } from './ReportTable';
import styles from './RunDialog.module.css';

/*
 * One past run, opened from the history: how it was started, how it went, and the things
 * worth keeping afterwards -- the report, everything it printed, whatever went wrong, the
 * inputs it was given and, for a scheduled run, who was told and what was tried again.
 * Re-running from here repeats the same flow, runtime, sample, parameters and environment.
 */

type View = 'report' | 'log' | 'problem' | 'inputs' | 'outcome';

export function RunDialog({
  run,
  runs = [],
  busy,
  onClose,
  onRerun,
  onCancel,
  onOpenRun,
}: {
  run: Run;
  /** The history this run is in, so a retry can be shown with the firing it followed. */
  runs?: readonly Run[];
  busy: boolean;
  onClose: () => void;
  onRerun: (run: Run) => void;
  onCancel: (run: Run) => void;
  /** Clicking a run of the chain opens that one instead. */
  onOpenRun?: (id: number) => void;
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
  const trigger = parseTrigger(run.trigger);
  const scheduled = trigger.schedule !== null;
  const chain = useMemo(() => retryChain(runs, run), [runs, run]);
  const paramNames = Object.keys(run.params);
  const envNames = Object.keys(run.env);
  const hasInputs = paramNames.length > 0 || envNames.length > 0;

  /* Who was told, and whether the message got there. Only a scheduled run has any: a
   * manual one is being watched by the person who started it. */
  const [notifications, setNotifications] = useState<{ id: number; rows: RunNotification[] }>({
    id: -1,
    rows: [],
  });

  useEffect(() => {
    if (!scheduled) return;
    let cancelled = false;
    getRunNotifications(run.id).then(
      (answer) => {
        if (!cancelled) setNotifications({ id: run.id, rows: answer.notifications });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [run.id, scheduled]);

  const attempts = notifications.id === run.id ? notifications.rows : [];

  const views: { value: View; label: string }[] = [
    { value: 'report', label: 'Report' },
    { value: 'log', label: 'Log' },
  ];
  if (run.error) views.push({ value: 'problem', label: 'Problem' });
  if (hasInputs) views.push({ value: 'inputs', label: 'Inputs' });
  if (scheduled) views.push({ value: 'outcome', label: 'Outcome' });

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

        {view === 'inputs' ? (
          <div className={styles.scroll}>
            {/* The parameters as `build()` was called with them, written the way the CLI
                would have written them, so the line can be run in a terminal. */}
            {paramNames.length > 0 ? (
              <>
                <h3 className={styles.subhead}>Parameters</h3>
                <dl className={styles.pairs}>
                  {paramNames.map((name) => (
                    <div key={name} className={styles.pair}>
                      <dt className={styles.pairName}>{name}</dt>
                      <dd className={styles.pairValue}>{toPythonLiteral(run.params[name])}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : null}
            {envNames.length > 0 ? (
              <>
                <h3 className={styles.subhead}>Environment</h3>
                <dl className={styles.pairs}>
                  {envNames.map((name) => (
                    <div key={name} className={styles.pair}>
                      <dt className={styles.pairName}>{name}</dt>
                      <dd className={styles.pairValue}>{run.env[name]}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : null}
          </div>
        ) : null}

        {view === 'outcome' ? (
          <div className={styles.scroll}>
            <h3 className={styles.subhead}>Attempts</h3>
            {/* The firing and every retry after it: one row each, so a chain that ended
                well after three tries reads as three tries and not as three runs. */}
            <ul className={styles.chain} aria-label="Attempts">
              {chain.map((other) => {
                const its = runStatusLook(other.status);
                const label = parseTrigger(other.trigger);
                return (
                  <li key={other.id} className={styles.chainItem}>
                    <button
                      type="button"
                      className={other.id === run.id ? styles.chainThis : styles.chainOther}
                      disabled={!onOpenRun || other.id === run.id}
                      onClick={() => onOpenRun?.(other.id)}
                    >
                      <StatusDot state={its.state} title={its.label} />
                      <span className={styles.chainWhich}>
                        {label.kind === 'retry' ? label.label : 'First attempt'}
                      </span>
                      <span className={styles.chainMeta}>run {other.id}</span>
                      <span className={styles.chainMeta}>{formatWhen(other.started)}</span>
                      <span className={styles.chainMeta}>{its.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <h3 className={styles.subhead}>Notifications</h3>
            {attempts.length === 0 ? (
              <p className={styles.empty}>
                Nobody was told about this run. A schedule tells somebody only about the endings it
                was asked about, and only after the last retry.
              </p>
            ) : (
              <ul className={styles.chain} aria-label="Notifications sent">
                {attempts.map((attempt) => (
                  <li key={attempt.id} className={styles.chainItem}>
                    <span className={styles.notification}>
                      <StatusDot
                        state={attempt.status === 'sent' ? 'done' : 'failed'}
                        title={attempt.status}
                      />
                      <span className={styles.chainWhich}>{attempt.channel}</span>
                      <span className={styles.notificationTarget}>{attempt.target}</span>
                      <span className={styles.chainMeta}>{attempt.error ?? 'sent'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
