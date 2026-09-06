import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import {
  createToken,
  deleteToken,
  listTokens,
  type ApiTokenRow,
  type IssuedToken,
} from '../api/auth';
import { SecretOnce } from './AccountSecret';
import { Button } from './Button';
import { Notice } from './Notice';
import { formatWhen, formatRelative } from './scheduleFormat';
import { Field, TextInput } from './form/Controls';
import { Dialog } from './form/Dialog';
import styles from './Account.module.css';

/**
 * Your personal API tokens: what a script signs in with when nobody is at the keyboard.
 *
 * The server keeps only a sha256 of each one, so a token exists as a string exactly
 * once -- here, on the line it is made -- and the dialog says so before it is made and
 * shows it plainly afterwards, with a copy button. Revoking one stops whatever was using
 * it at once, which is the point of having them separately from the session.
 */
export function AccountTokensDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const uid = useId();
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null);
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback((): void => {
    listTokens().then(
      (answer) => setTokens(answer.tokens),
      (caught: unknown) => {
        setTokens([]);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  }, []);

  useEffect(reload, [reload]);

  const create = useCallback((): void => {
    setBusy(true);
    setError(null);
    createToken(label.trim()).then(
      (answer) => {
        setBusy(false);
        setLabel('');
        setIssued(answer);
        reload();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  }, [label, reload]);

  const revoke = useCallback(
    (id: number): void => {
      setError(null);
      deleteToken(id).then(reload, (caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    },
    [reload],
  );

  return (
    <Dialog
      title="API tokens"
      description="For scripts and for the command line. A token never expires; revoking it stops whatever was using it at once."
      width={560}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className={styles.stack}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {issued ? (
          <SecretOnce
            title={
              <>
                Your new token <strong>{issued.label || 'without a label'}</strong>. It is shown
                this once.
              </>
            }
            value={issued.token}
            hint="Send it as Authorization: Bearer <token>, or as ?token= on a socket or a download."
          />
        ) : null}

        <div className={styles.newRow}>
          <Field
            label="New token"
            htmlFor={`${uid}-label`}
            hint="A label so you know what to revoke later: “nightly report”, “laptop”."
          >
            <TextInput
              id={`${uid}-label`}
              data-autofocus
              placeholder="what it is for"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                create();
              }}
            />
          </Field>
          <Button variant="primary" onClick={create} disabled={busy}>
            {busy ? 'Making…' : 'Make a token'}
          </Button>
        </div>

        {tokens === null ? (
          <p className={styles.empty}>Loading…</p>
        ) : tokens.length === 0 ? (
          <p className={styles.empty}>
            No tokens yet. Your session is what this browser uses; a token is for everything else.
          </p>
        ) : (
          <div>
            {tokens.map((token) => (
              <div className={styles.tokenRow} key={token.id}>
                <span className={styles.tokenLabel}>{token.label || 'Without a label'}</span>
                <span className={styles.tokenMeta} title={formatWhen(token.created)}>
                  {token.last_seen
                    ? `used ${formatRelative(token.last_seen)}`
                    : `made ${formatRelative(token.created)}`}
                </span>
                <Button size="sm" variant="danger" onClick={() => revoke(token.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
