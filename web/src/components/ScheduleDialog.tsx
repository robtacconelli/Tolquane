import { useEffect, useId, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { getFlow } from '../api/flows';
import type { FlowSummary } from '../api/flowsList';
import {
  RUNTIMES,
  testSchedule,
  type DeliveryResult,
  type Notify,
  type Runtime,
  type Schedule,
} from '../api/schedules';
import { getSettings } from '../api/settings';
import { EnvironmentRows } from '../inputs/EnvironmentRows';
import { ParameterFields, ParameterSection } from '../inputs/ParameterFields';
import {
  envRecord,
  envRows,
  paramFieldType,
  paramInitial,
  paramText,
  paramValue,
  type EnvRow,
} from '../inputs/params';
import type { FlowParam } from '../model/types';
import { Button } from './Button';
import { CheckLine, Field, Select, TextInput } from './form/Controls';
import { Dialog } from './form/Dialog';
import { ScheduleCronEditor } from './ScheduleCronEditor';
import { ScheduleOutcomes, type OutcomesValue } from './ScheduleOutcomes';
import { emailsError, emailsText, parseEmails } from './scheduleNotify';
import { DEFAULT_CRON } from './scheduleCron';
import styles from './ScheduleDialog.module.css';

export interface ScheduleFormValues {
  flow: string;
  cron: string;
  runtime: Runtime;
  sample: string | null;
  enabled: boolean;
  /** Section E: the keywords `build()` is called with, and the child's environment. */
  params: Record<string, unknown>;
  env: Record<string, string>;
  /** Section N: who is told when a run ends, and how hard the schedule tries first. */
  notify: Notify;
  retries: number;
  retry_delay: number;
}

const DEFAULT_RETRY_DELAY = 60;

/**
 * The one form for creating and editing a schedule. It owns the draft and the message
 * the server sends back; the page owns the request, so a 400 for a bad cron lands on
 * the field the reader is looking at.
 *
 * A schedule is a run that nobody watches, which is why it carries three more things
 * than the Run popover does: the inputs it is called with, whether anybody is told how
 * it went, and how many times it is retried first.
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
  const uid = useId();

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

  /* The inputs. The parameters a flow declares are read from its model, which means one
   * request per flow the picker lands on; the values already stored on the schedule win
   * over the file's own defaults. */
  const [params, setParams] = useState<FlowParam[]>([]);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<EnvRow[]>(() => envRows(initial?.env));

  const [outcomes, setOutcomes] = useState<OutcomesValue>(() => ({
    notify: initial?.notify ?? { events: [], webhook: null, emails: [] },
    retries: initial?.retries ?? 0,
    retryDelay: String(initial?.retry_delay ?? DEFAULT_RETRY_DELAY),
    emails: emailsText(initial?.notify.emails ?? []),
    useDefaultWebhook: !initial?.notify.webhook,
    webhook: initial?.notify.webhook ?? '',
  }));
  const [defaultWebhook, setDefaultWebhook] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<DeliveryResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  /* The default webhook is a setting, and the dialog shows it rather than making the
   * reader go and look: "use the default" is only an answer if you can see the default. */
  useEffect(() => {
    let cancelled = false;
    getSettings().then(
      (settings) => {
        if (!cancelled) setDefaultWebhook(settings.notifications.webhook_default);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /* Which parameters this flow takes. A flow that cannot be modelled has none to show,
   * and says so rather than pretending the section is empty. */
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    getFlow(flow).then(
      (detail) => {
        if (cancelled) return;
        const found = detail.model?.params ?? [];
        setParams(found);
        setParamsError(
          detail.model === null ? 'This flow cannot be modelled, so it takes no parameters.' : null,
        );
        // The values already on the schedule win over the file's own defaults, but only
        // for the flow they were saved against.
        const stored = initial?.flow === flow ? initial.params : {};
        const next: Record<string, string> = {};
        for (const param of found) {
          next[param.name] = paramText(paramFieldType(param), paramInitial(param, stored));
        }
        setTexts(next);
        setFieldErrors({});
      },
      (caught: unknown) => {
        if (cancelled) return;
        setParams([]);
        setParamsError(
          caught instanceof ApiError ? caught.message : 'That flow could not be read.',
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [flow, initial]);

  function valuesOf(): ScheduleFormValues {
    const values: Record<string, unknown> = {};
    for (const param of params) {
      const type = paramFieldType(param);
      values[param.name] = paramValue(type, texts[param.name] ?? '');
    }
    const webhook = outcomes.useDefaultWebhook ? null : outcomes.webhook.trim() || null;
    return {
      flow,
      cron: cron.trim(),
      runtime,
      sample: sample.trim() || null,
      enabled,
      params: values,
      env: envRecord(rows),
      notify: { events: outcomes.notify.events, webhook, emails: parseEmails(outcomes.emails) },
      retries: outcomes.retries,
      retry_delay: Number(outcomes.retryDelay) || DEFAULT_RETRY_DELAY,
    };
  }

  function submit(): void {
    if (!flow) {
      setError('Choose the flow this schedule runs.');
      return;
    }
    if (!cron.trim()) {
      setError('Enter a cron expression.');
      return;
    }
    const badParam = Object.values(fieldErrors).find(Boolean);
    if (badParam) {
      setError(badParam);
      return;
    }
    const badEmail = emailsError(outcomes.emails);
    if (badEmail) {
      setError(badEmail);
      return;
    }
    setSaving(true);
    setError(null);
    void onSubmit(valuesOf())
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setSaving(false));
  }

  function sendTest(): void {
    if (!initial) return;
    setTesting(true);
    setTestError(null);
    setResults(null);
    testSchedule(initial.id).then(
      (answer) => {
        setResults(answer.results);
        setTesting(false);
      },
      (caught: unknown) => {
        setTestError(caught instanceof Error ? caught.message : String(caught));
        setTesting(false);
      },
    );
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

        <span className={styles.divider} />

        <ParameterSection note={paramsError ?? undefined}>
          <ParameterFields
            params={params}
            values={texts}
            idPrefix={`${uid}-param`}
            onChange={(name, text, _value, problem) => {
              setTexts((current) => ({ ...current, [name]: text }));
              setFieldErrors((current) => ({ ...current, [name]: problem ?? '' }));
            }}
          />
        </ParameterSection>

        <ParameterSection title="Environment" note="Given to this schedule's runs">
          <EnvironmentRows rows={rows} idPrefix={`${uid}-env`} onChange={setRows} />
        </ParameterSection>

        <span className={styles.divider} />

        <ParameterSection title="Outcomes">
          <ScheduleOutcomes
            value={outcomes}
            onChange={setOutcomes}
            defaultWebhook={defaultWebhook}
            idPrefix={`${uid}-outcome`}
            {...(initial ? { onTest: sendTest } : {})}
            testing={testing}
            results={results}
            testError={testError}
          />
        </ParameterSection>

        {/* Enter submits the form; the footer button is the one people click. */}
        <button type="submit" className={styles.hiddenSubmit} tabIndex={-1} aria-hidden="true">
          Save
        </button>
      </form>
    </Dialog>
  );
}
