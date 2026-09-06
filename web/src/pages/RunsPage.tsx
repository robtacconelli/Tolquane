import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { cancelRun, getRun, listRuns, startRun, type Run } from '../api/runs';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { EmptyRunsArt } from '../components/Illustrations';
import { Notice } from '../components/Notice';
import { ListColumns, Page, PageHeader, Panel, PanelHeader, Segmented } from '../components/Page';
import { Select } from '../components/form/Controls';
import { StatusDot } from '../components/StatusDot';
import { runStatusLook, splitWhen } from '../components/scheduleFormat';
import { elapsedBetween, formatDuration, formatTrigger } from '../run/format';
import { RunDialog } from '../run/RunDialog';
import styles from './Runs.module.css';

/*
 * Every run this workspace has had, newest first.
 *
 * The list is the store's (S3), so it survives the server going away and coming back. A
 * run that is still going is polled -- there can be several at once and a socket each
 * would be four sockets to say the same thing -- and the poll stops the moment nothing
 * is live, so an idle page is an idle page.
 */

const COLUMNS = ['Flow', 'Status', 'Started', 'Duration', 'Busiest', 'Trigger', ''] as const;
const TEMPLATE = 'minmax(0, 2fr) 132px 132px 90px minmax(0, 1fr) 92px 168px';

type Filter = 'all' | 'running' | 'done' | 'failed';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
] as const satisfies readonly { value: Filter; label: string }[];

const LIVE_POLL_MS = 1500;

function matches(run: Run, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return run.status === 'running';
  if (filter === 'done') return run.status === 'done';
  return run.status === 'failed' || run.status === 'deadlock' || run.status === 'cancelled';
}

