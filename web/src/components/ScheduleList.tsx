import type { JSX } from 'react';
import type { ScheduleRow } from '../api/schedules';
import { Button } from './Button';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import { Toggle } from './form/Controls';
import { formatRelative, runStatusLook, splitWhen } from './scheduleFormat';
import styles from './ScheduleList.module.css';

/**
 * The list itself: one row per schedule, on the same grid as the column header above it.
 * A disabled schedule keeps its row and its colour, it only stops saying when it is next
 * due, because "paused" is a state a reader has to be able to see at a glance.
 */
export function ScheduleList({
  rows,
  template,
  busyId,
  onRunNow,
  onToggle,
  onEdit,
  onDelete,
}: {
  rows: readonly ScheduleRow[];
  template: string;
  /** The schedule with a request in flight; its actions are held until it lands. */
  busyId: number | null;
  onRunNow: (row: ScheduleRow) => void;
  onToggle: (row: ScheduleRow, enabled: boolean) => void;
  onEdit: (row: ScheduleRow) => void;
  onDelete: (row: ScheduleRow) => void;
}): JSX.Element {
  return (
    <div className={styles.list} role="list">
      {rows.map((row) => {
        const next = splitWhen(row.next_run);
        const look = runStatusLook(row.last_status);
        const busy = busyId === row.id;
        return (
          <div
            key={row.id}
            className={styles.row}
            style={{ gridTemplateColumns: template }}
            data-paused={!row.enabled || undefined}
            role="listitem"
            aria-label={`Schedule for ${row.flow}`}
          >
            <div className={styles.cell}>
              <span className={styles.flow} title={row.flow}>
                {row.flow}
              </span>
              <span className={`${styles.meta} ${styles.metaOne}`}>
                {row.runtime}
                {row.sample ? ` · sample ${row.sample}` : ''}
              </span>
            </div>

            <div className={styles.cell}>
              <code className={styles.cron}>{row.cron}</code>
              <span className={styles.meta} title={row.description}>
                {row.description}
              </span>
            </div>

            <div className={styles.cell}>
              {row.enabled && next ? (
                <>
                  <span className={styles.when}>
                    {next.day}, {next.time}
                  </span>
                  <span className={styles.meta}>{formatRelative(row.next_run)}</span>
                </>
              ) : (
                <span className={styles.paused}>{row.enabled ? 'Not scheduled' : 'Paused'}</span>
              )}
            </div>

            <div className={styles.cell}>
              <span className={styles.status}>
                <StatusDot state={look.state} title={look.label} />
                {look.label}
              </span>
              {row.last_run === null ? null : (
                <span className={styles.meta}>run #{row.last_run}</span>
              )}
            </div>

            <div className={styles.toggleCell}>
              <Toggle
                checked={row.enabled}
                disabled={busy}
                onChange={(checked) => onToggle(row, checked)}
                label={
                  row.enabled
                    ? `Disable the schedule for ${row.flow}`
                    : `Enable the schedule for ${row.flow}`
                }
              />
            </div>

            <div className={styles.actions}>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onRunNow(row)}
                aria-label={`Run ${row.flow} now`}
              >
                <Icon name="play" size={13} />
                Run now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onEdit(row)}
                aria-label={`Edit the schedule for ${row.flow}`}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                className={styles.delete}
                disabled={busy}
                onClick={() => onDelete(row)}
                aria-label={`Delete the schedule for ${row.flow}`}
                title="Delete"
              >
                <Icon name="trash" size={14} />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The list's own shape while the first request is in flight. */
export function ScheduleListSkeleton({ template }: { template: string }): JSX.Element {
  return (
    <div className={styles.list} aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.row} style={{ gridTemplateColumns: template }}>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '72%' }} />
            <span className={styles.barSmall} style={{ width: '40%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '54%' }} />
            <span className={styles.barSmall} style={{ width: '80%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '86%' }} />
            <span className={styles.barSmall} style={{ width: '52%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '70%' }} />
          </div>
          <div className={styles.toggleCell}>
            <span className={styles.barToggle} />
          </div>
          <div className={styles.actions}>
            <span className={styles.bar} style={{ width: '60%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
