/**
 * Somebody else wrote this file while it was open.
 *
 * The save answered 409 and gave back what is on disk, so the question can be asked
 * properly: here is the difference, keep yours or take theirs. Nothing is decided for the
 * person -- both versions exist and only one of these two buttons throws one away.
 */

import { useMemo, useState, type JSX } from 'react';
import { ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/form/Dialog';
import styles from './code.module.css';
import { diffCounts, diffRows } from './diff';
import { keepMine, takeTheirs } from './sync';
import { useCodeSyncStore } from './syncStore';

const GLYPH = { add: '+', del: '−', same: ' ', gap: '⋯' } as const;

export function ConflictDialog(): JSX.Element | null {
  const conflict = useCodeSyncStore((state) => state.conflict);
  const close = useCodeSyncStore((state) => state.closeConflict);
  const [busy, setBusy] = useState<'mine' | 'theirs' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const rows = useMemo(
    () => (conflict ? diffRows(conflict.theirs, conflict.mine) : []),
    [conflict],
  );

  if (!conflict) return null;
  const counts = diffCounts(rows);

  const run = (which: 'mine' | 'theirs', action: () => Promise<void>) => () => {
    setBusy(which);
    setFailure(null);
    action()
      .catch((error: unknown) => {
        setFailure(error instanceof ApiError ? error.message : 'That did not work');
      })
      .finally(() => setBusy(null));
  };

  return (
    <Dialog
      title="This file changed on disk"
      description={
        <>
          <code className={styles.reason}>{conflict.path}</code> was written by something else while
          it was open here. Yours adds {counts.added} line
          {counts.added === 1 ? '' : 's'} and takes away {counts.removed}.
        </>
      }
      width={860}
      onClose={close}
      footer={
        <>
          {failure ? <span className={styles.diffError}>{failure}</span> : null}
          <Button onClick={close} disabled={busy !== null}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={run('theirs', takeTheirs)} disabled={busy !== null}>
            {busy === 'theirs' ? 'Reloading…' : 'Take theirs'}
          </Button>
          <Button
            variant="danger"
            onClick={run('mine', keepMine)}
            disabled={busy !== null}
            data-autofocus
          >
            {busy === 'mine' ? 'Saving…' : 'Keep mine'}
          </Button>
        </>
      }
    >
      <div className={styles.diffLegend}>
        <span className={styles.diffKeyDel}>− on disk</span>
        <span className={styles.diffKeyAdd}>+ in the editor</span>
      </div>
      <div
        className={`${styles.surface ?? ''} ${styles.diff ?? ''}`}
        role="table"
        aria-label="Difference between the file on disk and the editor"
      >
        {rows.map((row, index) => (
          <div
            key={`${String(index)}-${row.text}`}
            className={styles.diffRow}
            data-kind={row.kind}
            role="row"
          >
            <span className={styles.diffNumber}>{row.left ?? ''}</span>
            <span className={styles.diffNumber}>{row.right ?? ''}</span>
            <span className={styles.diffGlyph}>{GLYPH[row.kind]}</span>
            <span className={styles.diffText}>{row.text}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export default ConflictDialog;
