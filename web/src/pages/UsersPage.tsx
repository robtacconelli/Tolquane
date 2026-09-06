import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import type { Role, User } from '../api/auth';
import { ApiError } from '../api/client';
import { createUser, deleteUser, listUsers, updateUser } from '../api/users';
import { SecretOnce } from '../components/AccountSecret';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { ListColumns, Page, PageHeader, Panel, PanelHeader } from '../components/Page';
import { formatRelative, formatWhen } from '../components/scheduleFormat';
import { Badge, Field, Select, TextInput, Toggle } from '../components/form/Controls';
import { ConfirmDialog, Dialog } from '../components/form/Dialog';
import { loadAuth, useAuthStore } from '../store/auth';
import styles from './Users.module.css';

/**
 * Everybody who can sign in (docs/web-interfaces.md, U). Administrators only.
 *
 * Every rule about who may do what lives on the server -- the last administrator cannot
 * be demoted, disabled or deleted, and nobody deletes themselves -- so this page asks
 * and shows the answer on the row it asked about, rather than greying out controls by a
 * copy of the rules that would drift from them.
 *
 * A password is never chosen here. Making a user, or resetting one, produces a temporary
 * password this browser makes, shows once, and never sends anywhere but to the server
 * that will ask its owner to replace it at their first sign-in.
 */

const COLUMNS = ['Name', 'Role', 'Created', 'Last seen', ''] as const;
const TEMPLATE = 'minmax(0, 2fr) 116px 130px 130px minmax(0, 250px)';

