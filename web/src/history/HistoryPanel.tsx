import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  flowVersion,
  initHistory,
  restoreVersion,
  type HistoryEntry,
  type HistoryStatus,
  type HistoryVersion,
} from '../api/history';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { Segmented } from '../components/Page';
import { ConfirmDialog } from '../components/form/Dialog';
import { formatRelative, formatWhen } from '../components/scheduleFormat';
import { diffCounts, diffRows } from '../editor/code/diff';
import { useIsAdmin } from '../store/auth';
import { useFlowStore } from '../store/flow';
import { canInitialize, gitMissing, useHistoryStore } from './store';
import styles from './History.module.css';

/**
 * The History tab: what has happened to this flow, and how to get any of it back.
 *
 * Tolquane keeps no versions of its own (section H). The workspace is a git repository or
 * it is not, and this is a small window onto it: the commits that touched the open file,
 * newest first; "uncommitted changes" on top when the file differs from the last commit;
 * one version at a time with its difference against the file as it is now; and a restore
 * that writes the old text back without committing anything.
 *
 * Three states come before any of that, and each of them says what to do rather than
 * apologising: git is not installed (nothing this panel can do), the workspace is not a
 * repository (an administrator can make one, here), or the repository has nothing about
 * this flow yet (save it with a message).
 */
