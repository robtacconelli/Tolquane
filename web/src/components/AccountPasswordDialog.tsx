import { useCallback, useId, useState, type JSX } from 'react';
import { changePassword } from '../api/auth';
import { Button } from './Button';
import { Notice } from './Notice';
import { Field, TextInput } from './form/Controls';
import { Dialog } from './form/Dialog';
import styles from './Account.module.css';

/**
 * Change your own password, from the account menu.
 *
 * The sessions that are open stay open -- this is one of them (docs/web-interfaces.md,
 * U) -- so there is nothing to sign in to again afterwards, and the dialog says so
 * rather than leaving the reader wondering whether the other tab has died.
 */

const MIN_PASSWORD = 8;

export function AccountPasswordDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = useCallback((): void => {
    if (next.length < MIN_PASSWORD) {
      setError(`A password is at least ${String(MIN_PASSWORD)} characters.`);
      return;
    }
    if (next !== again) {
      setError('Those two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    changePassword(current, next).then(
      () => {
        setBusy(false);
        setDone(true);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  }, [again, current, next]);

  return (
    <Dialog
      title="Change your password"
      description="At least eight characters. The sessions you have open stay open."
      width={460}
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy}>
              {busy ? 'Changing…' : 'Change the password'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Notice tone="success">Your password has been changed.</Notice>
      ) : (
        <div className={styles.stack}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label="Current password" htmlFor={`${uid}-current`}>
            <TextInput
              id={`${uid}-current`}
              data-autofocus
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>
          <Field
            label="New password"
            htmlFor={`${uid}-new`}
            hint={`At least ${String(MIN_PASSWORD)} characters.`}
          >
            <TextInput
              id={`${uid}-new`}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          </Field>
          <Field label="New password again" htmlFor={`${uid}-again`}>
            <TextInput
              id={`${uid}-again`}
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                submit();
              }}
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
