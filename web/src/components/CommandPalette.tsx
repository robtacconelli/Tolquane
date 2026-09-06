import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { listFlows, type FlowSummary } from '../api/flowsList';
import { useEditorLayout } from '../editor/layout';
import { MOD_KEY } from '../platform';
import { useAiStore } from '../store/ai';
import { useCommandsStore } from '../store/commands';
import { useFlowStore } from '../store/flow';
import { useRunStore } from '../store/run';
import { useUiStore } from '../store/ui';
import { Icon, type IconName } from './Icon';
import styles from './CommandPalette.module.css';

/*
 * Everything the app can do, in one list, from anywhere.
 *
 * The palette is not a menu of its own: every row here is the same action a button
 * somewhere else performs, reached through the same store. The two it cannot reach --
 * running a flow and cancelling it -- belong to the run button, which registers them
 * while it is on screen (`store/commands.ts`); with no flow open they are simply not in
 * the list, rather than in it and dead.
 *
 * The flows come from the server the moment the palette opens, so typing part of a name
 * is the fastest way to any file in the workspace.
 */

interface Command {
  id: string;
  group: string;
  icon: IconName;
  label: string;
  /** The key that does the same thing, or what the row is about (a flow's folder). */
  hint?: string;
  /** Extra words the search matches, for rows whose label is not what you would type. */
  keywords?: string;
  run: () => void;
}

/** The app's own keys, listed under the palette so they are learnt in passing. */
const SHORTCUTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: [MOD_KEY, 'S'], label: 'save' },
  { keys: [MOD_KEY, '↵'], label: 'run' },
  { keys: [MOD_KEY, 'Z'], label: 'undo' },
];

