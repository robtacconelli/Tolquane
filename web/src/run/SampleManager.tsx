import { useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { saveLayout } from '../api/flows';
import { Button } from '../components/Button';
import { Field, TextInput } from '../components/form/Controls';
import { Dialog } from '../components/form/Dialog';
import type { Sample } from '../model';
import { useFlowStore } from '../store/flow';
import { itemsToText, parseItems, uniqueName } from './samples';
import styles from './RunButton.module.css';

/*
 * Managing the samples of the open flow: add, rename, edit, delete, save the sidecar.
 *
 * The text box holds the text a person is typing, not a rendering of the items, so an
 * empty line in the middle survives being typed; the items are parsed out of it on the
 * way to the sidecar (`src/run/samples.ts`).
 */

export function SampleManager({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}): JSX.Element {
  const layout = useFlowStore((state) => state.layout);
  const [samples, setSamples] = useState<Sample[]>(() =>
    layout.samples.map((sample) => ({ ...sample })),
  );
  const [draft, setDraft] = useState<{ index: number; text: string }>(() => ({
    index: layout.samples.length > 0 ? 0 : -1,
    text: layout.samples[0] ? itemsToText(layout.samples[0].items) : '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const index = draft.index;
  const current = index >= 0 ? samples[index] : undefined;

  function show(at: number): void {
    const sample = samples[at];
    setDraft({ index: at, text: sample ? itemsToText(sample.items) : '' });
  }

  function rename(name: string): void {
    setSamples((all) => all.map((sample, i) => (i === index ? { ...sample, name } : sample)));
  }

  function retype(text: string): void {
    setDraft({ index, text });
    const items = parseItems(text);
    setSamples((all) => all.map((sample, i) => (i === index ? { ...sample, items } : sample)));
  }

  function add(): void {
    const sample: Sample = { name: uniqueName(samples, 'sample'), items: [] };
    setSamples((all) => [...all, sample]);
    setDraft({ index: samples.length, text: '' });
  }

  function remove(at: number): void {
    const left = samples.filter((_, i) => i !== at);
    setSamples(left);
    const next = Math.min(at, left.length - 1);
    const sample = left[next];
    setDraft({ index: next, text: sample ? itemsToText(sample.items) : '' });
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    const named = samples.filter((sample) => sample.name.trim() !== '');
    const next = { ...layout, samples: named };
    try {
      await saveLayout(path, next);
      // The sidecar on disk is now this one, so the store's copy has to be it too.
      useFlowStore.setState({ layout: next });
      onClose();
    } catch (failure: unknown) {
      setError(failure instanceof ApiError ? failure.message : 'Could not save the samples');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Samples"
      description="Inputs saved with the flow, in its layout sidecar. Running with one replaces the flow’s own source."
      width={620}
      onClose={onClose}
      footer={
        <>
          {error ? <span className={styles.error}>{error}</span> : null}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save samples'}
          </Button>
        </>
      }
    >
      <div className={styles.editor}>
        <div className={styles.samples}>
          {samples.map((sample, at) => (
            <div
              key={at}
              className={at === index ? `${styles.sample} ${styles.sampleActive}` : styles.sample}
            >
              <button
                type="button"
                className={styles.sampleName}
                onClick={() => {
                  show(at);
                }}
              >
                {sample.name || 'unnamed'}
              </button>
              <span className={styles.sampleCount}>
                {sample.items.length} {sample.items.length === 1 ? 'item' : 'items'}
              </span>
              <button
                type="button"
                className={styles.remove}
                onClick={() => {
                  remove(at);
                }}
                aria-label={`Delete ${sample.name}`}
              >
                Delete
              </button>
            </div>
          ))}
          {samples.length === 0 ? (
            <p className={styles.rowHint}>
              No samples yet. Add one and give it a few lines to try the flow on.
            </p>
          ) : null}
        </div>

        <Button onClick={add}>Add a sample</Button>

        {current ? (
          <>
            <Field label="Name" htmlFor="sample-name">
              <TextInput
                id="sample-name"
                data-autofocus
                value={current.name}
                onChange={(event) => {
                  rename(event.target.value);
                }}
              />
            </Field>
            <Field
              label="Items"
              htmlFor="sample-items"
              hint="One item per line. A line that is valid JSON is used as that value; anything else is the line itself."
            >
              <textarea
                id="sample-items"
                className={styles.textarea}
                spellCheck={false}
                value={draft.text}
                onChange={(event) => {
                  retype(event.target.value);
                }}
              />
            </Field>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
