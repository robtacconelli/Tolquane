import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { cancelRun, startRun } from '../api/runs';
import { RUNTIMES, type Runtime } from '../api/schedules';
import { Button } from '../components/Button';
import { Field, Select, Toggle } from '../components/form/Controls';
import { Icon } from '../components/Icon';
import { useRunEvents } from '../hooks/useRunEvents';
import { MOD_KEY } from '../platform';
import { useFlowStore } from '../store/flow';
import { useRunStore } from '../store/run';
import { formatDuration } from './format';
import { runAliases } from './keys';
import { SampleManager } from './SampleManager';
import styles from './RunButton.module.css';

/*
 * Run and cancel, and the handful of choices a run has.
 *
 * The button is the run's state: Run when there is nothing going, a stop square and a
 * ticking clock while the child process works, Run again with the result beside it
 * afterwards. The caret opens everything else -- the input, the runtime, taps, a trace --
 * because those are decided once and then left alone, and the toolbar has better things
 * to spend its width on.
 *
 * The flow is saved before it runs: the server runs the file on disk, not the canvas.
 */

const RUNTIME_HINT: Record<Runtime, string> = {
  threads: 'One thread per node; the default.',
  processes: 'Every farm worker in its own process.',
  sync: 'One node at a time, deterministic.',
};

const TAP_ITEMS = 5;

