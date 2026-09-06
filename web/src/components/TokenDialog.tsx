import { useCallback, useId, useState, type JSX } from 'react';
import { ApiError, health } from '../api/client';
import { clearUnauthorized, setApiToken } from '../api/token';
import { useUnauthorized } from '../hooks/useToken';
import { Button } from './Button';
import { Field, TextInput } from './form/Controls';
import { Dialog } from './form/Dialog';

/*
 * The one thing a local app can still ask for: the token of a server started with
 * `--token`. There is no login and no account -- the token is a string the person who
 * started the server already has -- so this is a single field, tried against
 * `/api/health` before it is kept, and nothing at all on the usual loopback server.
 */

export function TokenDialog(): JSX.Element | null {
  const needed = useUnauthorized();
  const fieldId = useId();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback((): void => {
    const value = token.trim();
    if (!value) {
      setError('Paste the token the server was started with.');
      return;
    }
    setBusy(true);
    setError(null);
    // Tried with the header set by hand: a token is only kept once it has worked, so a
    // typo never leaves the app locked out of a server it could otherwise reach.
    health({ headers: { Authorization: `Bearer ${value}` } }).then(
      () => {
        setBusy(false);
        setToken('');
        setApiToken(value);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(
          caught instanceof ApiError && caught.status === 401
            ? 'The server refused that token.'
            : caught instanceof Error
              ? caught.message
              : 'The token could not be checked',
        );
      },
    );
  }, [token]);

  if (!needed) return null;

  return (
    <Dialog
      title="This server wants a token"
      description={
        <>
          It was started with <code>tolquane web --token …</code>. Paste that token to carry on; it
          is kept in this browser only.
        </>
      }
      width={460}
      onClose={clearUnauthorized}
      footer={
        <>
          {error ? (
            <span role="alert" style={{ marginRight: 'auto' }}>
              {error}
            </span>
          ) : null}
          <Button onClick={clearUnauthorized} disabled={busy}>
            Not now
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Checking…' : 'Unlock'}
          </Button>
        </>
      }
    >
      <Field
        label="Server token"
        htmlFor={fieldId}
        hint="The same string as --token. Change it later in Settings, under Server."
      >
        <TextInput
          id={fieldId}
          data-autofocus
          type="password"
          mono
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste the token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
      </Field>
    </Dialog>
  );
}
