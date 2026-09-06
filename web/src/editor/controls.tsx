import type { ChangeEvent, JSX, ReactNode } from 'react';
import { useId } from 'react';
import styles from './controls.module.css';

/* The controls of the property panel. Every one is a label, a control on the 30px grid
 * and room for the message that says what is wrong with it, so a farm's options read as
 * one column however many of them a block has. */

export function Field({
  label,
  hint,
  error,
  control,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  control: (id: string) => ReactNode;
}): JSX.Element {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {control(id)}
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : hint ? (
        <p className={styles.hint}>{hint}</p>
      ) : null}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min = 1,
  max,
  placeholder,
  hint,
  error,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | undefined;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Field
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      control={(id) => (
        <input
          id={id}
          type="number"
          className={styles.input}
          value={value ?? ''}
          min={min}
          {...(max === undefined ? {} : { max })}
          placeholder={placeholder ?? 'default'}
          disabled={disabled ?? false}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const text = event.target.value.trim();
            onChange(text === '' ? null : Number(text));
          }}
        />
      )}
    />
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: ReactNode;
  error?: string | undefined;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Field
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      control={(id) => (
        <select
          id={id}
          className={styles.input}
          value={value}
          disabled={disabled ?? false}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    />
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
}): JSX.Element {
  return (
    <Field
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      control={(id) => (
        <input
          id={id}
          type="text"
          className={mono ? `${styles.input} ${styles.mono}` : styles.input}
          value={value}
          placeholder={placeholder ?? ''}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    />
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
}): JSX.Element {
  const id = useId();
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <label className={styles.toggleLabel} htmlFor={id}>
          {label}
        </label>
        {hint ? <p className={styles.hint}>{hint}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={checked ? `${styles.switch} ${styles.switchOn}` : styles.switch}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} />
      </button>
    </div>
  );
}

/**
 * A block of code the panel only shows: an expression the model keeps verbatim, a node
 * that is not defined in this file, and the moment before the body editor's chunk lands.
 * Anything editable is `editor/code/NodeBody` instead.
 */
export function CodeBlock({
  code,
  action,
  title,
}: {
  code: string;
  action?: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <span className={styles.codeTitle}>{title ?? 'Body'}</span>
        {action}
      </div>
      <pre className={styles.codeBody}>{code}</pre>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}
