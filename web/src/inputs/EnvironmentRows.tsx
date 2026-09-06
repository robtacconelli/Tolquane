import type { JSX } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { TextInput } from '../components/form/Controls';
import { blankEnvRow, envNameError, type EnvRow } from './params';
import styles from './Inputs.module.css';

/*
 * The environment a run's child process is given: name and value, one row each.
 *
 * It is deliberately not a text area of `KEY=value` lines. A variable with an `=` in its
 * value, or a trailing space that matters, is exactly the thing a person cannot see in a
 * text area and can see here, and the rows are what the routes take anyway.
 */

export function EnvironmentRows({
  rows,
  onChange,
  idPrefix,
  disabled = false,
  addLabel = 'Add a variable',
}: {
  rows: readonly EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  idPrefix: string;
  disabled?: boolean;
  addLabel?: string;
}): JSX.Element {
  function replace(id: string, patch: Partial<EnvRow>): void {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <div className={styles.rows}>
      {rows.map((row, index) => {
        const error = envNameError(row.name);
        return (
          <div key={row.id} className={styles.row}>
            <TextInput
              id={`${idPrefix}-name-${row.id}`}
              mono
              aria-label={`Variable ${String(index + 1)} name`}
              placeholder="NAME"
              autoComplete="off"
              spellCheck={false}
              invalid={Boolean(error)}
              disabled={disabled}
              value={row.name}
              onChange={(event) => replace(row.id, { name: event.target.value })}
            />
            <TextInput
              id={`${idPrefix}-value-${row.id}`}
              mono
              aria-label={
                row.name.trim()
                  ? `Value of ${row.name.trim()}`
                  : `Variable ${String(index + 1)} value`
              }
              placeholder="value"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={row.value}
              onChange={(event) => replace(row.id, { value: event.target.value })}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              disabled={disabled}
              aria-label={
                row.name.trim()
                  ? `Remove ${row.name.trim()}`
                  : `Remove variable ${String(index + 1)}`
              }
              title="Remove"
              onClick={() => onChange(rows.filter((other) => other.id !== row.id))}
            >
              <Icon name="close" size={14} />
            </Button>
            {error ? <span className={styles.rowError}>{error}</span> : null}
          </div>
        );
      })}
      <Button
        size="sm"
        variant="ghost"
        className={styles.add}
        disabled={disabled}
        onClick={() => onChange([...rows, blankEnvRow()])}
      >
        <Icon name="plus" size={13} />
        {addLabel}
      </Button>
    </div>
  );
}
