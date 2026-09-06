import { useEffect, useRef, type JSX } from 'react';
import { MOD_KEY } from '../platform';
import { Icon, type IconName } from './Icon';
import styles from './CommandPalette.module.css';

interface Command {
  group: string;
  icon: IconName;
  label: string;
  hint?: string;
}

/* The frame only. Wave 2 wires these to the server; the list is here so the shape of
 * the palette (groups, icons, right-aligned hints) is fixed before anyone builds on it. */
const COMMANDS: readonly Command[] = [
  { group: 'Flows', icon: 'plus', label: 'New flow…', hint: 'N' },
  { group: 'Flows', icon: 'search', label: 'Open flow…', hint: 'O' },
  { group: 'Flows', icon: 'sparkle', label: 'Build a flow with the AI builder…' },
  { group: 'Run', icon: 'play', label: 'Run the open flow', hint: `${MOD_KEY} ↵` },
  { group: 'Run', icon: 'check', label: 'Check the open flow' },
  { group: 'Run', icon: 'clock', label: 'Schedule the open flow…' },
  { group: 'View', icon: 'code', label: 'Toggle code view' },
  { group: 'View', icon: 'canvas', label: 'Toggle expanded graph' },
];

const GROUPS = COMMANDS.reduce<{ name: string; commands: Command[] }[]>((groups, command) => {
  const last = groups.at(-1);
  if (last?.name === command.group) last.commands.push(command);
  else groups.push({ name: command.group, commands: [command] });
  return groups;
}, []);

export function CommandPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          />
        </div>
        <div className={styles.list}>
          {GROUPS.map((group) => (
            <div key={group.name}>
              <div className={styles.group}>{group.name}</div>
              {group.commands.map((command) => (
                <div
                  key={command.label}
                  className={
                    command === COMMANDS[0] ? `${styles.row} ${styles.rowActive}` : styles.row
                  }
                  aria-disabled="true"
                >
                  <Icon name={command.icon} />
                  <span className={styles.rowText}>{command.label}</span>
                  {command.hint ? <span className={styles.rowHint}>{command.hint}</span> : null}
                </div>
              ))}
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
          <span className={styles.footNote}>Commands arrive with the editor.</span>
        </div>
      </div>
    </div>
  );
}
