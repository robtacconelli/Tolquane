import { useCallback, useId, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, health } from '../api/client';
import { changePassword } from '../api/auth';
import { setApiToken } from '../api/token';
import { BrandMark } from '../components/BrandMark';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { Field, TextInput } from '../components/form/Controls';
import { loadAuth, useAuthStore } from '../store/auth';
import styles from './Login.module.css';

/**
 * The way in, at `/login`: one card, centred, on a page with nothing else on it.
 *
 * It has four faces and the server chooses which one, so the reader never picks:
 *
 *  - **Sign in**, the ordinary one, on a server that has users.
 *  - **Choose a new password**, when the account was made for somebody by an
 *    administrator or by `tolquane web users add`: the server sets `must_change_password`
 *    and nothing else opens until it is done.
 *  - **Create the first administrator**, on a `--token` server that has no users yet.
 *  - **The server token**, before that: a `--token` server will not even say who you are
 *    without it, so the first thing this page can offer is the field to paste it into.
 *
 * Where the reader was going is in the route state, and they are put back there
 * afterwards rather than at the top of the app.
 */

const MIN_PASSWORD = 8;

/** The server's own message when it has one: they already say what to do about it. */
function messageOf(caught: unknown): string {
  if (caught instanceof ApiError && caught.isOffline)
    return 'The Tolquane server is not answering.';
  return caught instanceof Error ? caught.message : String(caught);
}

export function LoginPage(): JSX.Element {
  const location = useLocation();
  /* The password just used, so the forced change does not ask for it twice. It never
   * leaves this component; after a reload the field is simply there again. */
  const [justUsed, setJustUsed] = useState('');
  const status = useAuthStore((state) => state.status);
  const mode = useAuthStore((state) => state.mode);
  const user = useAuthStore((state) => state.user);
  const canSetup = useAuthStore((state) => state.canSetup);

  const state = location.state as { from?: string } | null;
  const from = state?.from && !state.from.startsWith('/login') ? state.from : '/flows';

  /* In the order the server settles it. A local server has nothing to sign in to. A
   * password the server has asked to be replaced comes before everything, including
   * being signed in. Then the first administrator, which is the one thing to do on a
   * `--token` server -- and its `token` user is not somebody who is signed in, it is the
   * key in the door, so it does not send anybody away. Then the two ordinary cases. */
  if (status === 'loading') return <div className={styles.screen} />;
  if (mode === 'local') return <Navigate to={from} replace />;

  if (user?.must_change_password) {
    return (
      <Shell>
        <ChangeForm justUsed={justUsed} />
      </Shell>
    );
  }
  if (mode === 'token' && canSetup) {
    return (
      <Shell>
        <SetupForm />
      </Shell>
    );
  }
  if (user) return <Navigate to={from} replace />;
  if (mode === null) {
    return (
      <Shell>
        <TokenForm offline={status === 'unreachable'} />
      </Shell>
    );
  }
  return (
    <Shell>
      <SignInForm onSignedIn={setJustUsed} />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <BrandMark size={26} />
          <span className={styles.wordmark}>Tolquane</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  error,
  onSubmit,
  children,
  action,
  busy,
  foot,
}: {
  title: string;
  subtitle: ReactNode;
  error: string | null;
  onSubmit: () => void;
  children: ReactNode;
  action: string;
  busy: boolean;
  foot?: ReactNode;
}): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <>
      <form className={styles.panel} onSubmit={submit} noValidate>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={styles.form}>{children}</div>
        <Button type="submit" variant="primary" size="lg" className={styles.submit} disabled={busy}>
          {busy ? 'Working…' : action}
        </Button>
      </form>
      {foot ? <div className={styles.foot}>{foot}</div> : null}
    </>
  );
}

/* ------------------------------------------------------------------- signing in */

function SignInForm({ onSignedIn }: { onSignedIn: (password: string) => void }): JSX.Element {
  const uid = useId();
  const signIn = useAuthStore((state) => state.signIn);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback((): void => {
    if (!name.trim() || !password) {
      setError('Both a name and a password, please.');
      return;
    }
    setBusy(true);
    setError(null);
    signIn(name.trim().toLowerCase(), password).then(
      () => {
        // The store holds the session now; the page redirects itself, unless the server
        // asked for a new password, in which case the one just used is the current one.
        onSignedIn(password);
      },
      (caught: unknown) => {
        setBusy(false);
        setPassword('');
        setError(messageOf(caught));
      },
    );
  }, [name, onSignedIn, password, signIn]);
  const note = useAuthStore((state) => state.note);

  return (
    <Card
      title="Sign in"
      subtitle={
        note ??
        'This Tolquane server has accounts. Yours was made by an administrator, or at the command line.'
      }
      error={error}
      onSubmit={submit}
      action="Sign in"
      busy={busy}
      foot={
        <span>
          Forgotten it? An administrator can set a new one with{' '}
          <code>tolquane web users passwd</code>.
        </span>
      }
    >
      <Field label="Name" htmlFor={`${uid}-name`}>
        <TextInput
          id={`${uid}-name`}
          data-autofocus
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="alice"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Password" htmlFor={`${uid}-password`}>
        <TextInput
          id={`${uid}-password`}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
    </Card>
  );
}