function matches(command: Command, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`.toLowerCase();
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function CommandPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [flows, setFlows] = useState<FlowSummary[]>([]);

  const handlers = useCommandsStore((state) => state.handlers);
  const running = useRunStore((state) => state.status) === 'running';
  const theme = useUiStore((state) => state.theme);
  const view = useFlowStore((state) => state.view);
  const expanded = useFlowStore((state) => state.expanded);
  const openFlow = useFlowStore((state) => state.path);

  const editing = location.pathname.startsWith('/flows/');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The workspace, for the "open a flow" rows. A palette that cannot reach the server
  // still has every other command, so a failure here is silent on purpose.
  useEffect(() => {
    let live = true;
    listFlows().then(
      (answer) => {
        if (live) setFlows(answer.flows);
      },
      () => {
        /* the rest of the palette still works */
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go =
      (to: string): (() => void) =>
      () => {
        void navigate(to);
      };
    const layout = useEditorLayout.getState();
    const list: Command[] = [];

    // Newest first: with nothing typed the palette offers the few you were just in.
    const recent = [...flows].sort((a, b) => b.modified.localeCompare(a.modified));
    for (const flow of recent) {
      list.push({
        id: `flow:${flow.path}`,
        group: 'Flows',
        icon: 'flows',
        label: flow.name,
        hint: flow.path.includes('/') ? flow.path.slice(0, flow.path.lastIndexOf('/') + 1) : 'Open',
        keywords: flow.path,
        run: go(`/flows/${flow.path}`),
      });
    }

    list.push(
      {
        id: 'flow:new',
        group: 'Flows',
        icon: 'plus',
        label: 'New flow…',
        keywords: 'create add empty',
        run: () => {
          useCommandsStore.getState().ask({ kind: 'new-flow' });
          void navigate('/flows');
        },
      },
      {
        id: 'flow:ai',
        group: 'Flows',
        icon: 'sparkle',
        label: 'Build a flow with the AI builder…',
        keywords: 'ai builder describe generate',
        run: () => {
          const ai = useAiStore.getState();
          ai.setOpen(true);
          if (editing) return;
          ai.requestNewFlow();
          void navigate('/flows');
        },
      },
    );

    if (editing) {
      if (running && handlers.cancel) {
        list.push({
          id: 'run:cancel',
          group: 'Run',
          icon: 'close',
          label: 'Cancel this run',
          hint: `${MOD_KEY} ↵`,
          run: handlers.cancel,
        });
      } else if (handlers.run) {
        list.push({
          id: 'run:start',
          group: 'Run',
          icon: 'play',
          label: 'Run this flow',
          hint: `${MOD_KEY} ↵`,
          run: handlers.run,
        });
      }
      if (handlers.check) {
        list.push({
          id: 'run:check',
          group: 'Run',
          icon: 'check',
          label: 'Check this flow',
          keywords: 'validate wiring tq.check',
          run: handlers.check,
        });
      }
      if (handlers.save) {
        list.push({
          id: 'run:save',
          group: 'Run',
          icon: 'folder',
          label: 'Save this flow',
          hint: `${MOD_KEY} S`,
          run: handlers.save,
        });
      }
      list.push(
        {
          id: 'view:code',
          group: 'View',
          icon: 'code',
          label: view === 'code' ? 'Show the canvas' : 'Show the code',
          keywords: 'python source editor toggle',
          run: () => {
            useFlowStore.getState().setView(view === 'code' ? 'canvas' : 'code');
          },
        },
        {
          id: 'view:threads',
          group: 'View',
          icon: 'canvas',
          label: expanded ? 'Show the blocks' : 'Show the threads',
          keywords: 'expanded graph toggle',
          run: () => {
            useFlowStore.getState().setExpanded(!expanded);
          },
        },
        {
          id: 'view:palette',
          group: 'View',
          icon: 'panelLeft',
          label: layout.paletteOpen ? 'Fold the block palette' : 'Unfold the block palette',
          run: layout.togglePalette,
        },
        {
          id: 'view:drawer',
          group: 'View',
          icon: 'panelBottom',
          label: layout.drawerOpen ? 'Fold the run drawer' : 'Unfold the run drawer',
          keywords: 'console output',
          run: layout.toggleDrawer,
        },
        {
          id: 'view:panel',
          group: 'View',
          icon: 'panelRight',
          label: layout.panelOpen ? 'Hide the side panel' : 'Show the side panel',
          keywords: 'properties options',
          run: layout.togglePanel,
        },
      );
      if (openFlow) {
        list.push({
          id: 'run:schedule',
          group: 'Run',
          icon: 'clock',
          label: 'Schedule this flow…',
          keywords: 'cron every',
          run: () => {
            useCommandsStore.getState().ask({ kind: 'schedule', flow: openFlow });
            void navigate('/schedules');
          },
        });
      }
    }

    list.push(
      { id: 'go:flows', group: 'Go to', icon: 'flows', label: 'Flows', run: go('/flows') },
      { id: 'go:runs', group: 'Go to', icon: 'runs', label: 'Runs', run: go('/runs') },
      {
        id: 'go:schedules',
        group: 'Go to',
        icon: 'schedules',
        label: 'Schedules',
        run: go('/schedules'),
      },
      {
        id: 'go:settings',
        group: 'Go to',
        icon: 'settings',
        label: 'Settings',
        run: go('/settings'),
      },
      {
        id: 'ui:theme',
        group: 'Go to',
        icon: theme === 'dark' ? 'sun' : 'moon',
        label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
        keywords: 'appearance dark light',
        run: () => {
          useUiStore.getState().toggleTheme();
        },
      },
    );

    return list;
  }, [editing, expanded, flows, handlers, navigate, openFlow, running, theme, view]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = commands.filter((command) => matches(command, needle));
    // With nothing typed the workspace would push everything else off the screen.
    if (needle) return found.slice(0, 40);
    const flowRows = found.filter((command) => command.id.startsWith('flow:') && command.hint);
    return [...flowRows.slice(0, 4), ...found.filter((command) => !flowRows.includes(command))];
  }, [commands, query]);

  // A list that shrank under the cursor still has a highlighted row, and it is the last.
  const at = shown.length === 0 ? 0 : Math.min(active, shown.length - 1);

  // Keep the highlighted row in view while the arrows walk past the bottom of the list.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const groups = useMemo(() => {
    const out: { name: string; rows: Command[] }[] = [];
    for (const command of shown) {
      const last = out.at(-1);
      if (last?.name === command.group) last.rows.push(command);
      else out.push({ name: command.group, rows: [command] });
    }
    return out;
  }, [shown]);

  function choose(command: Command | undefined): void {
    if (!command) return;
    onClose();
    command.run();
  }

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.palette} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className={styles.searchRow}>
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Search flows, or type a command"
            aria-label="Search flows, or type a command"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((at) => (shown.length === 0 ? 0 : (at + 1) % shown.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((at) =>
                  shown.length === 0 ? 0 : (at - 1 + shown.length) % shown.length,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(shown[at]);
              }
            }}
          />
        </div>

        <div className={styles.list} ref={listRef}>
          {shown.length === 0 ? (
            <p className={styles.nothing}>Nothing here matches “{query.trim()}”.</p>
          ) : null}
          {groups.map((group) => (
            <div key={group.name}>
              <div className={styles.group}>{group.name}</div>
              {group.rows.map((command) => {
                const index = shown.indexOf(command);
                const on = index === at;
                return (
                  <button
                    key={command.id}
                    type="button"
                    data-active={on}
                    className={on ? `${styles.row} ${styles.rowActive}` : styles.row}
                    onMouseMove={() => {
                      setActive(index);
                    }}
                    onClick={() => {
                      choose(command);
                    }}
                  >
                    <Icon name={command.icon} />
                    <span className={styles.rowText}>{command.label}</span>
                    {command.hint ? <span className={styles.rowHint}>{command.hint}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className={styles.foot}>
          <span className={styles.footItem}>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span className={styles.footItem}>
            <kbd>↵</kbd> to run
          </span>
          <span className={styles.footItem}>
            <kbd>esc</kbd> to close
          </span>
          <span className={styles.footKeys}>
            {SHORTCUTS.map((shortcut) => (
              <span key={shortcut.label} className={styles.footItem}>
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}{' '}
                {shortcut.label}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
