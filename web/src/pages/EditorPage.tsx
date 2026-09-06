import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useParams } from 'react-router-dom';
import { AiPanel } from '../ai/AiPanel';
import { ApiError } from '../api/client';
import { checkFlow, generateSource, getFlow, saveFlow, saveLayout } from '../api/flows';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { Segmented } from '../components/Page';
import { Palette } from '../editor/Palette';
import { Properties } from '../editor/Properties';
import { CodeDialogs, CodeStage } from '../editor/code';
import { reportSaveFailure, useCodeSync } from '../editor/code/sync';
import { useCodeSyncStore } from '../editor/code/syncStore';
import { DRAWER_COLLAPSED_HEIGHT, DRAWER_MIN_HEIGHT, useEditorLayout } from '../editor/layout';
import { locateProblem, type Problem } from '../model';
import { RunButton } from '../run/RunButton';
import { RunDrawer, type DrawerTab } from '../run/RunDrawer';
import { useAiStore } from '../store/ai';
import { useCommand } from '../store/commands';
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

type Tab = DrawerTab;

/** What the toolbar has to say about the last thing it was asked to do. */
interface PageNotice {
  tone: 'info' | 'error' | 'success';
  text: string;
}

export function EditorPage(): JSX.Element {
  const params = useParams<{ '*': string }>();
  const path = params['*'] ?? '';

  const flowPath = useFlowStore((state) => state.path);
  const model = useFlowStore((state) => state.model);
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

  // The AI panel takes the right column when it is open, and needs more of it than the
  // properties do; the column is `--tq-panel-width` wide, so widening it is one variable.
  const aiOpen = useAiStore((state) => state.open);
  const setAiOpen = useAiStore((state) => state.setOpen);

  // The furniture around the canvas, remembered between visits (see editor/layout.ts).
  const paletteOpen = useEditorLayout((state) => state.paletteOpen);
  const drawerOpen = useEditorLayout((state) => state.drawerOpen);
  const drawerHeight = useEditorLayout((state) => state.drawerHeight);
  const panelOpen = useEditorLayout((state) => state.panelOpen);
  const setPanelOpen = useEditorLayout((state) => state.setPanelOpen);
  const setDrawerHeight = useEditorLayout((state) => state.setDrawerHeight);

  /* The two-way sync between the file and the canvas: it is mounted on the page rather
   * than in the code view because a canvas edit has to reach the file with the code view
   * closed, and because nothing it imports pulls CodeMirror into this bundle. */
  useCodeSync();

  const [tab, setTab] = useState<Tab>('Console');
  const [notice, setNotice] = useState<PageNotice | null>(null);
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
      if (reportSaveFailure(error)) {
        // The dialog now has both versions and the question to ask about them.
        setNotice(null);
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
      // A code editor with the focus has its own undo stack, over its own text; only the
      // canvas's undo belongs to the page.
      const inEditor = (event.target as Element | null)?.closest?.('.cm-editor') != null;
      if (inEditor && key !== 's') return;
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

  // The builder needs the column it lives in, wherever it was opened from.
  useEffect(() => {
    if (aiOpen) setPanelOpen(true);
  }, [aiOpen, setPanelOpen]);

  // The same two actions the toolbar offers, for the command palette.
  const saveCommand = useCallback((): void => {
    void save();
  }, [save]);
  const checkCommand = useCallback((): void => {
    void check();
  }, [check]);
  useCommand('save', saveCommand);
  useCommand('check', checkCommand);

  /* Dragging the drawer's top edge. The pointer is captured, so a fast drag that leaves
   * the handle keeps resizing, and the height is only written down when the drag ends. */
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; height: number } | null>(null);

  const onGripDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (!drawerOpen) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { from: event.clientY, height: drawerHeight };
    },
    [drawerHeight, drawerOpen],
  );

  const onGripMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const start = drag.current;
      if (!start) return;
      const room = (frame.current?.clientHeight ?? 720) - 220;
      setDrawerHeight(Math.min(room, start.height + (start.from - event.clientY)));
    },
    [setDrawerHeight],
  );

  const onGripUp = useCallback((): void => {
    if (!drag.current) return;
    drag.current = null;
    setDrawerHeight(useEditorLayout.getState().drawerHeight, true);
  }, [setDrawerHeight]);

  const opened = flowPath === path && (model !== null || codeOnly !== null);

  return (
    <div
      ref={frame}
      className={styles.editor}
      data-panel={panelOpen ? 'on' : 'off'}
      style={
        {
          '--tq-panel-width': aiOpen ? '408px' : undefined,
          '--tq-palette-width': paletteOpen ? '176px' : '44px',
          '--tq-drawer-height': `${String(drawerOpen ? drawerHeight : DRAWER_COLLAPSED_HEIGHT)}px`,
        } as CSSProperties
      }
    >
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
        <Button
          variant={aiOpen ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={aiOpen}
          onClick={() => setAiOpen(!aiOpen)}
        >
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
        <RunButton path={path} ready={opened} onBeforeRun={save} />
        <span className={styles.divider} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-pressed={panelOpen}
          aria-label={panelOpen ? 'Hide the side panel' : 'Show the side panel'}
          title={panelOpen ? 'Hide the side panel' : 'Show the side panel'}
          onClick={() => {
            setPanelOpen(!panelOpen);
          }}
        >
          <Icon name="panelRight" size={16} />
        </Button>
      </div>

      <div className={styles.notices}>
        {notice ? (
          <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Notice>
        ) : null}

        {codeOnly && view !== 'code' ? (
          <Notice tone="warning">
            This file cannot be modelled, so the canvas is read-only and shows the expanded graph.{' '}
            <span className={styles.reason}>{codeOnly.reason}</span>
          </Notice>
        ) : null}
      </div>

      <div className={styles.stage}>
        {view === 'canvas' && !loadError ? (
          <div className={styles.paletteColumn}>
            <Palette disabled={!model || expanded} />
          </div>
        ) : null}
        {view === 'code' ? (
          <CodeStage />
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

      {panelOpen ? (
        <aside className={styles.properties}>
          {aiOpen ? (
            <AiPanel
              path={path}
              onClose={() => setAiOpen(false)}
              onShowCode={() => setView('code')}
            />
          ) : (
            <Properties
              onEditCode={(nodeId) => {
                setView('code');
                useCodeSyncStore.getState().revealNode(nodeId);
              }}
            />
          )}
        </aside>
      ) : null}

      <section className={styles.drawer}>
        <div
          className={styles.grip}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag to resize the run drawer"
          aria-valuenow={drawerOpen ? drawerHeight : DRAWER_COLLAPSED_HEIGHT}
          aria-valuemin={DRAWER_MIN_HEIGHT}
          tabIndex={0}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const room = (frame.current?.clientHeight ?? 720) - 220;
            const step = event.key === 'ArrowUp' ? 24 : -24;
            setDrawerHeight(Math.min(room, drawerHeight + step), true);
          }}
        />
        <RunDrawer
          tab={tab}
          onTab={setTab}
          problems={problems}
          selected={selected}
          onSelectProblem={select}
        />
      </section>

      <CodeDialogs />
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
