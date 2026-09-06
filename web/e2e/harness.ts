import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Everything `npm run e2e` needs before a browser opens.
 *
 * The suite is self-contained: one command starts a real `tolquane web` on a workspace
 * this file writes from scratch, and a `vite preview` whose /api proxy points at it. No
 * spec mocks the server except the two that are about not having one, and none of them
 * skip. The workspace is thrown away and written again on every run, so a journey that
 * creates, renames or deletes a flow -- or leaves a run in the history -- starts from the
 * same place every time.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `web/`, the directory the Vite project and `playwright.config.ts` live in. */
export const WEB_DIR = resolve(HERE, '..');
/** The repository root: the Python side, its virtualenv and the example flows. */
export const REPO_DIR = resolve(WEB_DIR, '..');

/** Everything this run writes, gitignored and rewritten on every run. */
export const RUN_DIR = join(HERE, '.workspace');
/** `TOLQUANE_HOME`: the server's database and settings, away from the real ones. */
export const HOME_DIR = join(RUN_DIR, 'home');
/** The workspace the server serves: the flow files below. */
export const WS_DIR = join(RUN_DIR, 'ws');
/** The gallery the specs shoot into, emptied with the workspace so nothing is stale. */
export const SHOTS_DIR = join(HERE, 'screenshots');

const FREE_PORT = `
const server = require('net').createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
`;

/**
 * A free port, picked once and remembered in `variable`.
 *
 * Playwright loads this config again in every worker process, and a port picked twice is
 * two different ports; the workers inherit the environment the first evaluation wrote, so
 * the answer is the same everywhere. Setting the variable by hand pins it.
 */
export function port(variable: string): number {
  const already = process.env[variable];
  if (already !== undefined && already !== '') return Number(already);
  const found = execFileSync(process.execPath, ['-e', FREE_PORT], { encoding: 'utf8' }).trim();
  process.env[variable] = found;
  return Number(found);
}

/** The Python server behind `/api`. */
export const API_PORT = port('TOLQUANE_API_PORT');
/** The built frontend, served by `vite preview`; the suite's `baseURL`. */
export const PREVIEW_PORT = port('TOLQUANE_PREVIEW_PORT');

// --------------------------------------------------------------- the flows

/** A flow slow enough to be watched while it runs, and cancelled halfway. */
const SLOW = `"""Square numbers slowly, so a run can be watched while it happens."""

import time

import tolquane as tq

COUNT = 40
PAUSE = 0.08


@tq.source
def numbers():
    # Slow on purpose: the run has to last long enough to watch and to cancel.
    for n in range(1, COUNT + 1):
        time.sleep(PAUSE)
        yield n


@tq.node
def square(n: int) -> int:
    # A little work per item, so the farm has some busy time to report.
    time.sleep(PAUSE)
    return n * n


@tq.sink
def show(n: int) -> None:
    print(f"squared {n}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else numbers
    return start >> tq.farm(square, 4, ordered=True) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

/** A flow that raises on the third item, so a failure lands on the card that raised it. */
const BOOM = `"""Fail on the third item, so the error lands on the card that raised it."""

import tolquane as tq


@tq.source
def numbers():
    yield from range(1, 8)


@tq.node
def check(n: int) -> int:
    # The third item is the one this flow cannot handle.
    if n == 3:
        raise ValueError("cannot handle 3")
    return n


@tq.sink
def show(n: int) -> None:
    print(n)


def build(source=None):
    start = tq.from_iterable(source) if source is not None else numbers
    return start >> tq.farm(check, 2) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

/** A loop that grows every round: the run ends in a deadlock report, not a hang. */
const STUCK = `"""A loop that never drains: every round puts back twice what it took out."""

import tolquane as tq


@tq.source
def one():
    yield 1


@tq.node
def hold(x: int, ctx: tq.Context) -> None:
    # Two items back into the loop for every one that arrives, so it can never end.
    ctx.feedback(x)
    ctx.feedback(x)


@tq.sink
def show(x: int) -> None:
    print(x)


def build(source=None):
    start = tq.from_iterable(source) if source is not None else one
    return start >> tq.feedback(hold) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

/** A flow whose `build()` takes parameters, and whose sink reads a variable. */
const PARAMS = `"""Scale numbers by a factor and label them; both are parameters of build()."""

import os

import tolquane as tq


@tq.source
def numbers():
    # Five numbers is enough to read the whole run in the console pane.
    yield from range(1, 6)


class Scale:
    # Stateful only in its settings: build() hands it the parameters it was called with.
    def __init__(self, factor: int, label: str) -> None:
        self.factor = factor
        self.label = label

    def __call__(self, n: int) -> str:
        return f"{self.label}{n * self.factor}"


@tq.sink
def show(line: str) -> None:
    print(f"{line} for {os.environ.get('GREETING', 'nobody')}")


def build(source=None, *, factor: int = 2, label: str = "x", loud: bool = False):
    start = tq.from_iterable(source) if source is not None else numbers
    return start >> tq.node(Scale(factor, label.upper() if loud else label)) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

