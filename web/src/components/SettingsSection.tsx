import type { JSX, ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Panel, PanelHeader } from './Page';
import styles from './SettingsSection.module.css';

/**
 * One settings panel, saved on its own. Every section carries its state in the same
 * place — the footer — so a reader always knows whether what is on screen is what the
 * server holds: "Unsaved changes", "Saved", or the server's own message when it refused.
 */
export function SettingsSection({
  title,
  hint,
  description,
  children,
  note,
  dirty = false,
  saving = false,
  saved = false,
  invalid = false,
  error = null,
  onSave,
  onReset,
}: {
  title: string;
  hint?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Shown in the footer when there is nothing else to say; the read-only sections' only content. */
  note?: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  saved?: boolean;
  /** A field in this section fails its own rule; saving is held until it does not. */
  invalid?: boolean;
  error?: string | null;
  onSave?: () => void;
  onReset?: () => void;
}): JSX.Element {
  const status = error ? (
    <span className={styles.error}>
      <Icon name="alert" size={14} />
      {error}
    </span>
  ) : dirty ? (
    <span className={styles.dirty}>Unsaved changes</span>
  ) : saved ? (
    <span className={styles.saved}>
      <Icon name="check" size={14} />
      Saved
    </span>
  ) : (
    <span className={styles.note}>{note}</span>
  );

  return (
    <Panel>
      <PanelHeader title={title} hint={hint} />
      {description ? <p className={styles.description}>{description}</p> : null}
      {children}
      {onSave ? (
        <div className={styles.footer} role="status">
          {status}
          <Button size="sm" onClick={onReset} disabled={!dirty || saving}>
            Discard
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={onSave}
            disabled={!dirty || saving || invalid}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      ) : note ? (
        <div className={styles.footer}>
          <span className={styles.note}>{note}</span>
        </div>
      ) : null}
    </Panel>
  );
}

/** A labelled row: what it is on the left, the control on the right. */
export function SettingsRow({
  label,
  help,
  htmlFor,
  aside,
  children,
}: {
  label: string;
  help?: ReactNode;
  htmlFor?: string;
  /** Sits beside the label: a badge saying what the server currently holds. */
  aside?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={htmlFor}>
            {label}
          </label>
          {aside}
        </div>
        {help ? <div className={styles.help}>{help}</div> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

/** A row whose control is wider than the right-hand column: the label sits above it. */
export function SettingsStack({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.stack}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {help ? <div className={styles.help}>{help}</div> : null}
      <div className={styles.stackBody}>{children}</div>
    </div>
  );
}
