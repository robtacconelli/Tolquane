import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { listFlows, type FlowSummary } from '../api/flowsList';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
  type ScheduleRow,
} from '../api/schedules';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { EmptySchedulesArt } from '../components/Illustrations';
import { ListColumns, Page, PageHeader, Panel, PanelHeader } from '../components/Page';
import { ScheduleDialog, type ScheduleFormValues } from '../components/ScheduleDialog';
import { ScheduleList, ScheduleListSkeleton } from '../components/ScheduleList';
import { ConfirmDialog } from '../components/form/Dialog';
import { zoneLabel } from '../components/scheduleFormat';
import styles from './Schedules.module.css';

const COLUMNS = ['Flow', 'Schedule', 'Next run', 'Last result', 'Enabled', ''] as const;
const TEMPLATE = 'minmax(0, 1.7fr) minmax(0, 1.9fr) 140px 118px 64px 176px';

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

type DialogState = { mode: 'create' } | { mode: 'edit'; row: ScheduleRow } | null;

export function SchedulesPage(): JSX.Element {
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirming, setConfirming] = useState<ScheduleRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const answer = await listSchedules();
        if (cancelled) return;
        setRows(answer.schedules);
        setLoadError(null);
      } catch (caught) {
        if (cancelled) return;
        setRows(null);
        setLoadError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /* The picker needs flow names; a workspace that cannot be listed is not fatal here. */
  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const answer = await listFlows();
        if (!cancelled) setFlows(answer.flows);
      } catch {
        if (!cancelled) setFlows([]);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  async function withRow(row: ScheduleRow, work: () => Promise<void>): Promise<void> {
    setBusyId(row.id);
    setActionError(null);
    try {
      await work();
    } catch (caught) {
      setActionError(messageOf(caught));
    } finally {
      setBusyId(null);
    }
  }

  function runNow(row: ScheduleRow): void {
    void withRow(row, async () => {
      const run = await runScheduleNow(row.id);
      setNotice(`Run #${run.id} started for ${row.flow}.`);
      reload();
    });
  }

  function toggle(row: ScheduleRow, enabled: boolean): void {
    void withRow(row, async () => {
      const updated = await updateSchedule(row.id, { enabled });
      setNotice(null);
      setRows((current) =>
        (current ?? []).map((candidate) =>
          candidate.id === row.id ? { ...candidate, ...updated } : candidate,
        ),
      );
    });
  }

  async function save(values: ScheduleFormValues): Promise<void> {
    if (dialog?.mode === 'edit') {
      await updateSchedule(dialog.row.id, values);
      setNotice(`Saved the schedule for ${values.flow}.`);
    } else {
      await createSchedule(values);
      setNotice(`Scheduled ${values.flow}.`);
    }
    setDialog(null);
    setActionError(null);
    reload();
  }

  function confirmDelete(): void {
    const row = confirming;
    if (!row) return;
    setDeleting(true);
    setDeleteError(null);
    void deleteSchedule(row.id)
      .then(() => {
        setConfirming(null);
        setNotice(`Deleted the schedule for ${row.flow}.`);
        reload();
      })
      .catch((caught: unknown) => setDeleteError(messageOf(caught)))
      .finally(() => setDeleting(false));
  }

  const offline = loadError instanceof ApiError && loadError.isOffline;
  const newButton = (
    <Button variant="primary" onClick={() => setDialog({ mode: 'create' })}>
      <Icon name="plus" />
      New schedule
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="Schedules"
        description="Run a flow on a cron expression while the server is up. Missed times are not queued: a schedule fires once when it comes due."
        actions={newButton}
      />

      <Panel>
        <PanelHeader
          title="Scheduled flows"
          hint={`Five-field cron, in ${zoneLabel()}`}
          actions={
            <Button size="sm" variant="ghost" onClick={reload}>
              Refresh
            </Button>
          }
        />

        {notice ? (
          <div className={styles.notice} role="status">
            <Icon name="check" size={14} />
            <span>{notice}</span>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ) : null}

        {actionError ? (
          <div className={styles.failure} role="alert">
            <Icon name="alert" size={14} />
            <span>{actionError}</span>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => setActionError(null)}
              aria-label="Dismiss"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ) : null}

        <ListColumns columns={COLUMNS} template={TEMPLATE} />

        {rows === null && !loadError ? <ScheduleListSkeleton template={TEMPLATE} /> : null}

        {loadError ? (
          <EmptyState
            art={<EmptySchedulesArt />}
            title={offline ? 'The server is not running' : 'Schedules could not be loaded'}
            body={
              offline ? (
                <>
                  Start it with <code>tolquane web</code>. Schedules live in the Tolquane Web
                  database and come back with it.
                </>
              ) : (
                loadError.message
              )
            }
            actions={<Button onClick={reload}>Try again</Button>}
          />
        ) : null}

        {rows && rows.length === 0 ? (
          <EmptyState
            art={<EmptySchedulesArt />}
            title="No schedules"
            body="Pick a flow and a cron expression. Tolquane shows the expression in plain English and the next five times before you save it."
            actions={newButton}
          />
        ) : null}

        {rows && rows.length > 0 ? (
          <ScheduleList
            rows={rows}
            template={TEMPLATE}
            busyId={busyId}
            onRunNow={runNow}
            onToggle={toggle}
            onEdit={(row) => setDialog({ mode: 'edit', row })}
            onDelete={(row) => {
              setDeleteError(null);
              setConfirming(row);
            }}
          />
        ) : null}
      </Panel>

      {dialog ? (
        <ScheduleDialog
          mode={dialog.mode}
          initial={dialog.mode === 'edit' ? dialog.row : null}
          flows={flows}
          onSubmit={save}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Delete this schedule?"
          body={
            <>
              <code>{confirming.flow}</code> runs {confirming.description}. Deleting the schedule
              stops that; the flow file and its past runs are untouched.
            </>
          }
          confirmLabel="Delete schedule"
          busy={deleting}
          error={deleteError}
          onConfirm={confirmDelete}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </Page>
  );
}
