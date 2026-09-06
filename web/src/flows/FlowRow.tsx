import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { FlowSummary } from '../api/flowsList';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { StatusDot } from '../components/StatusDot';
import { formatRelative, runStatusLook, splitWhen } from '../components/scheduleFormat';
import styles from './Flows.module.css';
import { folderOf, formatSize } from './format';

export function FlowRow({
  flow,
  template,
  busy,
  onRename,
  onDelete,
}: {
  flow: FlowSummary;
  template: string;
  busy: boolean;
  onRename: (flow: FlowSummary) => void;
  onDelete: (flow: FlowSummary) => void;
}): JSX.Element {
  const look = runStatusLook(flow.last_run?.status ?? null);
  const when = splitWhen(flow.modified);
  const folder = folderOf(flow.path);

  return (
    <div className={styles.row} style={{ gridTemplateColumns: template }}>
      <div className={styles.cell}>
        <Link className={styles.name} to={`/flows/${flow.path}`}>
          {flow.name}
        </Link>
        {folder ? <span className={styles.meta}>{folder}/</span> : null}
      </div>

      <div className={styles.cell}>
        <span className={styles.status}>
          <StatusDot state={look.state} title={look.label} />
          {look.label}
        </span>
        {flow.last_run ? (
          <span className={styles.meta}>{formatRelative(flow.last_run.ended)}</span>
        ) : null}
      </div>

      <div className={styles.cell}>
        <span className={styles.when}>{when ? `${when.day}, ${when.time}` : '—'}</span>
        <span className={styles.meta}>{formatRelative(flow.modified)}</span>
      </div>

      <div className={styles.cell}>
        <span className={styles.size}>{formatSize(flow.size)}</span>
        {flow.has_layout ? <span className={styles.badge}>laid out</span> : null}
      </div>

      <div className={styles.actions}>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onRename(flow)}
          aria-label={`Rename ${flow.path}`}
        >
          Rename
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          className={styles.delete}
          disabled={busy}
          onClick={() => onDelete(flow)}
          aria-label={`Delete ${flow.path}`}
          title="Delete"
        >
          <Icon name="close" size={14} />
        </Button>
      </div>
    </div>
  );
}

/** The list's shape while the first request is in flight. */
export function FlowListSkeleton({ template }: { template: string }): JSX.Element {
  return (
    <div className={styles.list} aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.row} style={{ gridTemplateColumns: template }}>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '58%' }} />
            <span className={styles.barSmall} style={{ width: '34%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '64%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '78%' }} />
            <span className={styles.barSmall} style={{ width: '46%' }} />
          </div>
          <div className={styles.cell}>
            <span className={styles.bar} style={{ width: '52%' }} />
          </div>
          <div className={styles.actions} />
        </div>
      ))}
    </div>
  );
}
