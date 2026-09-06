import { useId, useMemo, useState, type JSX } from 'react';
import { flowPathFrom } from '../api/flowsCrud';
import { Button } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { Field, TextInput } from '../components/form/Controls';
import { Dialog } from '../components/form/Dialog';
import dialogStyles from '../components/form/Dialog.module.css';
import styles from './Flows.module.css';

export type NewFlowMode = 'empty' | 'hello' | 'describe';

export interface NewFlowValues {
  path: string;
  /** What the server writes; a described flow starts from the empty template. */
  template: 'empty' | 'hello';
  /** The question to hand the AI builder once the editor is open, or `null`. */
  description: string | null;
}

const CHOICES: { mode: NewFlowMode; icon: IconName; name: string; body: string }[] = [
  {
    mode: 'empty',
    icon: 'canvas',
    name: 'Empty',
    body: 'A source and a sink to fill in.',
  },
  {
    mode: 'hello',
    icon: 'flows',
    name: 'Hello',
    body: 'A working flow with a farm of four.',
  },
  {
    mode: 'describe',
    icon: 'sparkle',
    name: 'Describe it',
    body: 'The AI builder writes the first version.',
  },
];

/** Three or four words of a description, as a file name. */
function nameFromDescription(description: string): string {
  return description.trim().split(/\s+/).slice(0, 4).join(' ');
}

export function NewFlowDialog({
  initialMode = 'empty',
  taken,
  busy,
  error,
  onCreate,
  onClose,
}: {
  initialMode?: NewFlowMode;
  /** Paths already in the workspace, so a clash is caught before the request. */
  taken: readonly string[];
  busy: boolean;
  error: string | null;
  onCreate: (values: NewFlowValues) => void;
  onClose: () => void;
}): JSX.Element {
  const nameId = useId();
  const describeId = useId();
  const [mode, setMode] = useState<NewFlowMode>(initialMode);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState(false);

  const path = useMemo(
    () => flowPathFrom(name || (mode === 'describe' ? nameFromDescription(description) : '')),
    [name, description, mode],
  );

  const clash = path !== '' && taken.includes(path);
  const missingDescription = mode === 'describe' && description.trim() === '';
  const problem = clash
    ? `${path} is already in the workspace.`
    : touched && path === ''
      ? 'A flow needs a name.'
      : null;
  const ready = path !== '' && !clash && !missingDescription;

  function submit(): void {
    setTouched(true);
    if (!ready || busy) return;
    onCreate({
      path,
      template: mode === 'hello' ? 'hello' : 'empty',
      description: mode === 'describe' ? description.trim() : null,
    });
  }

  return (
    <Dialog
      title="New flow"
      description="A flow is a plain Python file in your workspace. Pick where it starts from."
      onClose={onClose}
      width={600}
      footer={
        <>
          {error ? <span className={dialogStyles.footerError}>{error}</span> : null}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : mode === 'describe' ? 'Create and build' : 'Create flow'}
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <Field
          label="Name"
          htmlFor={nameId}
          error={problem}
          hint={
            path ? (
              <>
                Creates <span className={styles.path}>{path}</span>
              </>
            ) : (
              'A folder works too: reports/word count.'
            )
          }
        >
          <TextInput
            id={nameId}
            data-autofocus
            value={name}
            placeholder="word count"
            autoComplete="off"
            spellCheck={false}
            invalid={problem !== null}
            onChange={(event) => {
              setName(event.target.value);
              setTouched(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>

        <Field label="Start from">
          <div className={styles.templates} role="radiogroup" aria-label="Start from">
            {CHOICES.map((choice) => (
              <button
                key={choice.mode}
                type="button"
                role="radio"
                aria-checked={mode === choice.mode}
                className={
                  mode === choice.mode
                    ? `${styles.template} ${styles.templateActive}`
                    : styles.template
                }
                onClick={() => setMode(choice.mode)}
              >
                <span className={styles.templateGlyph}>
                  <Icon name={choice.icon} size={15} />
                </span>
                <span className={styles.templateName}>{choice.name}</span>
                <span className={styles.templateBody}>{choice.body}</span>
              </button>
            ))}
          </div>
        </Field>

        {mode === 'describe' ? (
          <Field
            label="What should it do?"
            htmlFor={describeId}
            hint="The file is created empty and the builder starts on it as soon as the editor opens."
          >
            <textarea
              id={describeId}
              className={styles.describe}
              value={description}
              placeholder="read urls.txt, fetch each with 8 workers, write url, status and size to status.csv"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Renaming is one field, so it is its own small dialog rather than a mode of the above. */
export function RenameFlowDialog({
  path,
  taken,
  busy,
  error,
  onRename,
  onClose,
}: {
  path: string;
  taken: readonly string[];
  busy: boolean;
  error: string | null;
  onRename: (to: string) => void;
  onClose: () => void;
}): JSX.Element {
  const fieldId = useId();
  const [value, setValue] = useState(path);
  const target = value.trim();
  const clash = target !== path && taken.includes(target);
  const ready = target !== '' && target.endsWith('.py') && !clash;

  return (
    <Dialog
      title="Rename flow"
      description="The layout sidecar moves with the file. Past runs keep the old name."
      onClose={onClose}
      width={480}
      footer={
        <>
          {error ? <span className={dialogStyles.footerError}>{error}</span> : null}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => ready && !busy && onRename(target)}
            disabled={busy || !ready}
          >
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      }
    >
      <Field
        label="Path in the workspace"
        htmlFor={fieldId}
        error={
          clash
            ? `${target} is already in the workspace.`
            : target && !target.endsWith('.py')
              ? 'A flow is a .py file.'
              : null
        }
      >
        <TextInput
          id={fieldId}
          data-autofocus
          mono
          value={value}
          autoComplete="off"
          spellCheck={false}
          invalid={clash}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ready && !busy) {
              event.preventDefault();
              onRename(target);
            }
          }}
        />
      </Field>
    </Dialog>
  );
}