/** A flow that imports a module nobody has: the probe has something to say about it. */
const MISSING = `"""Read frames with OpenCV, which this interpreter does not have."""

import cv2

import tolquane as tq


@tq.source
def frames():
    yield from range(3)


@tq.sink
def show(n: int) -> None:
    print(cv2.__name__, n)


def build(source=None):
    start = tq.from_iterable(source) if source is not None else frames
    return start >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

/** `word_count.py`, reading the text file beside it rather than a string in the file. */
const WORD_COUNT = `"""Count words in a text file: split lines in parallel, count per word on a keyed farm."""

from pathlib import Path

import tolquane as tq

TEXT = Path(__file__).with_name("words.txt")


@tq.source
def lines():
    # One line per item; the text file travels with the flow.
    with TEXT.open() as handle:
        for line in handle:
            yield line.rstrip("\\n")


@tq.node
def words(line: str):
    # Zero or many outputs per input: yield instead of return.
    for w in line.split():
        yield w.lower()


class Count:
    # Stateful, so it is a class: one instance per worker, and key= sends every
    # occurrence of a word to the same worker, so each count is complete.
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def __call__(self, word: str) -> object:
        self.counts[word] = self.counts.get(word, 0) + 1
        return tq.SKIP  # nothing per word; totals go out at the end

    def on_end(self, ctx: tq.Context) -> None:
        for word, n in self.counts.items():
            ctx.send((word, n))


@tq.sink
def show(pair: tuple[str, int]) -> None:
    word, n = pair
    print(f"{word:>8} {n}")


def build(source=None):
    start = tq.from_iterable(source) if source is not None else lines
    return start >> tq.farm(words, 2) >> tq.farm(Count, 3, key=lambda w: w) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
`;

const WORDS_TXT = `the quick brown fox jumps over the lazy dog
the dog sleeps and the fox runs
a quick brown dog and a lazy fox
the fox and the dog are friends
`;

/** Written verbatim; the key is the path inside the workspace. */
const WRITTEN: Record<string, string> = {
  'word_count.py': WORD_COUNT,
  'words.txt': WORDS_TXT,
  'slow.py': SLOW,
  'boom.py': BOOM,
  'stuck.py': STUCK,
  'params.py': PARAMS,
  'missing.py': MISSING,
};

/** Copied out of the repository, so the suite runs against the real examples. */
const COPIED: Record<string, string> = {
  'hello.py': 'examples/hello.py',
  // Two of the flows the AI builder wrote, one of them in a folder, for the breadcrumbs.
  'moving_average.py': 'examples/generated/moving_average/flow.py',
  'reports/word_frequency.py': 'examples/generated/word_frequency/flow.py',
  // A flow the model cannot represent: the canvas opens it read-only.
  'som.py': 'examples/som.py',
};

/** The flows every spec can count on, by the path they have in the workspace. */
export const FLOWS = {
  hello: 'hello.py',
  words: 'word_count.py',
  slow: 'slow.py',
  boom: 'boom.py',
  stuck: 'stuck.py',
  average: 'moving_average.py',
  nested: 'reports/word_frequency.py',
  codeOnly: 'som.py',
  // Section E: a flow with parameters, and one whose import the probe cannot satisfy.
  params: 'params.py',
  missing: 'missing.py',
} as const;

/** How many flows the list starts with; the journeys add and remove around it. */
export const FLOW_COUNT = Object.keys(FLOWS).length;

/**
 * Throw the last run's workspace away and write it again.
 *
 * Called once, while the config is read and before the server is started: the server
 * holds the database open, so the file has to be gone before it opens it. Inside a run
 * the workspace is left alone, so a journey that creates a flow finds it again in the
 * next test and gone in the next run.
 */
export function seedWorkspace(): void {
  if (process.env.TOLQUANE_E2E_SEEDED === '1') return;
  process.env.TOLQUANE_E2E_SEEDED = '1';
  rmSync(RUN_DIR, { recursive: true, force: true });
  rmSync(SHOTS_DIR, { recursive: true, force: true });
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(WS_DIR, { recursive: true });
  for (const [name, text] of Object.entries(WRITTEN)) {
    writeFileSync(join(WS_DIR, name), text, 'utf8');
  }
  for (const [name, from] of Object.entries(COPIED)) {
    const target = join(WS_DIR, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPO_DIR, from), target);
  }
  seedRepository();
}

/**
 * Make the workspace a git repository with one commit, for the history journeys.
 *
 * The History tab (docs/web-interfaces.md, H) is a window onto the workspace's own
 * repository, so the suite needs one: `git init`, the `.gitignore` the server itself
 * writes, and one commit holding every flow above. The identity is given on the command
 * line rather than configured, so a machine with no `user.email` still commits.
 *
 * Called at the end of `seedWorkspace`, inside its once-per-run guard: the repository is
 * part of the workspace, and it is thrown away with it.
 */
export function seedRepository(): void {
  writeFileSync(join(WS_DIR, '.gitignore'), '# Tolquane Web\n.tolquane-web/\n__pycache__/\n');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: WS_DIR, stdio: 'ignore' });
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('add', '-A');
  git(
    '-c',
    'user.name=Tolquane e2e',
    '-c',
    'user.email=e2e@tolquane.local',
    'commit',
    '-q',
    '-m',
    'The flows this suite starts from',
  );
}

/** The interpreter the server runs on: the project virtualenv unless one is named. */
export function python(): string {
  return process.env.TOLQUANE_PYTHON ?? join(REPO_DIR, '.venv', 'bin', 'python');
}
