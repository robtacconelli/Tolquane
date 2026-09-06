import type { JSX, ReactNode } from 'react';
import { Field, NumberInput, TextInput, Toggle } from '../components/form/Controls';
import type { FlowParam } from '../model/types';
import { paramError, paramFieldType, paramText, paramValue, type ParamFieldType } from './params';
import styles from './Inputs.module.css';

/*
 * One field per parameter of `build()`, typed from the default the author wrote.
 *
 * The Run popover and the schedule dialog show exactly the same controls, because they
 * are asking the same question: what should this flow be called with? The value is held
 * as text while it is being typed -- a half-typed `0.` is not a number yet, and turning
 * it into one would move the cursor -- and read back with `paramValue` on every stroke,
 * so the caller always has the value and the error together.
 */

export function ParameterSection({
  title = 'Parameters',
  note,
  children,
}: {
  title?: string;
  note?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{title}</span>
        {note ? <span className={styles.sectionNote}>{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function ParameterFields({
  params,
  values,
  onChange,
  idPrefix,
  disabled = false,
  empty = 'This flow’s build() takes no parameters.',
}: {
  params: readonly FlowParam[];
  /** The text of each field, by parameter name; the caller keeps it so it survives. */
  values: Record<string, string>;
  /** Called with the text and the value it reads as; `null` when the text is not one. */
  onChange: (name: string, text: string, value: unknown, error: string | null) => void;
  idPrefix: string;
  disabled?: boolean;
  /** What to say when `build()` declares nothing; `null` shows nothing at all. */
  empty?: ReactNode;
}): JSX.Element {
  if (params.length === 0) {
    return empty === null ? <></> : <p className={styles.none}>{empty}</p>;
  }
  return (
    <div className={styles.params}>
      {params.map((param) => (
        <ParameterField
          key={param.name}
          param={param}
          id={`${idPrefix}-${param.name}`}
          text={values[param.name] ?? paramText(paramFieldType(param), null)}
          disabled={disabled}
          onChange={(text) => {
            const type = paramFieldType(param);
            onChange(param.name, text, paramValue(type, text), paramError(type, text));
          }}
        />
      ))}
    </div>
  );
}

/** The hint under a field: what it is annotated as, and what the file's own default is. */
function hintOf(param: FlowParam, type: ParamFieldType): string {
  const kind = param.annotation ?? type;
  return `${kind} · the file says ${param.default}`;
}

function ParameterField({
  param,
  id,
  text,
  disabled,
  onChange,
}: {
  param: FlowParam;
  id: string;
  text: string;
  disabled: boolean;
  onChange: (text: string) => void;
}): JSX.Element {
  const type = paramFieldType(param);
  const error = paramError(type, text);
  const hint = hintOf(param, type);

  if (type === 'boolean') {
    const on = text === 'True' || text === 'true';
    return (
      <Field label={param.name} hint={hint}>
        <div className={styles.toggleRow}>
          <span className={styles.sectionNote}>{on ? 'True' : 'False'}</span>
          <Toggle
            label={param.name}
            checked={on}
            disabled={disabled}
            onChange={(next) => onChange(next ? 'True' : 'False')}
          />
        </div>
      </Field>
    );
  }

  if (type === 'code') {
    return (
      <Field label={param.name} htmlFor={id} hint={hint} error={error}>
        <textarea
          id={id}
          className={error ? `${styles.code} ${styles.codeInvalid}` : styles.code}
          spellCheck={false}
          autoComplete="off"
          aria-label={param.name}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  }

  const Input = type === 'number' ? NumberInput : TextInput;
  return (
    <Field label={param.name} htmlFor={id} hint={hint} error={error}>
      <Input
        id={id}
        mono={type !== 'text'}
        aria-label={param.name}
        autoComplete="off"
        spellCheck={false}
        invalid={Boolean(error)}
        disabled={disabled}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
