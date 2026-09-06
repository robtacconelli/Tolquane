import type { InputHTMLAttributes, JSX, ReactNode, SelectHTMLAttributes } from 'react';
import styles from './Controls.module.css';

/* The form primitives the schedules and settings screens share. They are deliberately
 * thin: a label row, a control, and one line underneath that is either the hint or the
 * error, never both, so a field never changes height when it goes wrong. */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  aside,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  /** The end of the label row: a badge, a counter, a small inline action. */
  aside?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
        {aside ? <div className={styles.aside}>{aside}</div> : null}
      </div>
      {children}
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : hint ? (
        <p className={styles.hint}>{hint}</p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export function TextInput({ mono, invalid, className, ...rest }: TextInputProps): JSX.Element {
  return (
    <input
      className={[styles.input, mono ? styles.mono : '', invalid ? styles.invalid : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

/** A number as text: the spinner buttons are noise, and the rules are ours anyway. */
export function NumberInput({ invalid, className, ...rest }: TextInputProps): JSX.Element {
  return (
    <TextInput
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      invalid={invalid ?? false}
      className={[styles.numeric, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({ invalid, className, children, ...rest }: SelectProps): JSX.Element {
  return (
    <span className={styles.selectWrap}>
      <select
        className={[styles.input, styles.select, invalid ? styles.invalid : '', className]
          .filter(Boolean)
          .join(' ')}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {children}
      </select>
      <span className={styles.caret} aria-hidden="true" />
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name; the switch itself carries no text. */
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={[styles.toggle, checked ? styles.toggleOn : ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </button>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}): JSX.Element {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

/** A checkbox with its label, for the one-line "enable this now" kind of choice. */
export function CheckLine({
  checked,
  onChange,
  children,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  id?: string;
}): JSX.Element {
  return (
    <label className={styles.checkLine} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className={styles.checkbox}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
