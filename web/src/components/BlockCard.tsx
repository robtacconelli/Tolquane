import type { CSSProperties, JSX } from 'react';
import { BLOCK_KINDS, type BlockKind } from './blockKinds';
import type { NodeState } from './nodeState';
import { StatusDot } from './StatusDot';
import styles from './BlockCard.module.css';

function Glyph({ kind, size }: { kind: BlockKind; size: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {BLOCK_KINDS[kind].glyph}
    </svg>
  );
}

export interface BlockCardProps {
  kind: BlockKind;
  title: string;
  subtitle?: string;
  state?: NodeState;
  selected?: boolean;
  /** Dashed and translucent: a drop target or a drag preview, not a real block. */
  ghost?: boolean;
  hasInput?: boolean;
  hasOutput?: boolean;
  style?: CSSProperties;
}

export function BlockCard({
  kind,
  title,
  subtitle,
  state,
  selected = false,
  ghost = false,
  hasInput = true,
  hasOutput = true,
  style,
}: BlockCardProps): JSX.Element {
  const classes = [styles.card, selected ? styles.selected : '', ghost ? styles.ghost : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      style={{ ...style, ['--card-accent' as string]: BLOCK_KINDS[kind].accent }}
    >
      {hasInput ? <span className={`${styles.port} ${styles.portIn}`} /> : null}
      <span className={styles.glyph}>
        <Glyph kind={kind} size={17} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
      {state ? (
        <span className={styles.state}>
          <StatusDot state={state} />
        </span>
      ) : null}
      {hasOutput ? <span className={`${styles.port} ${styles.portOut}`} /> : null}
    </div>
  );
}

/** The draggable palette row; `compact` is the same tile without its label, for the rail. */
export function BlockChip({
  kind,
  compact = false,
}: {
  kind: BlockKind;
  compact?: boolean;
}): JSX.Element {
  const info = BLOCK_KINDS[kind];
  return (
    <div
      className={compact ? `${styles.chip} ${styles.chipCompact}` : styles.chip}
      style={{ ['--card-accent' as string]: info.accent }}
    >
      <span className={styles.chipGlyph}>
        <Glyph kind={kind} size={15} />
      </span>
      {compact ? null : info.label}
    </div>
  );
}
