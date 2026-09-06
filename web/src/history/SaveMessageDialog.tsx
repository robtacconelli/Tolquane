import { useId, useState, type JSX } from 'react';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { Field, TextInput } from '../components/form/Controls';
import { Dialog } from '../components/form/Dialog';
import { useFlowStore } from '../store/flow';
import { useHistoryStore } from './store';
import styles from './History.module.css';

/**
 * Save with a message (Cmd/Ctrl+Shift+S).
 *
 * The message is the commit's, and it starts as whatever is already waiting -- the one
 * "apply to editor" wrote after a builder answer, usually -- so the common case is
 * Cmd/Ctrl+Shift+S, Enter. An empty message is allowed: the server writes `Edit <path>`,
 * which the placeholder says.
 *
 * In a workspace with no repository there is nothing to commit to, and a save that asks
 * for one is refused before the file is written (section H). So the dialog says why and
 * offers the plain save instead of a button that cannot work.
 */
export function SaveMessageDialog({
  path,
  onSave,
  onClose,
}: {
  path: string;
  /** Save now: with this commit message, or with none at all. */
  onSave: (message: string | null) => void;
  onClose: () => void;
}): JSX.Element {
  const pending = useFlowStore((state) => state.pendingCommit);
  const status = useHistoryStore((state) => state.status);
  const [message, setMessage] = useState(pending ?? '');
  const id = useId();

  const canCommit = status?.available ?? true;
  /* An empty message is the placeholder: the server's own `Edit <path>`, sent as the
   * message so that "Save and commit" with nothing typed still commits. */
  const fallback = `Edit ${path || 'this flow'}`;
  const commit = (): void => onSave(canCommit ? message.trim() || fallback : null);

  return (
    <Dialog
      title="Save with a message"
      description={
        canCommit ? (
          <>
            The message goes on the commit this save makes for{' '}
            <span className={styles.dialogPath}>{path || 'this flow'}</span>.
          </>
        ) : undefined
      }
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={commit} data-autofocus={canCommit ? undefined : true}>
            {canCommit ? 'Save and commit' : 'Save without committing'}
          </Button>
        </>
      }
    >
      {canCommit ? (
        <Field
          label="Commit message"
          htmlFor={id}
          hint="Enter saves and commits; Escape leaves the file alone."
        >
          <TextInput
            id={id}
            value={message}
            data-autofocus
            placeholder={fallback}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commit();
            }}
          />
        </Field>
      ) : (
        <Notice tone="warning">
          {status?.reason ?? 'There is no repository here, so there is nothing to commit to.'}
        </Notice>
      )}
    </Dialog>
  );
}
