import type { JSX, ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  art?: ReactNode;
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ art, title, body, actions }: EmptyStateProps): JSX.Element {
  return (
    <div className={styles.empty}>
      {art ? <div className={styles.art}>{art}</div> : null}
      <div>
        <div className={styles.title}>{title}</div>
        {body ? <p className={styles.body}>{body}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