/** No l, 1, O or 0: this is read off a screen and typed by somebody else. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function temporaryPassword(): string {
  const size = 16;
  const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  const values = random ? random(new Uint32Array(size)) : null;
  let out = '';
  for (let index = 0; index < size; index += 1) {
    const pick = values ? (values[index] ?? 0) : Math.floor(Math.random() * ALPHABET.length);
    out += ALPHABET[pick % ALPHABET.length];
  }
  return out;
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function UsersPage(): JSX.Element {
  const me = useAuthStore((state) => state.user);
  const mode = useAuthStore((state) => state.mode);

  const [users, setUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<User | null>(null);
  const [reset, setReset] = useState<{ user: User; password: string } | null>(null);

  /* The list is read again by asking for it again, not by a function that both fetches
   * and sets state from wherever it is called: one place writes `users`, and it is the
   * effect below. */
  const [tick, setTick] = useState(0);
  const reload = useCallback((): void => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const answer = await listUsers();
        if (cancelled) return;
        setUsers(answer.users);
        setLoadError(null);
      } catch (caught) {
        if (cancelled) return;
        setUsers(null);
        setLoadError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const change = useCallback(
    async (user: User, patch: { role?: Role; disabled?: boolean }): Promise<void> => {
      setBusy(user.id);
      setRowError(null);
      try {
        await updateUser(user.id, patch);
        reload();
      } catch (caught) {
        setRowError({ id: user.id, message: messageOf(caught) });
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const resetPassword = useCallback(
    async (user: User): Promise<void> => {
      const password = temporaryPassword();
      setBusy(user.id);
      setRowError(null);
      try {
        await updateUser(user.id, { password });
        setReset({ user, password });
        reload();
      } catch (caught) {
        setRowError({ id: user.id, message: messageOf(caught) });
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!confirming) return;
    const user = confirming;
    setBusy(user.id);
    setRowError(null);
    try {
      await deleteUser(user.id);
      setConfirming(null);
      reload();
    } catch (caught) {
      setRowError({ id: user.id, message: messageOf(caught) });
      setConfirming(null);
    } finally {
      setBusy(null);
    }
  }, [confirming, reload]);

  /* The route guard. A member has no Users item in the sidebar either, so this is for
   * the one who typed the address or followed an old link. */
  if (me && me.role !== 'admin') {
    return (
      <Page>
        <PageHeader title="Users" />
        <Panel>
          <EmptyState
            title="Users is for administrators"
            body={`You are signed in as ${me.name}, a member. An administrator can add people, change roles and reset passwords.`}
            actions={
              <Link to="/flows">
                <Button variant="primary">Back to the flows</Button>
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const forbidden = loadError instanceof ApiError && loadError.status === 403;
  const offline = loadError instanceof ApiError && loadError.isOffline;

  return (
    <Page>
      <PageHeader
        title="Users"
        description="Everybody who can sign in to this server. A new account is given a temporary password and asked to choose its own at the first sign-in."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            Add a user
          </Button>
        }
      />

      {mode === 'local' && users?.length === 0 ? (
        <Notice tone="warning">
          This server has no accounts, so every request from this machine is the administrator{' '}
          <code>local</code>. The moment you add somebody, everybody signs in — including this
          browser.
        </Notice>
      ) : null}

      {loadError ? (
        <Panel>
          <EmptyState
            title={
              offline
                ? 'The server is not running'
                : forbidden
                  ? 'Users is for administrators'
                  : 'The users could not be read'
            }
            body={loadError.message}
            actions={<Button onClick={reload}>Try again</Button>}
          />
        </Panel>
      ) : null}

      {!loadError ? (
        <Panel>
          <PanelHeader
            title="Accounts"
            hint={
              users ? (
                <span className={styles.count}>
                  {users.length} {users.length === 1 ? 'person' : 'people'}
                </span>
              ) : null
            }
          />
          <ListColumns columns={COLUMNS} template={TEMPLATE} />
          {users === null ? (
            <p className={styles.loading}>Loading…</p>
          ) : users.length === 0 ? (
            <EmptyState
              title="Nobody signs in yet"
              body="Add the first person and this server starts asking for a name and a password."
              actions={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add a user
                </Button>
              }
            />
          ) : (
            users.map((user) => (
              <div
                key={user.id}
                className={user.disabled ? `${styles.row} ${styles.disabled}` : styles.row}
                style={{ gridTemplateColumns: TEMPLATE }}
              >
                <span className={styles.who}>
                  <span className={styles.name}>{user.name}</span>
                  {me?.id === user.id ? <Badge tone="accent">you</Badge> : null}
                  {user.disabled ? <Badge tone="danger">disabled</Badge> : null}
                  {user.must_change_password ? <Badge>must change password</Badge> : null}
                </span>
                <Select
                  aria-label={`Role for ${user.name}`}
                  value={user.role}
                  disabled={busy === user.id}
                  onChange={(event) => void change(user, { role: event.target.value as Role })}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </Select>
                <span className={styles.when} title={formatWhen(user.created)}>
                  {formatRelative(user.created) || '—'}
                </span>
                <span className={styles.when} title={formatWhen(user.last_seen)}>
                  {user.last_seen ? formatRelative(user.last_seen) : 'never'}
                </span>
                <span className={styles.actions}>
                  <Toggle
                    checked={!user.disabled}
                    disabled={busy === user.id}
                    label={user.disabled ? `Enable ${user.name}` : `Disable ${user.name}`}
                    onChange={(enabled) => void change(user, { disabled: !enabled })}
                  />
                  <Button
                    size="sm"
                    disabled={busy === user.id}
                    onClick={() => void resetPassword(user)}
                  >
                    Reset password
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`Delete ${user.name}`}
                    disabled={busy === user.id}
                    onClick={() => setConfirming(user)}
                  >
                    <Icon name="trash" size={15} />
                  </Button>
                </span>
                {rowError?.id === user.id ? (
                  <div className={styles.rowError}>
                    <Notice tone="error" onDismiss={() => setRowError(null)}>
                      {rowError.message}
                    </Notice>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </Panel>
      ) : null}

      {adding ? (
        <AddUserDialog
          onClose={() => {
            setAdding(false);
            /* On a server that had no accounts, the first one turns signing in on for
             * everybody, this browser included. Ask who we are again -- once the
             * temporary password has been read, not while it is still on screen. */
            if (mode === 'local') void loadAuth();
          }}
          onAdded={reload}
        />
      ) : null}

      {reset ? (
        <Dialog
          title={`A new password for ${reset.user.name}`}
          onClose={() => setReset(null)}
          width={520}
          footer={
            <Button variant="primary" onClick={() => setReset(null)} data-autofocus>
              Done
            </Button>
          }
        >
          <SecretOnce
            title="Give them this. It is shown once."
            value={reset.password}
            hint="They will be asked to choose their own the next time they sign in, and every session they had is still theirs."
          />
        </Dialog>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Delete ${confirming.name}?`}
          body={
            <>
              Everything <strong>{confirming.name}</strong> ran stays in the history; their sessions
              and API tokens stop working at once. This cannot be undone.
            </>
          }
          confirmLabel="Delete the user"
          busy={busy === confirming.id}
          onConfirm={() => void remove()}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </Page>
  );
}

/* --------------------------------------------------------------------- adding one */

function AddUserDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const uid = useId();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ user: User; password: string } | null>(null);

  const submit = useCallback((): void => {
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
      setError('A user needs a name.');
      return;
    }
    const password = temporaryPassword();
    setBusy(true);
    setError(null);
    createUser({ name: wanted, role, password }).then(
      (user) => {
        setBusy(false);
        setMade({ user, password });
        onAdded();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(messageOf(caught));
      },
    );
  }, [name, onAdded, role]);

  return (
    <Dialog
      title={made ? `${made.user.name} can sign in` : 'Add a user'}
      description={
        made
          ? undefined
          : 'Tolquane makes the first password: give it to them, and they choose their own the first time they sign in.'
      }
      width={520}
      onClose={onClose}
      footer={
        made ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy}>
              {busy ? 'Adding…' : 'Add the user'}
            </Button>
          </>
        )
      }
    >
      {made ? (
        <SecretOnce
          title={
            <>
              The temporary password for <strong>{made.user.name}</strong>. It is shown once.
            </>
          }
          value={made.password}
          hint="They will be asked to choose their own at their first sign-in."
        />
      ) : (
        <div className={styles.stack}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field
            label="Name"
            htmlFor={`${uid}-name`}
            hint="Two to thirty-two characters: lower-case letters, digits, and “_”, “.” or “-”."
          >
            <TextInput
              id={`${uid}-name`}
              data-autofocus
              autoCapitalize="none"
              spellCheck={false}
              placeholder="alice"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                submit();
              }}
            />
          </Field>
          <Field
            label="Role"
            htmlFor={`${uid}-role`}
            hint="A member has the flows, the runs, the schedules and the AI builder. An administrator also has users, settings and the keys."
          >
            <Select
              id={`${uid}-role`}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
