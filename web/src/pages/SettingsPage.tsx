import { useCallback, useEffect, useId, useState, type JSX, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { RUNTIMES, type Runtime } from '../api/schedules';
import {
  getSettings,
  putSettings,
  type AiProvider,
  type AiSettingsUpdate,
  type Settings,
  type SettingsUpdate,
} from '../api/settings';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Page, PageHeader, Panel, Segmented } from '../components/Page';
import { SettingsKeyBadge, SettingsKeyField } from '../components/SettingsKeyField';
import { SettingsRow, SettingsSection, SettingsStack } from '../components/SettingsSection';
import { StatusDot } from '../components/StatusDot';
import { NumberInput, Select, TextInput } from '../components/form/Controls';
import { NODE_STATE_LABEL, NODE_STATES } from '../components/nodeState';
import { useUiStore, type ThemeMode } from '../store/ui';
import styles from './Settings.module.css';

/* Settings are saved a section at a time: each panel knows whether what is on screen is
 * what the server holds, and a refused save says so where the reader is looking. Keys are
 * the exception to everything: they go out once and never come back (S4). */

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: ThemeMode; label: string }[];

const PROVIDERS: readonly { value: AiProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
];

type SectionId = 'workspace' | 'runs' | 'ai';

interface SectionState {
  saving: boolean;
  saved: boolean;
  error: string | null;
}

const IDLE: SectionState = { saving: false, saved: false, error: null };
const ALL_IDLE: Record<SectionId, SectionState> = { workspace: IDLE, runs: IDLE, ai: IDLE };

/** Numbers are held as text so a half-typed value is never silently turned into 0. */
interface Draft {
  workspace: string;
  default_runtime: Runtime;
  default_batch: string;
  exec_timeout: string;
  max_concurrent_runs: string;
  cancel_grace: string;
  provider: AiProvider;
  model: string;
  anthropic_key: string;
  openai_key: string;
}

const SECTION_OF: Record<keyof Draft, SectionId> = {
  workspace: 'workspace',
  default_runtime: 'runs',
  default_batch: 'runs',
  exec_timeout: 'runs',
  max_concurrent_runs: 'runs',
  cancel_grace: 'runs',
  provider: 'ai',
  model: 'ai',
  anthropic_key: 'ai',
  openai_key: 'ai',
};

const RULES = {
  default_batch: { min: 1, max: 100_000 },
  exec_timeout: { min: 1, max: 3600 },
  max_concurrent_runs: { min: 1, max: 64 },
  cancel_grace: { min: 0, max: 600 },
} as const;

type NumericField = keyof typeof RULES;

const NUMERIC_FIELDS = Object.keys(RULES) as NumericField[];

function numberError(value: string, field: NumericField): string | null {
  const text = value.trim();
  const rule = RULES[field];
  if (!text) return 'Enter a number.';
  if (!/^\d+$/.test(text)) return 'Whole numbers only.';
  const parsed = Number(text);
  if (parsed < rule.min || parsed > rule.max) {
    return `Between ${rule.min} and ${rule.max}.`;
  }
  return null;
}

function sectionDraft(section: SectionId, settings: Settings): Partial<Draft> {
  switch (section) {
    case 'workspace':
      return { workspace: settings.workspace };
    case 'runs':
      return {
        default_runtime: settings.default_runtime,
        default_batch: String(settings.default_batch),
        exec_timeout: String(settings.exec_timeout),
        max_concurrent_runs: String(settings.max_concurrent_runs),
        cancel_grace: String(settings.cancel_grace),
      };
    case 'ai':
      return {
        provider: settings.ai.provider,
        model: settings.ai.model ?? '',
        anthropic_key: '',
        openai_key: '',
      };
  }
}

function draftOf(settings: Settings): Draft {
  return {
    ...sectionDraft('workspace', settings),
    ...sectionDraft('runs', settings),
    ...sectionDraft('ai', settings),
  } as Draft;
}

function isDirty(section: SectionId, settings: Settings, draft: Draft): boolean {
  switch (section) {
    case 'workspace':
      return draft.workspace.trim() !== settings.workspace;
    case 'runs':
      return (
        draft.default_runtime !== settings.default_runtime ||
        NUMERIC_FIELDS.some((field) => draft[field].trim() !== String(settings[field]))
      );
    case 'ai':
      return (
        draft.provider !== settings.ai.provider ||
        draft.model.trim() !== (settings.ai.model ?? '') ||
        draft.anthropic_key !== '' ||
        draft.openai_key !== ''
      );
  }
}

