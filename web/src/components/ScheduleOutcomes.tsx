import type { JSX } from 'react';
import {
  NOTIFY_EVENTS,
  type DeliveryResult,
  type Notify,
  type NotifyEvent,
} from '../api/schedules';
import { Button } from './Button';
import { Icon } from './Icon';
import { CheckLine, Field, NumberInput, TextInput } from './form/Controls';
import { emailsError } from './scheduleNotify';
import styles from './ScheduleOutcomes.module.css';

/*
 * What happens when a scheduled run ends: who is told, and how many times it is tried
 * again first (docs/web-interfaces.md, N).
 *
 * The four events are chips rather than a multi-select, because the question is "tell me
 * when it fails" and the answer is one click. A schedule with no event chosen tells
 * nobody, which is the default and is not a mistake -- so nothing here nags about it.
 */

const EVENT_LABEL: Record<NotifyEvent, string> = {
  failed: 'Failed',
  deadlock: 'Deadlock',
  cancelled: 'Cancelled',
  done: 'Done',
};

const RETRY_OPTIONS = [0, 1, 2, 3, 4, 5] as const;

export interface OutcomesValue {
  notify: Notify;
  retries: number;
  retryDelay: string;
  /** The addresses as typed, so a half-written one is not thrown away on every stroke. */
  emails: string;
  /** True while the webhook field is empty on purpose: the default from Settings. */
  useDefaultWebhook: boolean;
  webhook: string;
}

export function ScheduleOutcomes({
  value,
  onChange,
  defaultWebhook,
  idPrefix,
  /** Only a schedule that exists can be tested: the route takes its id. */
  onTest,
  testing = false,
  results = null,
  testError = null,
}: {
  value: OutcomesValue;
  onChange: (value: OutcomesValue) => void;
  defaultWebhook: string | null;
  idPrefix: string;
  onTest?: () => void;
  testing?: boolean;
  results?: readonly DeliveryResult[] | null;
  testError?: string | null;
}): JSX.Element {
  const chosen = new Set(value.notify.events);
  const emailProblem = emailsError(value.emails);

  function toggle(event: NotifyEvent): void {
    const events = chosen.has(event)
      ? value.notify.events.filter((name) => name !== event)
      : NOTIFY_EVENTS.filter((name) => name === event || chosen.has(name));
    onChange({ ...value, notify: { ...value.notify, events } });
  }

  return (
    <div className={styles.outcomes}>
      <Field
        label="Tell me when a run is"
        hint="Nothing chosen means nobody is told; the run is still recorded."
      >
        <div className={styles.chips} role="group" aria-label="Tell me when a run is">
          {NOTIFY_EVENTS.map((event) => {
            const on = chosen.has(event);
            return (
              <button
                key={event}
                type="button"
                role="switch"
                aria-checked={on}
                className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                onClick={() => toggle(event)}
              >
                {on ? <Icon name="check" size={12} /> : null}
                {EVENT_LABEL[event]}
              </button>
            );
          })}
        </div>
      </Field>

      <Field
        label="Webhook"
        htmlFor={`${idPrefix}-webhook`}
        hint={
          value.useDefaultWebhook
            ? defaultWebhook
              ? `The default from Settings: ${defaultWebhook}`
              : 'No default is set in Settings, so nothing is posted.'
            : 'Posted the run, its busiest nodes and the last 2 KB of the log, as JSON.'
        }
        aside={
          <CheckLine
            id={`${idPrefix}-webhook-default`}
            checked={value.useDefaultWebhook}
            onChange={(checked) =>
              onChange({
                ...value,
                useDefaultWebhook: checked,
                webhook: checked ? '' : value.webhook,
              })
            }
          >
            Use the default
          </CheckLine>
        }
      >
        <TextInput
          id={`${idPrefix}-webhook`}
          mono
          aria-label="Webhook"
          autoComplete="off"
          spellCheck={false}
          disabled={value.useDefaultWebhook}
          placeholder={value.useDefaultWebhook ? (defaultWebhook ?? 'nothing set') : 'https://…'}
          value={value.useDefaultWebhook ? (defaultWebhook ?? '') : value.webhook}
          onChange={(event) => onChange({ ...value, webhook: event.target.value })}
        />
      </Field>

      <Field
        label="Email"
        htmlFor={`${idPrefix}-emails`}
        hint="Separated by commas. Needs the SMTP server in Settings; without it the attempt is recorded as failed."
        error={emailProblem}
      >
        <TextInput
          id={`${idPrefix}-emails`}
          aria-label="Email"
          autoComplete="off"
          spellCheck={false}
          invalid={Boolean(emailProblem)}
          placeholder="ops@example.com, me@example.com"
          value={value.emails}
          onChange={(event) => onChange({ ...value, emails: event.target.value })}
        />
      </Field>

      <div className={styles.pair}>
        <Field
          label="Retries"
          htmlFor={`${idPrefix}-retries`}
          hint="After a failure or a deadlock, never after a cancel."
        >
          <select
            id={`${idPrefix}-retries`}
            className={styles.select}
            value={String(value.retries)}
            onChange={(event) => onChange({ ...value, retries: Number(event.target.value) })}
          >
            {RETRY_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count === 0 ? 'None' : count === 1 ? 'Once' : `${String(count)} times`}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Wait between them"
          htmlFor={`${idPrefix}-delay`}
          hint="Seconds. The notification comes once, after the last attempt."
        >
          <NumberInput
            id={`${idPrefix}-delay`}
            aria-label="Wait between them"
            disabled={value.retries === 0}
            value={value.retryDelay}
            onChange={(event) => onChange({ ...value, retryDelay: event.target.value })}
          />
        </Field>
      </div>

      {onTest ? (
        <div className={styles.test}>
          <Button size="sm" onClick={onTest} disabled={testing}>
            <Icon name="bell" size={13} />
            {testing ? 'Sending…' : 'Send a test'}
          </Button>
          <span className={styles.testHint}>
            Sends the message this schedule would send, describing its last run.
          </span>
        </div>
      ) : null}

      {testError ? (
        <p className={styles.testError} role="alert">
          {testError}
        </p>
      ) : null}

      {results ? (
        <ul className={styles.results}>
          {results.length === 0 ? <li className={styles.result}>Nothing was sent.</li> : null}
          {results.map((result, index) => (
            <li
              key={`${result.channel}-${result.target}-${String(index)}`}
              className={styles.result}
            >
              <span
                className={result.status === 'sent' ? styles.resultOk : styles.resultBad}
                aria-hidden="true"
              />
              <span className={styles.resultTarget}>
                {result.channel} · {result.target}
              </span>
              <span className={styles.resultText}>{result.error ?? 'sent'}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