export function HistoryPanel({
  path,
  onProperties,
  onAi,
  onSaveWithMessage,
}: {
  /** The open flow's path in the workspace; `''` when none is open. */
  path: string;
  /** Go back to the properties panel. */
  onProperties: () => void;
  /** Hand the column to the AI builder. */
  onAi: () => void;
  /** Open the save-with-message dialog (the same one Cmd/Ctrl+Shift+S opens). */
  onSaveWithMessage: () => void;
}): JSX.Element {
  const status = useHistoryStore((state) => state.status);
  const entries = useHistoryStore((state) => state.entries);
  const uncommitted = useHistoryStore((state) => state.uncommitted);
  const loading = useHistoryStore((state) => state.loading);
  const error = useHistoryStore((state) => state.error);
  const refresh = useHistoryStore((state) => state.refresh);
  /* `git init` in somebody's workspace is an administrator's move (section U); the answer
   * is already in the auth store, asked once when the app started. */
  const admin = useIsAdmin();

  const source = useFlowStore((state) => state.source);
  const dirty = useFlowStore((state) => state.dirty);
  const applyServerFlow = useFlowStore((state) => state.applyServerFlow);

  /* A version and its diff belong to this panel: they are asked for on a click and
   * forgotten when the reader goes back. The page gives this component `key={path}`, so
   * opening another flow mounts a fresh one and none of it has to be put back by hand. */
  const [showing, setShowing] = useState<{ entry: HistoryEntry; version: HistoryVersion } | null>(
    null,
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /* Opening the tab is a question, so it is asked again: the editor page keeps the store
   * fresh across saves, but a commit made in a terminal while this was closed would not
   * be in it. The refresh button in the header asks once more after that. */
  useEffect(() => {
    if (path) void refresh(path);
  }, [path, refresh]);

  function open(entry: HistoryEntry): void {
    setOpening(entry.rev);
    setFailure(null);
    flowVersion(path, entry.rev)
      .then((version) => setShowing({ entry, version }))
      .catch((cause: unknown) => setFailure(reasonOf(cause, 'That version could not be read')))
      .finally(() => setOpening(null));
  }

  function initialize(): void {
    setBusy(true);
    setFailure(null);
    initHistory()
      .then(() => refresh(path))
      .catch((cause: unknown) => setFailure(reasonOf(cause, 'The repository could not be made')))
      .finally(() => setBusy(false));
  }

  function restore(entry: HistoryEntry): void {
    setBusy(true);
    setFailure(null);
    restoreVersion(path, entry.rev)
      .then(async (flow) => {
        applyServerFlow(flow);
        setConfirming(null);
        setShowing(null);
        setNote(`Restored from ${entry.short}. The file is written, and not committed.`);
        await refresh(path);
      })
      .catch((cause: unknown) => setFailure(reasonOf(cause, 'That version could not be restored')))
      .finally(() => setBusy(false));
  }

  return (
    <div className={styles.panel} aria-label="History">
      <header className={styles.head}>
        <Segmented
          label="Right panel"
          options={[
            { value: 'properties', label: 'Properties' },
            { value: 'ai', label: 'AI builder' },
            { value: 'history', label: 'History' },
          ]}
          value="history"
          onChange={(value) => {
            if (value === 'properties') onProperties();
            else if (value === 'ai') onAi();
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label="Refresh the history"
          title="Refresh the history"
          disabled={loading || !path}
          onClick={() => void refresh(path)}
        >
          <Icon name="refresh" size={14} />
        </Button>
      </header>

      <div className={styles.body}>
        {note ? (
          <Notice tone="info" onDismiss={() => setNote(null)}>
            {note}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="error" onDismiss={() => setFailure(null)}>
            {failure}
          </Notice>
        ) : null}

        {showing ? (
          <Version
            entry={showing.entry}
            version={showing.version}
            current={source}
            busy={busy}
            onBack={() => setShowing(null)}
            onRestore={() => setConfirming(showing.entry)}
          />
        ) : (
          <Entries
            path={path}
            status={status}
            admin={admin}
            entries={entries}
            uncommitted={uncommitted}
            loading={loading}
            error={error}
            busy={busy}
            opening={opening}
            onOpen={open}
            onInitialize={initialize}
            onSaveWithMessage={onSaveWithMessage}
          />
        )}
      </div>

      {confirming ? (
        <ConfirmDialog
          title="Restore this version?"
          body={
            <>
              <code className={styles.dialogPath}>{path}</code> goes back to what it was at{' '}
              <span className={styles.rev}>{confirming.short}</span>, “{confirming.message}”. The
              file is written straight away and nothing is committed, so the change itself becomes
              the next thing you can save.
              {dirty ? ' The edits you have not saved are lost.' : ''}
            </>
          }
          confirmLabel="Restore"
          busy={busy}
          error={failure}
          onConfirm={() => restore(confirming)}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** The list, and the three things that can stand in its place. */
function Entries({
  path,
  status,
  admin,
  entries,
  uncommitted,
  loading,
  error,
  busy,
  opening,
  onOpen,
  onInitialize,
  onSaveWithMessage,
}: {
  path: string;
  status: HistoryStatus | null;
  admin: boolean;
  entries: readonly HistoryEntry[];
  uncommitted: boolean;
  loading: boolean;
  error: string | null;
  busy: boolean;
  opening: string | null;
  onOpen: (entry: HistoryEntry) => void;
  onInitialize: () => void;
  onSaveWithMessage: () => void;
}): JSX.Element | null {
  // Before the first answer there is nothing true to say, so the panel says nothing.
  if (status === null) {
    return loading ? <p className={styles.waiting}>Looking for a repository…</p> : null;
  }

  if (gitMissing(status)) {
    return (
      <Empty
        title="History needs git"
        body={
          <>
            {status.reason} Tolquane keeps no versions of its own: the history in this tab is the
            workspace's own repository.
          </>
        }
      />
    );
  }

  if (canInitialize(status)) {
    return (
      <Empty
        title="This workspace has no history"
        body={
          admin
            ? 'Make it a git repository and every save can be a version you can come back to. Nothing is committed until you ask for it.'
            : status.reason
        }
        actions={
          admin ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={onInitialize}>
              {busy ? 'Initializing…' : 'Initialize history'}
            </Button>
          ) : null
        }
      />
    );
  }

  if (!status.available) return <Empty title="No history here" body={status.reason} />;
  if (error) return <Empty title="The history could not be read" body={error} />;
  if (!path)
    return <Empty title="No flow is open" body="Open a flow to see what happened to it." />;

  return (
    <>
      {uncommitted ? (
        <div className={styles.uncommitted}>
          <span className={styles.uncommittedDot} aria-hidden="true" />
          <div className={styles.uncommittedText}>
            <span className={styles.message}>Uncommitted changes</span>
            <span className={styles.meta}>
              {entries.length > 0
                ? `Not in ${entries[0]?.short ?? 'the last commit'}`
                : 'This file has never been committed'}
            </span>
          </div>
          <Button size="sm" onClick={onSaveWithMessage}>
            Commit…
          </Button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        uncommitted ? null : (
          <Empty
            title="Nothing committed yet"
            body="Commits that touch this flow appear here, newest first. Save it with a message to make the first one."
          />
        )
      ) : (
        <ul className={styles.entries}>
          {entries.map((entry) => (
            <li key={entry.rev}>
              <button
                type="button"
                className={styles.entry}
                data-head={entry.head ? 'yes' : undefined}
                aria-busy={opening === entry.rev}
                onClick={() => onOpen(entry)}
              >
                <span className={styles.entryTop}>
                  <span className={styles.message}>{entry.message}</span>
                  {entry.head ? <span className={styles.headMark}>head</span> : null}
                </span>
                <span className={styles.meta}>
                  <span className={styles.rev}>{entry.short}</span>
                  <span className={styles.author}>{entry.author}</span>
                  <span title={formatWhen(entry.date)}>{formatRelative(entry.date)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const GLYPH = { add: '+', del: '−', same: ' ', gap: '⋯' } as const;

/**
 * One version: what it was, and what has changed since.
 *
 * The rows come from the editor's own folded diff (`editor/code/diff.ts`), so a version
 * reads exactly like the conflict dialog: the long stretches of agreement are one line
 * saying how many, and the disagreement is the whole of what is on screen. The line
 * numbers the dialog shows are left out here -- the column is 320px wide, and the
 * difference is what a reader came for.
 */
function Version({
  entry,
  version,
  current,
  busy,
  onBack,
  onRestore,
}: {
  entry: HistoryEntry;
  version: HistoryVersion;
  current: string;
  busy: boolean;
  onBack: () => void;
  onRestore: () => void;
}): JSX.Element {
  const rows = useMemo(() => diffRows(version.source, current), [version.source, current]);
  const counts = diffCounts(rows);
  const same = counts.added === 0 && counts.removed === 0;

  return (
    <div className={styles.version}>
      <Button size="sm" variant="ghost" className={styles.back} onClick={onBack}>
        <Icon name="chevronLeft" size={14} />
        All versions
      </Button>

      <div className={styles.about}>
        <span className={styles.message}>{entry.message}</span>
        <span className={styles.meta}>
          <span className={styles.rev}>{entry.short}</span>
          <span className={styles.author}>{entry.author}</span>
          <span title={formatWhen(entry.date)}>{formatRelative(entry.date)}</span>
        </span>
      </div>

      {same ? (
        <p className={styles.identical}>This version is the file as it is now.</p>
      ) : (
        <>
          <div className={styles.legend}>
            <span className={styles.keyDel}>− {entry.short}</span>
            <span className={styles.keyAdd}>+ now</span>
            <span className={styles.counts}>
              {counts.added} added, {counts.removed} removed
            </span>
          </div>
          <div
            className={styles.diff}
            role="table"
            aria-label={`Difference between ${entry.short} and the file now`}
          >
            {rows.map((row, index) => (
              <div
                key={`${String(index)}-${row.text}`}
                className={styles.diffRow}
                data-kind={row.kind}
                role="row"
              >
                <span className={styles.diffGlyph}>{GLYPH[row.kind]}</span>
                <span className={styles.diffText}>{row.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}>
          Restore this version
        </Button>
      </div>
    </div>
  );
}

function Empty({
  title,
  body,
  actions,
}: {
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyGlyph}>
        <Icon name="clock" size={18} />
      </span>
      <span className={styles.emptyTitle}>{title}</span>
      {body ? <p className={styles.emptyBody}>{body}</p> : null}
      {actions ? <div className={styles.emptyActions}>{actions}</div> : null}
    </div>
  );
}
