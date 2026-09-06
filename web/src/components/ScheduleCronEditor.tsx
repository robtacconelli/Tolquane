import { useEffect, useId, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { previewCron, type CronPreview } from '../api/schedules';
import { Icon } from './Icon';
import { Field, Select, TextInput } from './form/Controls';
import {
  buildCron,
  detectPreset,
  PRESETS,
  STEPS,
  WEEKDAYS,
  type CronParams,
  type PresetId,
} from './scheduleCron';
import { splitWhen, zoneLabel } from './scheduleFormat';
import styles from './ScheduleCronEditor.module.css';

/* Presets for the six schedules people actually ask for, the expression itself always
 * visible and editable, and the server's own reading of it underneath: the preview comes
 * from `POST /api/schedules/preview`, so what the page promises and what the scheduler
 * will do come out of the same parser. */

/** What the last answered expression said; `cron` is the expression it answers for. */
interface PreviewState {
  cron: string;
  preview: CronPreview | null;
  error: string | null;
}

interface PreviewView {
  preview: CronPreview | null;
  error: string | null;
  loading: boolean;
}

/**
 * Debounced, and aborted on every keystroke: the server parses, we only display. The
 * result carries the expression it belongs to, so "still typing" is a comparison rather
 * than a second piece of state, and the last good answer stays on screen meanwhile.
 */
function useCronPreview(cron: string, debounceMs: number): PreviewView {
  const [result, setResult] = useState<PreviewState>({ cron: '', preview: null, error: null });
  const expression = cron.trim();

  useEffect(() => {
    const wanted = cron.trim();
    if (!wanted) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewCron(wanted, { signal: controller.signal })
        .then((preview) => setResult({ cron: wanted, preview, error: null }))
        .catch((caught: unknown) => {
          if (caught instanceof ApiError && caught.code === 'aborted') return;
          setResult({
            cron: wanted,
            preview: null,
            error: caught instanceof Error ? caught.message : String(caught),
          });
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort('caller');
    };
  }, [cron, debounceMs]);

  const fresh = result.cron === expression;
  return {
    preview: expression ? result.preview : null,
    // A message about an older expression would point at text that is no longer there.
    error: expression && fresh ? result.error : null,
    loading: Boolean(expression) && !fresh,
  };
}

export function ScheduleCronEditor({
  value,
  onChange,
  debounceMs = 350,
}: {
  value: string;
  onChange: (cron: string) => void;
  debounceMs?: number;
}): JSX.Element {
  const fieldId = useId();
  const [initial] = useState(() => detectPreset(value));
  const [preset, setPreset] = useState<PresetId>(initial.preset);
  const [params, setParams] = useState<CronParams>(initial.params);
  const { preview, error, loading } = useCronPreview(value, debounceMs);

  function apply(nextPreset: PresetId, nextParams: CronParams): void {
    setPreset(nextPreset);
    setParams(nextParams);
    const cron = buildCron(nextPreset, nextParams);
    if (cron) onChange(cron);
  }

  function edit(text: string): void {
    onChange(text);
    const read = detectPreset(text);
    setPreset(read.preset);
    if (read.preset !== 'custom') setParams(read.params);
  }

  return (
    <div className={styles.editor}>
      <div className={styles.chips} role="group" aria-label="Schedule presets">
        {PRESETS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={[styles.chip, option.id === preset ? styles.chipActive : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={option.id === preset}
            onClick={() => apply(option.id, params)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {preset !== 'custom' && preset !== 'hourly' ? (
        <div className={styles.params}>
          {preset === 'minutes' ? (
            <>
              <span className={styles.word}>Every</span>
              <span className={styles.control}>
                <Select
                  aria-label="Minutes between runs"
                  value={String(params.step)}
                  onChange={(event) =>
                    apply(preset, { ...params, step: Number(event.target.value) })
                  }
                >
                  {STEPS.map((step) => (
                    <option key={step} value={step}>
                      {step}
                    </option>
                  ))}
                </Select>
              </span>
              <span className={styles.word}>minutes</span>
            </>
          ) : null}

          {preset === 'weekly' ? (
            <>
              <span className={styles.word}>On</span>
              <span className={styles.controlWide}>
                <Select
                  aria-label="Day of the week"
                  value={params.weekday}
                  onChange={(event) => apply(preset, { ...params, weekday: event.target.value })}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day.value} value={day.value}>
                      {day.label}
                    </option>
                  ))}
                </Select>
              </span>
            </>
          ) : null}

          {preset === 'monthly' ? (
            <>
              <span className={styles.word}>On day</span>
              <span className={styles.control}>
                <Select
                  aria-label="Day of the month"
                  value={params.day}
                  onChange={(event) => apply(preset, { ...params, day: event.target.value })}
                >
                  {Array.from({ length: 28 }, (_, index) => String(index + 1)).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </Select>
              </span>
            </>
          ) : null}

          {preset !== 'minutes' ? (
            <>
              <span className={styles.word}>at</span>
              <span className={styles.control}>
                <TextInput
                  type="time"
                  aria-label="Time of day"
                  value={params.time}
                  onChange={(event) => apply(preset, { ...params, time: event.target.value })}
                />
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      <Field label="Cron expression" htmlFor={fieldId} error={error}>
        <TextInput
          id={fieldId}
          mono
          invalid={Boolean(error)}
          spellCheck={false}
          autoComplete="off"
          placeholder="*/15 * * * *"
          value={value}
          onChange={(event) => edit(event.target.value)}
        />
      </Field>

      <div
        className={styles.preview}
        data-loading={loading || undefined}
        data-filled={preview ? true : undefined}
        aria-live="polite"
      >
        {preview ? (
          <>
            <div className={styles.previewHead}>
              <Icon name="clock" size={15} />
              <span className={styles.description}>{preview.description}</span>
            </div>
            <ol className={styles.times}>
              {preview.next_five.map((iso) => {
                const parts = splitWhen(iso);
                return (
                  <li key={iso} className={styles.time}>
                    <span className={styles.timeDay}>{parts?.day ?? '—'}</span>
                    <span className={styles.timeClock}>{parts?.time ?? iso}</span>
                  </li>
                );
              })}
            </ol>
            <p className={styles.zone}>The next five times, in {zoneLabel()}.</p>
          </>
        ) : (
          <div className={styles.previewIdle}>
            {error
              ? 'Fix the expression to see when it will run.'
              : 'Five fields: minute, hour, day of month, month, day of week. The next five times appear here as you type.'}
          </div>
        )}
      </div>
    </div>
  );
}