function patchOf(section: SectionId, draft: Draft): SettingsUpdate {
  switch (section) {
    case 'workspace':
      return { workspace: draft.workspace.trim() };
    case 'runs':
      return {
        default_runtime: draft.default_runtime,
        default_batch: Number(draft.default_batch),
        exec_timeout: Number(draft.exec_timeout),
        max_concurrent_runs: Number(draft.max_concurrent_runs),
        cancel_grace: Number(draft.cancel_grace),
      };
    case 'ai': {
      const ai: AiSettingsUpdate = {
        provider: draft.provider,
        model: draft.model.trim() || null,
      };
      if (draft.anthropic_key) ai.anthropic_key = draft.anthropic_key;
      if (draft.openai_key) ai.openai_key = draft.openai_key;
      return { ai };
    }
  }
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A numeric setting with its unit and its own rule, shown under the field when broken. */
function NumberSetting({
  id,
  label,
  help,
  unit,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  help: ReactNode;
  unit?: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <SettingsRow label={label} help={help} htmlFor={id}>
      <span className={styles.withUnit}>
        <NumberInput
          id={id}
          className={styles.number}
          value={value}
          invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </span>
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </SettingsRow>
  );
}

export function SettingsPage(): JSX.Element {
  const uid = useId();
  const field = (name: string): string => `${uid}-${name}`;

  const themeMode = useUiStore((state) => state.themeMode);
  const setThemeMode = useUiStore((state) => state.setThemeMode);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [state, setState] = useState<Record<SectionId, SectionState>>(ALL_IDLE);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const next = await getSettings();
        if (cancelled) return;
        setSettings(next);
        setDraft(draftOf(next));
        setLoadError(null);
      } catch (caught) {
        if (cancelled) return;
        setSettings(null);
        setDraft(null);
        setLoadError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  function edit<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setState((current) => ({ ...current, [SECTION_OF[key]]: IDLE }));
  }

  function save(section: SectionId): void {
    if (!draft) return;
    setState((current) => ({
      ...current,
      [section]: { saving: true, saved: false, error: null },
    }));
    void putSettings(patchOf(section, draft))
      .then((next) => {
        setSettings(next);
        setDraft((current) => (current ? { ...current, ...sectionDraft(section, next) } : null));
        setState((current) => ({
          ...current,
          [section]: { saving: false, saved: true, error: null },
        }));
      })
      .catch((caught: unknown) => {
        setState((current) => ({
          ...current,
          [section]: { saving: false, saved: false, error: messageOf(caught) },
        }));
      });
  }

  function reset(section: SectionId): void {
    if (!settings) return;
    setDraft((current) => (current ? { ...current, ...sectionDraft(section, settings) } : null));
    setState((current) => ({ ...current, [section]: IDLE }));
  }

  function sectionProps(section: SectionId): {
    dirty: boolean;
    saving: boolean;
    saved: boolean;
    error: string | null;
    onSave: () => void;
    onReset: () => void;
  } {
    const current = state[section];
    return {
      dirty: settings && draft ? isDirty(section, settings, draft) : false,
      saving: current.saving,
      saved: current.saved,
      error: current.error,
      onSave: () => save(section),
      onReset: () => reset(section),
    };
  }

  const offline = loadError instanceof ApiError && loadError.isOffline;
  const numberErrors = draft
    ? {
        default_batch: numberError(draft.default_batch, 'default_batch'),
        exec_timeout: numberError(draft.exec_timeout, 'exec_timeout'),
        max_concurrent_runs: numberError(draft.max_concurrent_runs, 'max_concurrent_runs'),
        cancel_grace: numberError(draft.cancel_grace, 'cancel_grace'),
      }
    : null;

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Settings live in the Tolquane Web database next to your workspace. API keys are the exception: they are read from the environment or from a permissions-restricted settings file, never from the database."
      />

      {loadError ? (
        <Panel>
          <EmptyState
            title={offline ? 'The server is not running' : 'Settings could not be loaded'}
            body={
              offline ? (
                <>
                  Start it with <code>tolquane web</code>. Until then the theme below is still
                  yours: it is kept in this browser.
                </>
              ) : (
                loadError.message
              )
            }
            actions={<Button onClick={reload}>Try again</Button>}
          />
        </Panel>
      ) : null}

      {!settings && !loadError ? (
        <Panel>
          <p className={styles.loading}>Loading settings…</p>
        </Panel>
      ) : null}

      {settings && draft && numberErrors ? (
        <>
          <SettingsSection
            title="Workspace"
            note="Flows are files: moving the workspace changes which ones this server can see."
            {...sectionProps('workspace')}
          >
            <SettingsRow
              label="Workspace directory"
              htmlFor={field('workspace')}
              help="Where flows are read from and written to. Runs use it as their working directory, and a flow outside it cannot be opened."
            >
              <TextInput
                id={field('workspace')}
                mono
                spellCheck={false}
                autoComplete="off"
                value={draft.workspace}
                onChange={(event) => edit('workspace', event.target.value)}
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection
            title="Runs"
            note="Applied to the next run; a run already in flight keeps the values it started with."
            invalid={Object.values(numberErrors).some(Boolean)}
            {...sectionProps('runs')}
          >
            <SettingsRow
              label="Default runtime"
              htmlFor={field('runtime')}
              help="Used by a new flow and by any run or schedule that does not choose one. Threads suit I/O, processes suit CPU work, sync is for debugging."
            >
              <Select
                id={field('runtime')}
                value={draft.default_runtime}
                onChange={(event) => edit('default_runtime', event.target.value as Runtime)}
              >
                {RUNTIMES.map((runtime) => (
                  <option key={runtime} value={runtime}>
                    {runtime}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <NumberSetting
              id={field('batch')}
              label="Default batch"
              help="How many items a stage takes from its input at a time. Larger batches trade latency for throughput."
              unit="items"
              value={draft.default_batch}
              error={numberErrors.default_batch}
              onChange={(value) => edit('default_batch', value)}
            />

            <NumberSetting
              id={field('timeout')}
              label="Execution timeout"
              help="How long the server waits for the child process that parses, checks, draws or optimizes a flow."
              unit="seconds"
              value={draft.exec_timeout}
              error={numberErrors.exec_timeout}
              onChange={(value) => edit('exec_timeout', value)}
            />

            <NumberSetting
              id={field('concurrent')}
              label="Concurrent runs"
              help="How many flows may run at once. Beyond this the server refuses a new run rather than thrashing."
              unit="runs"
              value={draft.max_concurrent_runs}
              error={numberErrors.max_concurrent_runs}
              onChange={(value) => edit('max_concurrent_runs', value)}
            />

            <NumberSetting
              id={field('grace')}
              label="Cancel grace"
              help="After a cancel, how long a run has to stop on its own before it is killed."
              unit="seconds"
              value={draft.cancel_grace}
              error={numberErrors.cancel_grace}
              onChange={(value) => edit('cancel_grace', value)}
            />
          </SettingsSection>

          <SettingsSection
            title="AI builder"
            description="Keys are written to the Tolquane Web configuration file with owner-only permissions (mode 600), or read from ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment. They never enter the database, never appear in a flow, and are never sent back to this page."
            note="The builder is the same tolquane.ai.Builder the command line uses."
            {...sectionProps('ai')}
          >
            <SettingsRow
              label="Provider"
              htmlFor={field('provider')}
              help="Which service the builder talks to when it writes or changes a flow."
            >
              <Select
                id={field('provider')}
                value={draft.provider}
                onChange={(event) => edit('provider', event.target.value as AiProvider)}
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.value} value={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <SettingsRow
              label="Model"
              htmlFor={field('model')}
              help="Leave empty to use the provider's default for the builder."
            >
              <TextInput
                id={field('model')}
                mono
                spellCheck={false}
                autoComplete="off"
                placeholder="provider default"
                value={draft.model}
                onChange={(event) => edit('model', event.target.value)}
              />
            </SettingsRow>

            <SettingsRow
              label="Anthropic key"
              htmlFor={field('anthropic')}
              aside={<SettingsKeyBadge isSet={settings.ai.has_anthropic_key} />}
              help="Sent once when you save this section. The server reports only whether a key is stored."
            >
              <SettingsKeyField
                id={field('anthropic')}
                label="Anthropic key"
                isSet={settings.ai.has_anthropic_key}
                value={draft.anthropic_key}
                onChange={(value) => edit('anthropic_key', value)}
              />
            </SettingsRow>

            <SettingsRow
              label="OpenAI key"
              htmlFor={field('openai')}
              aside={<SettingsKeyBadge isSet={settings.ai.has_openai_key} />}
              help="Sent once when you save this section. The server reports only whether a key is stored."
            >
              <SettingsKeyField
                id={field('openai')}
                label="OpenAI key"
                isSet={settings.ai.has_openai_key}
                value={draft.openai_key}
                onChange={(value) => edit('openai_key', value)}
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection
            title="Server"
            hint="Read-only"
            note={
              <>
                Host, port and token are start-up options: restart with{' '}
                <code>tolquane web --host … --port … --token …</code> to change them. Without a
                token the server binds to loopback only.
              </>
            }
          >
            <SettingsRow
              label="Bind address"
              help="127.0.0.1 keeps the server on this machine, which is why it needs no login."
            >
              <span className={styles.readonly}>
                {settings.server.host}:{settings.server.port}
              </span>
            </SettingsRow>
            <SettingsRow
              label="Access token"
              aside={<SettingsKeyBadge isSet={settings.server.token_set} />}
              help="Required on every request when the server is bound to anything but loopback."
            >
              <span className={styles.readonly}>
                {settings.server.token_set ? 'Required on every request' : 'Not required'}
              </span>
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}

      <SettingsSection
        title="Appearance"
        note="Kept in this browser, not on the server, so two people on the same machine can differ."
      >
        <SettingsRow
          label="Theme"
          help="System follows your operating system. Your choice is remembered in this browser."
        >
          <span className={styles.themeControl}>
            <Segmented
              label="Theme"
              options={THEME_OPTIONS}
              value={themeMode}
              onChange={setThemeMode}
            />
          </span>
        </SettingsRow>

        <SettingsStack
          label="Run states"
          help="The five colours a node takes on the canvas while a flow runs. Waiting means back pressure, not an error."
        >
          <div className={styles.legend}>
            {NODE_STATES.map((nodeState) => (
              <span key={nodeState} className={styles.chip}>
                <StatusDot state={nodeState} />
                {NODE_STATE_LABEL[nodeState]}
              </span>
            ))}
          </div>
        </SettingsStack>
      </SettingsSection>
    </Page>
  );
}
