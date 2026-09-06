import type { JSX, ReactNode } from 'react';
import styles from './Page.module.css';

export function Page({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.page}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <h2 className={styles.title}>{title}</h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={[styles.panel, className].filter(Boolean).join(' ')}>{children}</section>
  );
}

export function PanelHeader({
  title,
  hint,
  actions,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.panelHeader}>
      <span className={styles.panelTitle}>{title}</span>
      {hint ? <span className={styles.panelHint}>{hint}</span> : null}
      {actions ? <div className={styles.panelActions}>{actions}</div> : null}
    </div>
  );
}

/** The header row of a list, kept even when the list is empty so the shape is legible. */
export function ListColumns({
  columns,
  template,
}: {
  columns: readonly string[];
  template: string;
}): JSX.Element {
  return (
    <div className={styles.columns} style={{ gridTemplateColumns: template }}>
      {columns.map((column) => (
        <span key={column}>{column}</span>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange?: (value: T) => void;
  label: string;
}): JSX.Element {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={
            option.value === value ? `${styles.segment} ${styles.segmentActive}` : styles.segment
          }
          aria-pressed={option.value === value}
          onClick={() => onChange?.(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