export function RunButton({
  path,
  ready,
  onBeforeRun,
}: {
  path: string;
  /** False while the flow is still opening, or did not open at all. */
  ready: boolean;
  /** The editor page's save; a run always uses the file on disk. */
  onBeforeRun?: () => Promise<void>;
}): JSX.Element {
  const status = useRunStore((state) => state.status);
  const runId = useRunStore((state) => state.runId);
  const options = useRunStore((state) => state.options);
  const startRunInStore = useRunStore((state) => state.start);
  const setAliases = useRunStore((state) => state.setAliases);
  const runGraph = useRunStore((state) => state.graph);
  const elapsed = useRunStore((state) => state.elapsed);
  const startedAt = useRunStore((state) => state.startedAt);

  const samples = useFlowStore((state) => state.layout.samples);
  const model = useFlowStore((state) => state.model);
  const flowGraph = useFlowStore((state) => state.graph);

  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const group = useRef<HTMLDivElement>(null);

  const running = status === 'running';

  // Everything the run reports is named after threads; the canvas names blocks.
  useEffect(() => {
    setAliases(runAliases(model, runGraph ?? flowGraph));
  }, [model, runGraph, flowGraph, setAliases]);

  // A different flow is open: its run is not this one's.
  useEffect(() => {
    const current = useRunStore.getState();
    if (current.options.path !== null && current.options.path !== path) current.reset();
  }, [path]);

  useRunEvents(runId);

  // The clock on the button, between the half-second snapshots.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 200);
    return () => {
      window.clearInterval(timer);
    };
  }, [running]);

  const begin = useCallback(async (): Promise<void> => {
    if (!ready || busy) return;
    const chosen = useRunStore.getState().options;
    setBusy(true);
    setError(null);
    try {
      if (onBeforeRun && useFlowStore.getState().dirty) {
        await onBeforeRun();
        if (useFlowStore.getState().dirty) {
          setError('The flow could not be saved, so it was not run.');
          setOpen(true);
          return;
        }
      }
      const run = await startRun({
        path,
        runtime: chosen.runtime,
        sample: chosen.sample,
        tap: chosen.tap,
        trace: chosen.trace,
      });
      startRunInStore(run.id, { ...chosen, path });
      setOpen(false);
    } catch (failure: unknown) {
      const message =
        failure instanceof ApiError
          ? failure.status === 429
            ? `${failure.message} Wait for one to finish, or raise the limit in Settings.`
            : failure.message
          : 'The run could not be started';
      setError(message);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }, [busy, onBeforeRun, path, ready, startRunInStore]);

  const stop = useCallback(async (): Promise<void> => {
    const id = useRunStore.getState().runId;
    if (id === null) return;
    setBusy(true);
    try {
      // The child gets a SIGTERM; its own `done` event, with status `cancelled`, is
      // what moves the button and the cards, so there is nothing to set here.
      await cancelRun(id);
    } catch (failure: unknown) {
      setError(failure instanceof ApiError ? failure.message : 'The run could not be cancelled');
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }, []);

  // Cmd/Ctrl+Enter runs, wherever the focus is, as long as it is not in a text field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
      const target = event.target;
      if (target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      if (useRunStore.getState().status === 'running') void stop();
      else void begin();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [begin, stop]);

  // The popover closes on Escape and on a click anywhere else, like a menu.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent): void {
      if (event.target instanceof Node && group.current?.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const clock =
    running && startedAt !== null
      ? formatDuration(Math.max(elapsed, (now - startedAt) / 1000))
      : null;
  const sampleMissing = options.sample !== null && !samples.some((s) => s.name === options.sample);

  return (
    <div className={styles.group} ref={group}>
      <Button
        variant="primary"
        size="sm"
        className={styles.main}
        disabled={!ready || busy}
        onClick={() => (running ? void stop() : void begin())}
        title={running ? 'Cancel this run' : 'Run this flow'}
      >
        {running ? (
          <>
            <span className={styles.stop} aria-hidden="true" />
            Cancel
            <span className={styles.clock}>{clock}</span>
          </>
        ) : (
          <>
            <Icon name="play" size={15} />
            {busy ? 'Starting…' : 'Run'}
          </>
        )}
      </Button>
      <Button
        variant="primary"
        size="sm"
        className={styles.caret}
        aria-label="Run options"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <Icon name="chevronDown" size={14} />
      </Button>

      {open ? (
        <div className={styles.popover} role="dialog" aria-label="Run options">
          <span className={styles.popoverTitle}>Run {path || 'this flow'}</span>

          {error ? <p className={styles.error}>{error}</p> : null}

          <Field
            label="Input"
            htmlFor="run-sample"
            hint={
              options.sample === null
                ? 'The flow’s own source node.'
                : sampleMissing
                  ? 'That sample is gone; the flow’s own source will be used.'
                  : 'Handed to build(source=…) instead of the source node.'
            }
            aside={
              <button
                type="button"
                className={styles.manage}
                onClick={() => {
                  setManaging(true);
                  setOpen(false);
                }}
              >
                Manage samples
              </button>
            }
          >
            <Select
              id="run-sample"
              value={options.sample ?? ''}
              onChange={(event) => {
                useRunStore.setState((state) => ({
                  options: { ...state.options, sample: event.target.value || null },
                }));
              }}
            >
              <option value="">The flow’s own source</option>
              {samples.map((sample) => (
                <option key={sample.name} value={sample.name}>
                  {sample.name} · {sample.items.length} items
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Runtime" htmlFor="run-runtime" hint={RUNTIME_HINT[options.runtime]}>
            <Select
              id="run-runtime"
              value={options.runtime}
              onChange={(event) => {
                useRunStore.setState((state) => ({
                  options: { ...state.options, runtime: event.target.value as Runtime },
                }));
              }}
            >
              {RUNTIMES.map((runtime) => (
                <option key={runtime} value={runtime}>
                  {runtime}
                </option>
              ))}
            </Select>
          </Field>

          <span className={styles.divider} />

          <div className={styles.row}>
            <span className={styles.rowText}>
              <span className={styles.rowLabel}>Tap items</span>
              <span className={styles.rowHint}>
                Keep the last {TAP_ITEMS} items of every edge, for the Taps tab.
              </span>
            </span>
            <Toggle
              label="Tap items"
              checked={options.tap > 0}
              onChange={(on) => {
                useRunStore.setState((state) => ({
                  options: { ...state.options, tap: on ? TAP_ITEMS : 0 },
                }));
              }}
            />
          </div>

          <div className={styles.row}>
            <span className={styles.rowText}>
              <span className={styles.rowLabel}>Chrome trace</span>
              <span className={styles.rowHint}>
                Write a trace file to open in Perfetto; downloadable from the report.
              </span>
            </span>
            <Toggle
              label="Chrome trace"
              checked={options.trace}
              onChange={(on) => {
                useRunStore.setState((state) => ({
                  options: { ...state.options, trace: on },
                }));
              }}
            />
          </div>

          <span className={styles.divider} />

          <div className={styles.footer}>
            <span className={styles.hint}>
              <span className={styles.kbd}>{MOD_KEY}</span> <span className={styles.kbd}>↵</span>{' '}
              runs
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={!ready || busy}
              onClick={() => (running ? void stop() : void begin())}
            >
              {running ? 'Cancel' : 'Run now'}
            </Button>
          </div>
        </div>
      ) : null}

      {managing ? (
        <SampleManager
          path={path}
          onClose={() => {
            setManaging(false);
          }}
        />
      ) : null}
    </div>
  );
}
