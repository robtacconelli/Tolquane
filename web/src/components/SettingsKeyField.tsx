import type { JSX } from 'react';
import { Badge, TextInput } from './form/Controls';
import styles from './SettingsKeyField.module.css';

/**
 * An API key control. The server only ever reports whether a key is set (S4), so this
 * field never has a value to show: it shows the state, takes a new key, and forgets it
 * the moment the section is saved.
 */
export function SettingsKeyField({
  id,
  label,
  isSet,
  value,
  onChange,
}: {
  id: string;
  /** The accessible name; the visible label is the row's. */
  label: string;
  isSet: boolean;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <>
      <TextInput
        id={id}
        type="password"
        mono
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        placeholder={isSet ? 'Replace the stored key' : 'Paste a key'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className={styles.hint}>
        {value
          ? 'Sent once when you save, then forgotten here.'
          : isSet
            ? 'Stored. Leave empty to keep it.'
            : 'Not stored. The environment is used if it has one.'}
      </span>
    </>
  );
}

/** The badge beside the row label: what the server holds right now. */
export function SettingsKeyBadge({ isSet }: { isSet: boolean }): JSX.Element {
  return isSet ? <Badge tone="success">Set</Badge> : <Badge>Not set</Badge>;
}
