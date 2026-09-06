import { create } from 'zustand';
import {
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  setup as setupRequest,
  type AuthMode,
  type LoginResult,
  type User,
} from '../api/auth';
import { ApiError } from '../api/client';
import { setApiToken, setServerMode } from '../api/token';

/**
 * Who is signed in, and what kind of server this is.
 *
 * One question answers both: `GET /api/auth/me` (docs/web-interfaces.md, U). It is asked
 * once when the app starts and again whenever the token changes -- after a sign-in, after
 * a sign-out, after the token dialog accepts a `--token`. Everything else in the app
 * reads the answer from here rather than asking again.
 *
 * The three modes are not three products. `local` is the app as it has always been: no
 * login, every request the implicit admin `local`. `users` needs a session. `token` is a
 * server started with `--token`, where `me` itself is behind the token, so the mode
 * arrives only after the token dialog has been answered; until then it is `null`, and
 * `api/token.ts` treats `null` and `token` the same way.
 */

export type AuthStatus =
  /** `me` has not answered yet. */
  | 'loading'
  /** `me` answered: `mode` and `user` are what the server says. */
  | 'ready'
  /** The server could not be reached at all; the shell's own banner says so. */
  | 'unreachable';

const MODES: readonly AuthMode[] = ['local', 'users', 'token'];

/** The server's mode, or null when the answer did not carry one we know. */
function modeOf(value: unknown): AuthMode | null {
  return MODES.includes(value as AuthMode) ? (value as AuthMode) : null;
}

export interface AuthState {
  status: AuthStatus;
  mode: AuthMode | null;
  user: User | null;
  /** `token` mode with no users yet: the login page offers to make the first admin. */
  canSetup: boolean;
  /** Why `me` could not be read, when it could not. */
  error: string | null;
  /** Ask `me` again. Called at start-up and on every token change. */
  load: () => Promise<void>;
  signIn: (name: string, password: string) => Promise<User>;
  /** `token` mode only: make the first administrator and be signed in as them. */
  createFirstAdmin: (name: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  mode: null,
  user: null,
  canSetup: false,
  error: null,

  load: async () => {
    try {
      const answer = await getMe();
      const mode = modeOf(answer.mode);
      setServerMode(mode);
      set({
        status: 'ready',
        mode,
        user: answer.user ?? null,
        canSetup: answer.can_setup === true,
        error: null,
      });
    } catch (caught) {
      const offline = caught instanceof ApiError && caught.isOffline;
      // A 401 on `me` is a `--token` server keeping its own door shut: the mode is
      // unknown, the token dialog is the answer, and nothing here can say more.
      setServerMode(null);
      set({
        status: offline ? 'unreachable' : 'ready',
        mode: null,
        user: null,
        canSetup: false,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  },

  signIn: async (name, password) => accept(set, await loginRequest(name, password)),

  createFirstAdmin: async (name, password) => accept(set, await setupRequest(name, password)),

  signOut: async () => {
    try {
      await logoutRequest();
    } catch {
      // The session was already gone, or the server is not there. Either way this
      // browser is done with the token, and keeping a dead one helps nobody.
    }
    set({ user: null, canSetup: false });
    // Bumps the token generation, which remounts the page and restarts the health poll.
    setApiToken(null);
    void get().load();
  },
}));

/** A session that has just been issued: keep the token, and we are in `users` mode. */
function accept(set: (partial: Partial<AuthState>) => void, result: LoginResult): User {
  setServerMode('users');
  setApiToken(result.token);
  set({ status: 'ready', mode: 'users', user: result.user, canSetup: false, error: null });
  return result.user;
}

/* ------------------------------------------------------------------- the helpers */

/** The signed-in user's role is `admin`. In `local` and `token` mode, it is. */
export function isAdmin(): boolean {
  return useAuthStore.getState().user?.role === 'admin';
}

/** What kind of server this is, or `null` before `me` has answered. */
export function mode(): AuthMode | null {
  return useAuthStore.getState().mode;
}

/** Ask `me`. The app calls this at start-up and after every token change. */
export function loadAuth(): Promise<void> {
  return useAuthStore.getState().load();
}

export function useIsAdmin(): boolean {
  return useAuthStore((state) => state.user?.role === 'admin');
}

export function useAuthUser(): User | null {
  return useAuthStore((state) => state.user);
}

export function useAuthMode(): AuthMode | null {
  return useAuthStore((state) => state.mode);
}

/**
 * True when this server wants somebody signed in and nobody is -- or the one who is has
 * been told to choose a new password before going any further.
 */
export function useSignInRequired(): boolean {
  return useAuthStore(
    (state) =>
      state.mode === 'users' && (state.user === null || state.user.must_change_password === true),
  );
}
