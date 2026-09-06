import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { getSettings, type Settings } from '../api/settings';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Page';
import { useProblems, useFlowStore } from '../store/flow';
import { emptyThread, isStreaming, useAiStore, type Turn } from '../store/ai';
import { applyDraftToEditor } from './apply';
import { FlowCard } from './FlowCard';
import { Markdown } from './Markdown';
import { quickActions } from './quickActions';
import { sendTurn } from './send';
import { ToolSteps } from './ToolSteps';
import styles from './AiPanel.module.css';

/**
 * The AI builder, down the right of the editor.
 *
 * It is the same `tolquane.ai.Builder` the command line drives (docs/builder.md): it
 * writes a flow, checks it, runs it on a sample and says what it did. The panel shows
 * that loop as it happens -- words, tool steps, the file it ended with -- and hands the
 * result over with one button. Nothing it writes reaches the open file until the user
 * applies it and saves: the server works in a directory of its own (S4).
 *
 * The conversation belongs to the flow, not to the panel, so closing it, walking off to
 * another flow and coming back finds the thread where it was left.
 */
const EMPTY = emptyThread();

export function AiPanel({
  path,
  onClose,
  onHistory,
  onShowCode,
}: {
  /** The open flow's path in the workspace; `''` when none is open. */
  path: string;
  /** Go back to the properties panel. */
  onClose: () => void;
  /** Hand the column to the flow's history (section H). */
  onHistory?: (() => void) | undefined;
  onShowCode?: (() => void) | undefined;
}): JSX.Element {
  const key = path;
  const thread = useAiStore((state) => state.threads[key]) ?? EMPTY;
  const setDraft = useAiStore((state) => state.setDraft);
  const stop = useAiStore((state) => state.stop);
  const clear = useAiStore((state) => state.clear);
  const markApplied = useAiStore((state) => state.markApplied);

  const source = useFlowStore((state) => state.source);
  const problems = useProblems();

  const [settings, setSettings] = useState<Settings | null>(null);
  const [stuck, setStuck] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const streaming = isStreaming(thread);

  useEffect(() => {
    let live = true;
    getSettings().then(
      (answer) => {
        if (live) setSettings(answer);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const ask = useCallback(
    (question: string) => {
      const text = question.trim();
      if (!text) return;
      const store = useAiStore.getState();
      if (isStreaming(store.threads[key] ?? EMPTY)) return;
      void sendTurn({ key, path: path || null, question: text });
    },
    [key, path],
  );

  /* A question handed over from the Flows page ("describe it" on a new flow) is asked as
   * soon as the panel is on screen, so the flow the user described starts being written
   * without them typing it a second time. */
  useEffect(() => {
    const primed = useAiStore.getState().takePrimed(key);
    if (primed) ask(primed);
  }, [key, ask]);

  // Follow the answer as it arrives, unless the reader has scrolled up to read something.
  useEffect(() => {
    if (!stuck) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread, stuck]);

  const ai = settings?.ai;
  const hasKey =
    ai === undefined ? true : ai.provider === 'openai' ? ai.has_openai_key : ai.has_anthropic_key;

  const actions = quickActions({ hasFlow: Boolean(path), problems });

  /** Asking is also a decision to watch the answer, so the view goes back to the end. */
  function askAndFollow(question: string): void {
    setStuck(true);
    ask(question);
  }

  function onQuickAction(question: string, send: boolean): void {
    if (send) {
      askAndFollow(question);
      return;
    }
    setDraft(key, question);
    const node = composer.current;
    if (node) {
      node.focus();
      window.setTimeout(() => node.setSelectionRange(question.length, question.length), 0);
    }
  }

  return (
    <div className={styles.panel} aria-label="AI builder">
      <header className={styles.head}>
        <Segmented
          label="Right panel"
          options={[
            { value: 'properties', label: 'Properties' },
            { value: 'ai', label: 'AI builder' },
            { value: 'history', label: 'History' },
          ]}
          value="ai"
          onChange={(value) => {
            if (value === 'properties') onClose();
            else if (value === 'history') onHistory?.();
          }}
        />
        <div className={styles.headActions}>
          {thread.turns.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              title="Forget this conversation and start again"
              onClick={() => clear(key)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </header>

      <div className={styles.provider}>
        <Icon name="sparkle" size={12} />
        <span className={styles.providerName}>{ai?.provider ?? 'anthropic'}</span>
        <span className={styles.providerModel}>{ai?.model ?? 'default model'}</span>
        <Link className={styles.settingsLink} to="/settings">
          Settings
        </Link>
      </div>

      {!hasKey ? (
        <div className={styles.keyWarning} role="status">
          <Icon name="alert" size={13} />
          <span>
            No {ai?.provider ?? 'anthropic'} key yet. The builder needs one before it can answer.
          </span>
          <Link className={styles.keyLink} to="/settings">
            Add a key
          </Link>
        </div>
      ) : null}

      <div
        className={styles.thread}
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          setStuck(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
        }}
      >
        {thread.turns.length === 0 ? (
          <Intro path={path} />
        ) : (
          thread.turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className={styles.userTurn}>
                {turn.text}
              </div>
            ) : (
              <AssistantTurn
                key={turn.id}
                turn={turn}
                path={path}
                source={source}
                onApply={() => {
                  if (!turn.flow) return;
                  applyDraftToEditor(turn.flow, path);
                  markApplied(key, turn.id);
                }}
                onShowCode={onShowCode}
              />
            ),
          )
        )}
      </div>

      {actions.length > 0 && !streaming ? (
        <div className={styles.quick}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={styles.chip}
              onClick={() => onQuickAction(action.question, action.send)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          askAndFollow(thread.draft);
        }}
      >
        <textarea
          ref={composer}
          className={styles.input}
          value={thread.draft}
          rows={Math.min(6, Math.max(2, thread.draft.split('\n').length + 1))}
          placeholder={
            path ? `Ask about ${path}, or describe a change…` : 'Describe the flow you want…'
          }
          aria-label="Ask the AI builder"
          onChange={(event) => setDraft(key, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              askAndFollow(thread.draft);
            }
          }}
        />
        <div className={styles.composerFoot}>
          <span className={styles.hint}>
            <kbd>↵</kbd> to send, <kbd>⇧↵</kbd> for a new line
          </span>
          {streaming ? (
            <Button size="sm" variant="secondary" onClick={() => stop(key)}>
              <Icon name="close" size={13} />
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" type="submit" disabled={!thread.draft.trim()}>
              <Icon name="sparkle" size={13} />
              Ask
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function Intro({ path }: { path: string }): JSX.Element {
  return (
    <div className={styles.intro}>
      <span className={styles.introGlyph}>
        <Icon name="sparkle" size={18} />
      </span>
      <p className={styles.introTitle}>
        {path ? 'Change this flow by asking' : 'Describe the flow you want'}
      </p>
      <p className={styles.introBody}>
        The builder writes a whole <code>flow.py</code> in the house style, checks its wiring and
        runs it on a small sample before it answers. Nothing it writes touches your file until you
        apply it and save.
      </p>
    </div>
  );
}

function AssistantTurn({
  turn,
  path,
  source,
  onApply,
  onShowCode,
}: {
  turn: Turn;
  path: string;
  source: string;
  onApply: () => void;
  onShowCode?: (() => void) | undefined;
}): JSX.Element {
  const waiting = turn.streaming && !turn.text && turn.tools.length === 0;
  const aboutAKey = turn.error !== null && /\bkey\b/i.test(turn.error);
  return (
    <div className={styles.turn}>
      {waiting ? (
        <p className={styles.waiting} role="status">
          <span className={styles.pulse} aria-hidden="true" />
          Thinking…
        </p>
      ) : null}

      {turn.text ? <Markdown text={turn.text} writing={turn.streaming} /> : null}

      <ToolSteps steps={turn.tools} />

      {turn.flow ? (
        <FlowCard
          draft={turn.flow}
          current={source}
          path={path}
          onApply={onApply}
          onShowCode={onShowCode}
        />
      ) : null}

      {turn.error ? (
        <div className={styles.error} role="alert">
          <Icon name="alert" size={13} />
          <span>{turn.error}</span>
          {aboutAKey ? (
            <Link className={styles.keyLink} to="/settings">
              Open settings
            </Link>
          ) : null}
        </div>
      ) : null}

      {turn.stopped ? <p className={styles.stopped}>Stopped.</p> : null}

      {!turn.ok && turn.summary && !turn.error ? (
        <p className={styles.warn}>{turn.summary}</p>
      ) : null}
    </div>
  );
}
