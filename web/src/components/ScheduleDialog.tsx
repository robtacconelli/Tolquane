import { useId, useState, type JSX } from 'react';
import type { FlowSummary } from '../api/flowsList';
import { RUNTIMES, type Runtime, type Schedule } from '../api/schedules';
import { Button } from './Button';
import { CheckLine, Field, Select, TextInput } from './form/Controls';
import { Dialog } from './form/Dialog';
import { ScheduleCronEditor } from './ScheduleCronEditor';
import { DEFAULT_CRON } from './scheduleCron';
import styles from './ScheduleDialog.module.css';

export interface ScheduleFormValues {
  flow: string;
  cron: string;
  runtime: Runtime;
  sample: string | null;
  enabled: boolean;
}

/**
 * The one form for creating and editing a schedule. It owns the draft and the message
 * the server sends back; the page owns the request, so a 400 for a bad cron lands on
 * the field the reader is looking at.
 */
export function ScheduleDialog({
  mode,
  initial,
  initialFlow,
  flows,
  defaultRuntime = 'threads',
  debounceMs,
  onSubmit,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial?: Schedule | null;
  /** Creating a schedule for a flow already in hand: the editor's "Schedule this flow…". */
  initialFlow?: string;
  flows: readonly FlowSummary[];
  defaultRuntime?: Runtime;
  /** Only the tests need this; the editor debounces its preview by 350 ms otherwise. */
  debounceMs?: number;
  onSubmit: (values: ScheduleFormValues) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const formId = useId();
  const flowId = useId();
  const runtimeId = useId();
  const sampleId = useId();
  const enabledId = useId();

  /* The chosen flow, or nothing chosen yet: the workspace may still be arriving when the
   * dialog opens -- it is when the command palette navigates here -- so the fallback is
   * read at render time rather than frozen when the state was made. */
  const [chosen, setChosen] = useState(initial?.flow ?? initialFlow ?? '');
  const flow = chosen || flows[0]?.path || '';
  const [cron, setCron] = useState(initial?.cron ?? DEFAULT_CRON);
  const [runtime, setRuntime] = useState<Runtime>(initial?.runtime ?? defaultRuntime);
  const [sample, setSample] = useState(initial?.sample ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    if (!flow) {
      setError('Choose the flow this schedule runs.');
      return;
    }
    if (!cron.trim()) {
      setError('Enter a cron expression.');
      return;
    }
    setSaving(true);
    setError(null);
    void onSubmit({ flow, cron: cron.trim(), runtime, sample: sample.trim() || null, enabled })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setSaving(false));
  }

  const creating = mode === 'create';

  return (
    <Dialog
      title={creating ? 'New schedule' : 'Edit schedule'}
      description="The server starts the flow in a child process at each of these times."
      onClose={onClose}
      width={680}
      footer={
        <>
          <div className={styles.footerLead}>
            <CheckLine checked={enabled} onChange={setEnabled} id={enabledId}>
              {creating ? 'Enable it now' : 'Enabled'}
            </CheckLine>
            {error ? (
              <span className={styles.error} role="alert">
                {error}
              </span>
            ) : null}
          </div>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : creating ? 'Create schedule' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Flow"
          htmlFor={flowId}
          {...(flows.length
            ? {}
            : { hint: 'No flows in the workspace yet. Create one first, then schedule it.' })}
        >
          <Select
            id={flowId}
            data-autofocus
            value={flow}
            disabled={flows.length === 0}
            onChange={(event) => setChosen(event.target.value)}
          >
            {flows.length === 0 ? <option value="">No flows in the workspace</option> : null}
            {flows.map((candidate) => (
              <option key={candidate.path} value={candidate.path}>
                {candidate.path}
              </option>
            ))}
            {initial && !flows.some((candidate) => candidate.path === initial.flow) ? (
              <option value={initial.flow}>{initial.flow}</option>
            ) : null}
          </Select>
        </Field>

        <ScheduleCronEditor
          value={cron}
          onChange={setCron}
          {...(debounceMs === undefined ? {} : { debounceMs })}
        />

        <div className={styles.pair}>
          <Field label="Runtime" htmlFor={runtimeId} hint="Threads for I/O, processes for CPU.">
            <Select
              id={runtimeId}
              value={runtime}
              onChange={(event) => setRuntime(event.target.value as Runtime)}
            >
              {RUNTIMES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sample" htmlFor={sampleId} hint="Optional: a sample saved with the flow.">
            <TextInput
              id={sampleId}
              value={sample}
              placeholder="None"
              autoComplete="off"
              onChange={(event) => setSample(event.target.value)}
            />
          </Field>
        </div>

        {/* Enter submits the form; the footer button is the one people click. */}
        <button type="submit" className={styles.hiddenSubmit} tabIndex={-1} aria-hidden="true">
          Save
        </button>
      </form>
    </Dialog>
  );
}
