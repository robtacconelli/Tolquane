import type { JSX } from 'react';
import { NODE_STATE_LABEL, type NodeState } from './nodeState';
import styles from './StatusDot.module.css';

export function StatusDot({ state, title }: { state: NodeState; title?: string }): JSX.Element {
  return (
    <span
      className={`${styles.dot} ${styles[state]}`}
      role="img"
      aria-label={title ?? NODE_STATE_LABEL[state]}
      title={title ?? NODE_STATE_LABEL[state]}
    />
  );
}
