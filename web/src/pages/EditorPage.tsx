import { lazy, Suspense, useCallback, useEffect, useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { checkFlow, generateSource, getFlow, saveFlow, saveLayout } from '../api/flows';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Page';
import { StatusDot } from '../components/StatusDot';
import { Palette } from '../editor/Palette';
import { Properties } from '../editor/Properties';
import { locateProblem, type Problem } from '../model';
import { useFlowStore, useProblems } from '../store/flow';
import { useRunStore } from '../store/run';
import styles from './Editor.module.css';

/* The editor page: the toolbar, the canvas (a lazy chunk), the palette over it, the
 * property panel down the right and the drawer under it. The page owns the requests --
 * the store never talks to the server -- and it owns the keys: save, undo, redo. */

const Canvas = lazy(() => import('../editor/Canvas'));

const VIEWS = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'code', label: 'Code' },
] as const;

const LAYERS = [
  { value: 'blocks', label: 'Blocks' },
  { value: 'threads', label: 'Threads' },
] as const;

const TABS = ['Console', 'Taps', 'Report', 'Problems'] as const;
type Tab = (typeof TABS)[number];

interface Notice {
  tone: 'info' | 'error' | 'success';
  text: string;
}

export function EditorPage(): JSX.Element {
  const params = useParams<{ '*': string }>();
  const path = params['*'] ?? '';

  const flowPath = useFlowStore((state) => state.path);
  const model = useFlowStore((state) => state.model);
  const source = useFlowStore((state) => state.source);
  const codeOnly = useFlowStore((state) => state.codeOnly);
  const dirty = useFlowStore((state) => state.dirty);
  const layoutDirty = useFlowStore((state) => state.layoutDirty);
  const view = useFlowStore((state) => state.view);
  const expanded = useFlowStore((state) => state.expanded);
  const problems = useProblems();
  const selected = useFlowStore((state) => state.selected);

  const applyServerFlow = useFlowStore((state) => state.applyServerFlow);
  const setView = useFlowStore((state) => state.setView);
  const setExpanded = useFlowStore((state) => state.setExpanded);
  const setSource = useFlowStore((state) => state.setSource);
  const setServerProblems = useFlowStore((state) => state.setServerProblems);
  const markSaved = useFlowStore((state) => state.markSaved);
  const markLayoutSaved = useFlowStore((state) => state.markLayoutSaved);
  const select = useFlowStore((state) => state.select);
  const undo = useFlowStore((state) => state.undo);
  const redo = useFlowStore((state) => state.redo);

  const runNodes = useRunStore((state) => state.nodes);
  const runEdges = useRunStore((state) => state.edges);

  const [tab, setTab] = useState<Tab>('Console');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'checking'>('idle');

  /* Open the flow named by the route. The store holds one flow at a time, which is what
   * the editor is: one file, one canvas, one undo stack. */
  useEffect(() => {
    if (!path) return;
    let live = true;
    getFlow(path)
      .then((response) => {
        if (live) applyServerFlow(response);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setFailure({
          path,
          message: error instanceof ApiError ? error.message : 'Could not open this flow',
        });
      });
    return () => {
      live = false;
    };
  }, [path, applyServerFlow]);

  // The failure belongs to the path it happened on, so opening another flow clears it
  // without an effect that writes state on the way in.
  const loadError = failure && failure.path === path ? failure.message : null;

  const save = useCallback(async (): Promise<void> => {
    const state = useFlowStore.getState();
    if (!state.path || state.modified === null) return;
    setBusy('saving');
    setNotice(null);
    try {
      let text = state.source;
      if (state.sourceStale && state.model) {
        const generated = await generateSource(state.model);
        text = generated.source;
        setSource(text);
      }
      const saved = await saveFlow(state.path, { source: text, modified: state.modified });
      markSaved({ source: saved.source, modified: saved.modified });
      if (useFlowStore.getState().layoutDirty) {
        await saveLayout(state.path, useFlowStore.getState().layout);
        markLayoutSaved();
      }
      setNotice({ tone: 'success', text: 'Saved' });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setNotice({
          tone: 'error',
          text: 'This file changed on disk since you opened it. Reload it to see the newer version before saving over it.',
        });
      } else {
        setNotice({
          tone: 'error',
          text: error instanceof ApiError ? error.message : 'Could not save this flow',
        });
      }
    } finally {
      setBusy('idle');
    }
  }, [markLayoutSaved, markSaved, setSource]);

  const check = useCallback(async (): Promise<void> => {
    const state = useFlowStore.getState();
    if (!state.path) return;
    setBusy('checking');
    setNotice(null);
    try {
      const result = await checkFlow(state.path);
      setServerProblems([]);
      setNotice({
        tone: 'success',
        text: `The flow is sound: ${String(result.nodes)} nodes, ${String(result.edges)} edges.`,
      });
    } catch (error: unknown) {
      const message = error instanceof ApiError ? error.message : 'The check could not run';
      const found: Problem = {
        path: state.model ? locateProblem(message, state.model) : null,
        message,
        severity: 'error',
        source: 'server',
      };
      setServerProblems([found]);
      setTab('Problems');
    } finally {
      setBusy('idle');
    }
  }, [setServerProblems]);

  // Good news does not need dismissing; a failure stays until it is read.
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void save();
      } else if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, save, undo]);

  const errors = problems.filter((problem) => problem.severity === 'error');
  const opened = flowPath === path && (model !== null || codeOnly !== null);

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <div className={styles.file}>
          <span className={styles.fileName}>{path || 'untitled.py'}</span>
          <span className={styles.fileState}>
            {loadError
              ? 'not opened'
              : dirty
                ? 'unsaved changes'
                : layoutDirty
                  ? 'layout moved'
                  : opened
                    ? 'saved'
                    : 'opening…'}
          </span>
          {dirty ? <span className={styles.dot} aria-label="Unsaved changes" /> : null}
        </div>
        <span className={styles.divider} />
        <Segmented label="Editor view" options={VIEWS} value={view} onChange={setView} />
        {view === 'canvas' && !codeOnly ? (
          <Segmented
            label="Canvas layer"
            options={LAYERS}
            value={expanded ? 'threads' : 'blocks'}
            onChange={(value) => setExpanded(value === 'threads')}
          />
        ) : null}
        <div className={styles.toolbarSpacer} />
        {import.meta.env.DEV ? <FixturePicker /> : null}
        <Button variant="ghost" size="sm" disabled>
          <Icon name="sparkle" size={15} />
          AI builder
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void check()}
          disabled={!opened || busy !== 'idle'}
        >
          <Icon name="check" size={15} />
          {busy === 'checking' ? 'Checking…' : 'Check'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void save()}
          disabled={!opened || busy !== 'idle'}
        >
          <Icon name="folder" size={15} />
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="primary" size="sm" disabled>
          <Icon name="play" size={15} />
          Run
        </Button>
      </div>

      <div className={styles.notices}>
        {notice ? (
          <div className={styles.notice} data-tone={notice.tone} role="status">
            <Icon name={notice.tone === 'success' ? 'check' : 'alert'} size={14} />
            <span>{notice.text}</span>
            <button
              type="button"
              className={styles.noticeClose}
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ) : null}

        {codeOnly ? (
          <div className={styles.notice} data-tone="warning" role="status">
            <Icon name="alert" size={14} />
            <span>
              This file cannot be modelled, so the canvas is read-only and shows the expanded graph.{' '}
              <span className={styles.reason}>{codeOnly.reason}</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className={styles.stage}>
        {view === 'canvas' && !loadError ? (
          <div className={styles.paletteColumn}>
            <Palette disabled={!model || expanded} />
          </div>
        ) : null}
        {view === 'code' ? (
          <div className={styles.code}>
            <div className={styles.codeHead}>
              <span className={styles.codeTitle}>{path}</span>
              <span className={styles.readOnly}>read-only until the code editor lands</span>
            </div>
            <pre className={styles.codeBody}>{source || '# open a flow to see its code'}</pre>
          </div>
        ) : loadError ? (
          <div className={styles.loadError}>
            <span className={styles.loadGlyph}>
              <Icon name="offline" size={20} />
            </span>
            <p className={styles.loadTitle}>This flow is not open</p>
            <p className={styles.loadBody}>{loadError}</p>
          </div>
        ) : (
          <Suspense fallback={<div className={styles.loading}>Loading the canvas…</div>}>
            <Canvas
              nodeStatus={runNodes}
              edgeStatus={runEdges}
              onEditCode={() => setView('code')}
            />
          </Suspense>
        )}
      </div>

      <aside className={styles.properties}>
        <Properties onEditCode={() => setView('code')} />
      </aside>

      <section className={styles.drawer}>
        <div className={styles.tabs} role="tablist" aria-label="Run output">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === tab}
              className={name === tab ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab(name)}
            >
              {name}
              {name === 'Problems' ? (
                <span
                  className={
                    errors.length > 0 ? `${styles.tabCount} ${styles.tabCountBad}` : styles.tabCount
                  }
                >
                  {problems.length}
                </span>
              ) : name === 'Console' ? null : (
                <span className={styles.tabCount}>0</span>
              )}
            </button>
          ))}
        </div>
        {tab === 'Problems' ? (
          <div className={styles.problems}>
            {problems.length === 0 ? (
              <p className={styles.problemsEmpty}>
                Nothing wrong with this flow. <strong>Check</strong> runs <code>tq.check</code> on
                the server for the last word.
              </p>
            ) : (
              problems.map((problem, index) => (
                <button
                  key={`${problem.message}-${String(index)}`}
                  type="button"
                  className={
                    problem.path === selected
                      ? `${styles.problem} ${styles.problemActive}`
                      : styles.problem
                  }
                  onClick={() => problem.path !== null && select(problem.path)}
                >
                  <StatusDot state={problem.severity === 'error' ? 'failed' : 'waiting'} />
                  <span className={styles.problemText}>{problem.message}</span>
                  <span className={styles.problemWhere}>
                    {problem.source === 'server' ? 'tq.check' : (problem.path ?? 'flow')}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className={styles.console}>
            <span className={styles.prompt}>$</span> tolquane run {path || 'flow.py'} --events
            <br />
            {tab === 'Console'
              ? 'the run panel arrives with F4; the canvas is already wired to its overlay.'
              : `${tab.toLowerCase()} appear here once a run has something to show.`}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Development only: open one of the fixture flows without a server. The import lives
 * inside the `DEV` branch so the fixtures never reach the production bundle.
 */
function FixturePicker(): JSX.Element {
  const applyServerFlow = useFlowStore((state) => state.applyServerFlow);
  const [names, setNames] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    void import('../test/fixtures').then((module) => setNames(module.FIXTURE_NAMES));
  }, []);

  return (
    <select
      className={styles.fixtures}
      aria-label="Load a fixture flow"
      defaultValue=""
      onChange={(event) => {
        const name = event.target.value;
        if (!name) return;
        void import('../test/fixtures').then((module) => applyServerFlow(module.fixture(name)));
      }}
    >
      <option value="">Fixture…</option>
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}