export function RunsPage(): JSX.Element {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [flow, setFlow] = useState<string>('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listRuns({ limit: 100 }).then(
      (answer) => {
        if (cancelled) return;
        setRuns(answer.runs);
        setLoadError(null);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setRuns(null);
        setLoadError(caught instanceof Error ? caught : new Error(String(caught)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const live = runs?.some((run) => run.status === 'running') ?? false;

  // While something is going, keep asking; when nothing is, stop entirely.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(reload, LIVE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [live, reload]);

  const flows = useMemo(() => {
    const names = new Set((runs ?? []).map((run) => run.flow));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [runs]);

  const rows = useMemo(
    () => (runs ?? []).filter((run) => matches(run, filter) && (flow === '' || run.flow === flow)),
    [runs, filter, flow],
  );

  const open = useMemo(() => rows.find((run) => run.id === openId) ?? null, [rows, openId]);

  const rerun = useCallback(
    async (run: Run): Promise<void> => {
      setBusyId(run.id);
      setActionError(null);
      try {
        const started = await startRun({
          path: run.flow,
          runtime: run.runtime,
          sample: run.sample,
          tap: 5,
          trace: run.trace_path !== null,
        });
        setNotice(`Run ${String(started.id)} started for ${run.flow}.`);
        setOpenId(null);
        reload();
      } catch (caught: unknown) {
        setActionError(
          caught instanceof ApiError ? caught.message : 'The run could not be started',
        );
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const stop = useCallback(
    async (run: Run): Promise<void> => {
      setBusyId(run.id);
      setActionError(null);
      try {
        await cancelRun(run.id);
        // The supervisor sends SIGTERM and writes the status when the child is gone.
        window.setTimeout(reload, 400);
      } catch (caught: unknown) {
        setActionError(
          caught instanceof ApiError ? caught.message : 'The run could not be stopped',
        );
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  // The dialog needs the log-bearing version, which the list route leaves out.
  useEffect(() => {
    if (openId === null) return;
    let cancelled = false;
    getRun(openId).then(
      (run) => {
        if (!cancelled) {
          setRuns((all) => (all ?? []).map((old) => (old.id === run.id ? run : old)));
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const offline = loadError instanceof ApiError && loadError.isOffline;

  return (
    <Page>
      <PageHeader
        title="Runs"
        description="Every run is a child process streaming its progress back here: node states, item counts, queue depths, output and the final report."
      />

      <Panel>
        <PanelHeader
          title="History"
          hint={live ? 'Live; refreshing while runs are going' : 'Kept in ~/.tolquane/web.db'}
          actions={
            <div className={styles.filters}>
              <Select
                className={styles.select}
                aria-label="Filter by flow"
                value={flow}
                onChange={(event) => {
                  setFlow(event.target.value);
                }}
              >
                <option value="">All flows</option>
                {flows.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              <Segmented
                label="Filter runs"
                options={FILTERS}
                value={filter}
                onChange={setFilter}
              />
              <Button size="sm" variant="ghost" onClick={reload}>
                <Icon name="refresh" size={14} />
                Refresh
              </Button>
            </div>
          }
        />

        {notice ? (
          <Notice
            tone="success"
            onDismiss={() => {
              setNotice(null);
            }}
          >
            {notice}
          </Notice>
        ) : null}

        {actionError ? (
          <Notice
            tone="error"
            onDismiss={() => {
              setActionError(null);
            }}
          >
            {actionError}
          </Notice>
        ) : null}

        <ListColumns columns={COLUMNS} template={TEMPLATE} />

        {runs === null && !loadError ? <RunListSkeleton /> : null}

        {loadError ? (
          <EmptyState
            art={<EmptyRunsArt />}
            title={offline ? 'The server is not running' : 'Runs could not be loaded'}
            body={
              offline ? (
                <>
                  Start it with <code>tolquane web</code>. Past runs live in the Tolquane Web
                  database and come back with it.
                </>
              ) : (
                loadError.message
              )
            }
            actions={<Button onClick={reload}>Try again</Button>}
          />
        ) : null}

        {runs && rows.length === 0 && !loadError ? (
          <EmptyState
            art={<EmptyRunsArt />}
            title={runs.length === 0 ? 'Nothing has run yet' : 'No run matches that'}
            body={
              runs.length === 0
                ? 'Open a flow and press Run. Progress arrives live while it works, and the run stays here afterwards with its report and log.'
                : 'Widen the filter to see the rest of the history.'
            }
            actions={
              <Button
                variant="primary"
                onClick={() => {
                  if (runs.length === 0) void navigate('/flows');
                  else {
                    setFilter('all');
                    setFlow('');
                  }
                }}
              >
                {runs.length === 0 ? 'Open a flow' : 'Clear the filter'}
              </Button>
            }
          />
        ) : null}

        {rows.length > 0 ? (
          <div className={styles.list}>
            {rows.map((run) => {
              const look = runStatusLook(run.status);
              const started = splitWhen(run.started);
              const elapsed = elapsedBetween(run.started, run.ended);
              const busiest = run.report?.busiest[0] ?? null;
              const busy = busyId === run.id;
              return (
                <div key={run.id} className={styles.row} style={{ gridTemplateColumns: TEMPLATE }}>
                  <div className={styles.cell}>
                    <button
                      type="button"
                      className={styles.open}
                      onClick={() => {
                        setOpenId(run.id);
                      }}
                      title={`Run ${String(run.id)} · ${run.flow}`}
                    >
                      {run.flow}
                    </button>
                    <span className={styles.meta}>
                      run {run.id} · {run.runtime}
                      {run.sample ? ` · sample ${run.sample}` : ''}
                    </span>
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.status}>
                      <StatusDot state={look.state} title={look.label} />
                      {look.label}
                      {run.status === 'running' ? <span className={styles.live}>live</span> : null}
                    </span>
                  </div>

                  <div className={styles.cell}>
                    {started ? (
                      <>
                        <span className={styles.when}>{started.time}</span>
                        <span className={styles.meta}>{started.day}</span>
                      </>
                    ) : (
                      <span className={styles.none}>—</span>
                    )}
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.figure}>{formatDuration(elapsed)}</span>
                  </div>

                  <div className={styles.cell}>
                    {busiest ? (
                      <span className={styles.busiest} title={run.report?.busiest.join(', ')}>
                        {busiest}
                      </span>
                    ) : (
                      <span className={styles.none}>—</span>
                    )}
                  </div>

                  <div className={styles.cell}>
                    <span className={styles.meta}>{formatTrigger(run.trigger)}</span>
                  </div>

                  <div className={styles.actions}>
                    {run.status === 'running' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void stop(run)}
                        aria-label={`Cancel run ${String(run.id)}`}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void rerun(run)}
                        aria-label={`Run ${run.flow} again`}
                      >
                        <Icon name="play" size={13} />
                        Run again
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOpenId(run.id);
                      }}
                      aria-label={`Open run ${String(run.id)}`}
                    >
                      Open
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </Panel>

      {open ? (
        <RunDialog
          run={open}
          busy={busyId === open.id}
          onClose={() => {
            setOpenId(null);
          }}
          onRerun={(run) => void rerun(run)}
          onCancel={(run) => void stop(run)}
        />
      ) : null}
    </Page>
  );
}

/** The list's own shape while the first request is in flight, as on the other pages. */
function RunListSkeleton(): JSX.Element {
  return (
    <div className={styles.list} aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className={styles.row} style={{ gridTemplateColumns: TEMPLATE }}>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '62%' }} />
            <span className={styles.barSmall} style={{ width: '38%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '58%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '70%' }} />
            <span className={styles.barSmall} style={{ width: '52%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '48%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '56%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '60%' }} />
          </div>
          <div className={styles.cell} />
        </div>
      ))}
    </div>
  );
}