/* --------------------------------------------------- the forced password change */

function ChangeForm({ justUsed }: { justUsed: string }): JSX.Element {
  const uid = useId();
  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  /* The password just used, when the sign-in happened in this browser a moment ago;
   * after a reload there is none and the reader is asked for it. Read from the prop
   * rather than copied into state at mount: the sign-in that provides it and the render
   * that shows this form happen in the same tick. */
  const [typed, setTyped] = useState('');
  const current = justUsed || typed;
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        // `me` says so afterwards, and the page lets go the moment it does.
        void loadAuth();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(messageOf(caught));
      },
    );
  }, [again, current, next]);

  return (
    <Card
      title="Choose a password"
      subtitle={
        <>
          {user ? <strong>{user.name}</strong> : null}, this account still has the password somebody
          else typed. Pick your own before going on.
        </>
      }
      error={error}
      onSubmit={submit}
      action="Set the password"
      busy={busy}
      foot={
        <button type="button" className={styles.link} onClick={() => void signOut()}>
          Sign in as somebody else
        </button>
      }
    >
      {justUsed ? null : (
        <Field
          label="Current password"
          htmlFor={`${uid}-current`}
          hint="The one the administrator gave you."
        >
          <TextInput
            id={`${uid}-current`}
            type="password"
            autoFocus
            autoComplete="current-password"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
      )}
      <Field
        label="New password"
        htmlFor={`${uid}-new`}
        hint={`At least ${String(MIN_PASSWORD)} characters.`}
      >
        <TextInput
          id={`${uid}-new`}
          type="password"
          autoFocus={justUsed !== ''}
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
        />
      </Field>
    </Card>
  );
}

/* ------------------------------------------------------------ the first administrator */

function SetupForm(): JSX.Element {
  const uid = useId();
  const createFirstAdmin = useAuthStore((state) => state.createFirstAdmin);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback((): void => {
    if (!name.trim()) {
      setError('An administrator needs a name.');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`A password is at least ${String(MIN_PASSWORD)} characters.`);
      return;
    }
    if (password !== again) {
      setError('Those two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    createFirstAdmin(name.trim().toLowerCase(), password).then(
      () => {
        /* Signed in as the new administrator; the page redirects itself. */
      },
      (caught: unknown) => {
        setBusy(false);
        setError(messageOf(caught));
      },
    );
  }, [again, createFirstAdmin, name, password]);

  return (
    <Card
      title="Create the first administrator"
      subtitle="This server was started with a token and has no accounts yet. The first one is an administrator, and from then on everybody signs in."
      error={error}
      onSubmit={submit}
      action="Create the administrator"
      busy={busy}
      foot={
        <span>
          The token keeps working afterwards, for scripts: <code>tolquane web --token …</code>
        </span>
      }
    >
      <Field
        label="Name"
        htmlFor={`${uid}-name`}
        hint="Lower-case letters, digits, and “_”, “.” or “-”."
      >
        <TextInput
          id={`${uid}-name`}
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="alice"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Password"
        htmlFor={`${uid}-password`}
        hint={`At least ${String(MIN_PASSWORD)} characters.`}
      >
        <TextInput
          id={`${uid}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label="Password again" htmlFor={`${uid}-again`}>
        <TextInput
          id={`${uid}-again`}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
        />
      </Field>
    </Card>
  );
}

/* ------------------------------------------------------------------- the server token */

function TokenForm({ offline }: { offline: boolean }): JSX.Element {
  const uid = useId();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback((): void => {
    const value = token.trim();
    if (!value) {
      setError('Paste the token the server was started with.');
      return;
    }
    setBusy(true);
    setError(null);
    // Tried with the header set by hand: a token is kept only once it has worked, so a
    // typo never leaves the app locked out of a server it could otherwise reach.
    health({ headers: { Authorization: `Bearer ${value}` } }).then(
      () => {
        setToken('');
        setApiToken(value);
        void loadAuth();
      },
      (caught: unknown) => {
        setBusy(false);
        setError(
          caught instanceof ApiError && caught.status === 401
            ? 'The server refused that token.'
            : messageOf(caught),
        );
      },
    );
  }, [token]);

  return (
    <Card
      title={offline ? 'The server is not answering' : 'This server wants a token'}
      subtitle={
        offline ? (
          <>
            Start it with <code>tolquane web</code>, then try again.
          </>
        ) : (
          <>
            It was started with <code>tolquane web --token …</code>. Paste that token; it is kept in
            this browser only.
          </>
        )
      }
      error={error}
      onSubmit={submit}
      action="Unlock"
      busy={busy}
    >
      <Field label="Server token" htmlFor={`${uid}-token`}>
        <TextInput
          id={`${uid}-token`}
          type="password"
          mono
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste the token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
    </Card>
  );
}
