import type { JSX, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './Notice.module.css';

/**
 * The one strip the app says things in.
 *
 * Every page had grown its own: a saved message on the editor, a renamed message on the
 * flows list, a started message on the schedules page, each with its own class and its
 * own dismiss button. They are all this, so "Saved", "Deleted hello.py" and "The flow
 * could not be saved" look and behave the same wherever they happen: the tone's icon,
 * the sentence, and a cross when there is something to dismiss.
 *
 * Good news announces itself politely and is usually taken away on a timer by the page
 * that raised it; a failure is an alert and stays until it is read.
 */

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const ICON: Record<NoticeTone, IconName> = {
  info: 'offline',
  success: 'check',
  warning: 'alert',
  error: 'alert',
};

export function Notice({
  tone = 'info',
  children,
  onDismiss,
  className,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={[styles.notice, className].filter(Boolean).join(' ')}
      data-tone={tone}
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
    >
      <Icon name={ICON[tone]} size={14} />
      <span className={styles.text}>{children}</span>
      {onDismiss ? (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" size={13} />
        </button>
      ) : null}
    </div>
  );
}
