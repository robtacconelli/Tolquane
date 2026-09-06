import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { AccountPasswordDialog } from './AccountPasswordDialog';
import { AccountTokensDialog } from './AccountTokensDialog';
import { Icon } from './Icon';
import styles from './Account.module.css';

/**
 * Who you are, at the foot of the sidebar, and the three things you can do about it.
 *
 * The two synthetic users of docs/web-interfaces.md, U -- `local` on a loopback server
 * with no accounts, and `token` for the `--token` value -- are not people: they have no
 * password to change and no tokens of their own (the server answers 400 to both), so
 * `local` is a line of text with no menu at all, and `token` gets the one thing it can
 * do, which is to make the first real administrator.
 */

type Dialog = 'password' | 'tokens' | null;

export function AccountMenu({ collapsed }: { collapsed: boolean }): JSX.Element | null {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const mode = useAuthStore((state) => state.mode);
  const canSetup = useAuthStore((state) => state.canSetup);
  const signOut = useAuthStore((state) => state.signOut);

  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent): void {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = useCallback(() => setDialog(null), []);

  // Nothing is known about the caller: a server that has not answered, or one whose
  // token this browser has not been given. The status dot below already says so.
  if (!user) return null;

  const person = user.id !== 0;
  const setupOnly = !person && mode === 'token' && canSetup;
  const label = person ? `${user.name}, ${user.role}` : user.name;

  const row = (
    <>
      <span className={styles.avatar} aria-hidden="true">
        {user.name.slice(0, 1)}
      </span>
      <span className={styles.who}>
        <span className={styles.name}>{user.name}</span>
        <span className={styles.role}>
          {person ? user.role : mode === 'local' ? 'no sign-in on this server' : 'the server token'}
        </span>
      </span>
    </>
  );

  return (
    <div className={styles.account} data-collapsed={collapsed} ref={root}>
      {person || setupOnly ? (
        <button
          type="button"
          className={styles.row}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Account: ${label}`}
          title={collapsed ? label : undefined}
          onClick={() => setOpen((was) => !was)}
        >
          {row}
          <span className={styles.caret}>
            <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} />
          </span>
        </button>
      ) : (
        <div className={styles.row} title={label}>
          {row}
        </div>
      )}

      {open ? (
        <div className={styles.menu} role="menu" aria-label="Account">
          <div className={styles.menuHead}>
            <div className={styles.menuName}>{user.name}</div>
            <div className={styles.menuRole}>
              {person
                ? user.role === 'admin'
                  ? 'Administrator'
                  : 'Member'
                : 'Signed in with the server token'}
            </div>
          </div>
          {person ? (
            <>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => {
                  setOpen(false);
                  setDialog('password');
                }}
              >
                <Icon name="pencil" size={15} />
                Change password…
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => {
                  setOpen(false);
                  setDialog('tokens');
                }}
              >
                <Icon name="key" size={15} />
                API tokens…
              </button>
              <div className={styles.separator} />
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => {
                  setOpen(false);
                  void signOut();
                }}
              >
                <Icon name="signOut" size={15} />
                Sign out
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                void navigate('/login');
              }}
            >
              <Icon name="users" size={15} />
              Create the first administrator…
            </button>
          )}
        </div>
      ) : null}

      {dialog === 'password' ? <AccountPasswordDialog onClose={close} /> : null}
      {dialog === 'tokens' ? <AccountTokensDialog onClose={close} /> : null}
    </div>
  );
}
