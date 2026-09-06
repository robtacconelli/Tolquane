import type { JSX, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSignInNeeded } from '../hooks/useToken';
import { useAuthStore, useSignInRequired } from '../store/auth';
import { BrandMark } from './BrandMark';
import styles from './LoginGate.module.css';

/**
 * The door in front of the app on a server with users.
 *
 * It answers two questions with the same redirect: nobody is signed in (or the one who
 * is has been told to choose a new password first), and a request has just come back
 * 401, which is a session that has ended while the page was open. Where the reader was
 * travels with them in the route state, so `/login` can put them back.
 *
 * On a `local` server, and on a `--token` one before its token has been given, this is
 * not in the way at all: the mode says so and nothing is asked.
 */
export function LoginGate({ children }: { children: ReactNode }): JSX.Element | null {
  const location = useLocation();
  const status = useAuthStore((state) => state.status);
  const required = useSignInRequired();
  const refused = useSignInNeeded();

  // One paint of somebody else's workspace is one too many: nothing is drawn until the
  // server has said whether it wants a sign-in. It is one request to the same machine,
  // with its own short deadline, so this is a frame -- and after four hundred
  // milliseconds, on a server that is thinking about it, the mark says the app is there.
  if (status === 'loading') {
    return (
      <div className={styles.booting}>
        <BrandMark size={30} />
      </div>
    );
  }

  if (required || refused) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <>{children}</>;
}
