import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { port, python, REPO_DIR, RUN_DIR } from './harness';

/*
 * Two more servers, for the two kinds that ask who you are.
 *
 * The shared suite runs against a `tolquane web` in local mode -- no accounts, no login,
 * the app as it has always been -- and that is the one every other spec needs. The users
 * feature needs the other two: a server with accounts (`users.spec.ts`), and a server
 * started with `--token` and no accounts yet (`auth.spec.ts`, where the first
 * administrator is made).
 *
 * Neither needs a `vite preview` of its own: `tolquane web` serves the built frontend
 * itself, from the same `src/tolquane/web/static` the preview serves, so pointing a
 * browser straight at the Python server is both lighter and closer to the wheel. The
 * build that fills that directory is the shared suite's own web server, which Playwright
 * starts and waits for before these two.
 *
 * Everything here is written from scratch on every run, next to the shared workspace and
 * thrown away with it.
 */

/** The server with accounts: alice signs in as an administrator, bob as a member. */
export const USERS_HOME = join(RUN_DIR, 'users-home');
export const USERS_WS = join(RUN_DIR, 'users-ws');
export const USERS_PORT = port('TOLQUANE_USERS_PORT');
export const USERS_URL = `http://127.0.0.1:${String(USERS_PORT)}`;

/** The `--token` server: no accounts yet, so the first administrator can be made. */
export const TOKEN_HOME = join(RUN_DIR, 'token-home');
export const TOKEN_WS = join(RUN_DIR, 'token-ws');
export const TOKEN_PORT = port('TOLQUANE_TOKEN_PORT');
export const TOKEN_URL = `http://127.0.0.1:${String(TOKEN_PORT)}`;
/** What that server is started with, and what the login page asks to be given. */
export const SERVER_TOKEN = 'e2e-server-token-3f9a';

export const ALICE = { name: 'alice', password: 'alicepass1', role: 'admin' } as const;
export const BOB = { name: 'bob', password: 'bobpass123', role: 'member' } as const;

const HELLO = `"""Say hello to three names."""

import tolquane as tq


@tq.source
def names():
    yield from ["ada", "grace", "alan"]


@tq.sink
def greet(name: str) -> None:
    print(f"hello {name}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else names
    return start >> greet


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

function addUser(home: string, name: string, password: string, admin: boolean): void {
  const args = ['-m', 'tolquane', 'web', 'users', 'add', name, '--password', password];
  if (admin) args.push('--admin');
  execFileSync(python(), args, {
    cwd: REPO_DIR,
    env: { ...process.env, TOLQUANE_HOME: home },
    stdio: 'ignore',
  });
}

/**
 * Write both workspaces and make the two accounts, before either server is started.
 *
 * `tolquane web users add` works straight on the database with no server running, which
 * is exactly what a fresh machine does, and it means the suite never has to bootstrap
 * itself through a route that needs an administrator to already exist.
 */
export function seedUsersWorkspaces(): void {
  if (process.env.TOLQUANE_E2E_USERS_SEEDED === '1') return;
  process.env.TOLQUANE_E2E_USERS_SEEDED = '1';
  for (const [home, workspace] of [
    [USERS_HOME, USERS_WS],
    [TOKEN_HOME, TOKEN_WS],
  ]) {
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'hello.py'), HELLO, 'utf8');
  }
  addUser(USERS_HOME, ALICE.name, ALICE.password, true);
  addUser(USERS_HOME, BOB.name, BOB.password, false);
}
