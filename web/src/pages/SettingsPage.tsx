import { useCallback, useEffect, useId, useState, type JSX, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { apiToken, setApiToken } from '../api/token';
import { RUNTIMES, type Runtime } from '../api/schedules';
import {
  getSettings,
  putSettings,
  type AiProvider,
  type AiSettingsUpdate,
  type NotificationsUpdate,
  type Settings,
  type SettingsUpdate,
} from '../api/settings';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Page, PageHeader, Panel, Segmented } from '../components/Page';
import { SettingsKeyBadge, SettingsKeyField } from '../components/SettingsKeyField';
import { SettingsRow, SettingsSection, SettingsStack } from '../components/SettingsSection';
import { StatusDot } from '../components/StatusDot';
import { CheckLine, NumberInput, Select, TextInput } from '../components/form/Controls';
import { NODE_STATE_LABEL, NODE_STATES } from '../components/nodeState';
import { EnvironmentRows } from '../inputs/EnvironmentRows';
import { envRecord, envRows, type EnvRow } from '../inputs/params';
import { useUiStore, type ThemeMode } from '../store/ui';
import styles from './Settings.module.css';

/* Settings are saved a section at a time: each panel knows whether what is on screen is
 * what the server holds, and a refused save says so where the reader is looking. Keys are
 * the exception to everything: they go out once and never come back (S4), and so does the
 * SMTP password (N). Three fields answer `null` to a member rather than a value -- the
 * server block, the `has_*` flags and the workspace environment, whose names arrive in
 * `env_names` instead -- so a member sees the names and not the values, and no section
 * that is not theirs at all. */

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: ThemeMode; label: string }[];

const PROVIDERS: readonly { value: AiProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
];

type SectionId = 'workspace' | 'interpreter' | 'runs' | 'history' | 'notifications' | 'ai';

interface SectionState {
  saving: boolean;
  saved: boolean;
  error: string | null;
}

const IDLE: SectionState = { saving: false, saved: false, error: null };
const ALL_IDLE: Record<SectionId, SectionState> = {
  workspace: IDLE,
  interpreter: IDLE,
  runs: IDLE,
  history: IDLE,
  notifications: IDLE,
  ai: IDLE,
};

/** Numbers are held as text so a half-typed value is never silently turned into 0. */
interface Draft {
  workspace: string;
  env: EnvRow[];
  python: string;
  default_runtime: Runtime;
  default_batch: string;
  exec_timeout: string;
  max_concurrent_runs: string;
  cancel_grace: string;
  auto_commit: boolean;
  webhook_default: string;
  smtp_host: string;
  smtp_port: string;
  smtp_username: string;
  smtp_from: string;
  smtp_starttls: boolean;
  smtp_password: string;
  provider: AiProvider;
  model: string;
  anthropic_key: string;
  openai_key: string;
}

const SECTION_OF: Record<keyof Draft, SectionId> = {
  workspace: 'workspace',
  env: 'workspace',
  python: 'interpreter',
  default_runtime: 'runs',
  default_batch: 'runs',
  exec_timeout: 'runs',
  max_concurrent_runs: 'runs',
  cancel_grace: 'runs',
  auto_commit: 'history',
  webhook_default: 'notifications',
  smtp_host: 'notifications',
  smtp_port: 'notifications',
  smtp_username: 'notifications',
  smtp_from: 'notifications',
  smtp_starttls: 'notifications',
  smtp_password: 'notifications',
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

function inRange(value: string, min: number, max: number): string | null {
  const text = value.trim();
  if (!text) return 'Enter a number.';
  if (!/^\d+$/.test(text)) return 'Whole numbers only.';
  const parsed = Number(text);
  return parsed < min || parsed > max ? `Between ${min} and ${max}.` : null;
}

function numberError(value: string, field: NumericField): string | null {
  return inRange(value, RULES[field].min, RULES[field].max);
}

/** The SMTP port, which only has to be one when there is a server to send through. */
function portError(draft: Draft): string | null {
  return draft.smtp_host.trim() ? inRange(draft.smtp_port, 1, 65535) : null;
}

/** Two objects with the same names and the same values: an environment that has not moved. */
function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every((name) => name in b && a[name] === b[name]);
}

function sectionDraft(section: SectionId, settings: Settings): Partial<Draft> {
  switch (section) {
    case 'workspace':
      return { workspace: settings.workspace, env: envRows(settings.env) };
    case 'interpreter':
      return { python: settings.python };
    case 'runs':
      return {
        default_runtime: settings.default_runtime,
        default_batch: String(settings.default_batch),
        exec_timeout: String(settings.exec_timeout),
        max_concurrent_runs: String(settings.max_concurrent_runs),
        cancel_grace: String(settings.cancel_grace),
      };
    case 'history':
      return { auto_commit: settings.auto_commit };
    case 'notifications': {
      const smtp = settings.notifications.smtp;
      return {
        webhook_default: settings.notifications.webhook_default ?? '',
        smtp_host: smtp?.host ?? '',
        smtp_port: String(smtp?.port ?? 587),
        smtp_username: smtp?.username ?? '',
        smtp_from: smtp?.from ?? '',
        smtp_starttls: smtp?.starttls ?? true,
        smtp_password: '',
      };
    }
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
    ...sectionDraft('interpreter', settings),
    ...sectionDraft('runs', settings),
    ...sectionDraft('history', settings),
    ...sectionDraft('notifications', settings),
    ...sectionDraft('ai', settings),
  } as Draft;
}

function isDirty(section: SectionId, settings: Settings, draft: Draft): boolean {
  switch (section) {
    case 'workspace':
      return (
        draft.workspace.trim() !== settings.workspace ||
        (settings.env !== null && !sameEnv(envRecord(draft.env), settings.env))
      );
    case 'interpreter':
      return draft.python.trim() !== settings.python;
    case 'runs':
      return (
        draft.default_runtime !== settings.default_runtime ||
        NUMERIC_FIELDS.some((field) => draft[field].trim() !== String(settings[field]))
      );
    case 'history':
      return draft.auto_commit !== settings.auto_commit;
    case 'notifications': {
      const smtp = settings.notifications.smtp;
      return (
        draft.webhook_default.trim() !== (settings.notifications.webhook_default ?? '') ||
        draft.smtp_host.trim() !== (smtp?.host ?? '') ||
        draft.smtp_port.trim() !== String(smtp?.port ?? 587) ||
        draft.smtp_username.trim() !== (smtp?.username ?? '') ||
        draft.smtp_from.trim() !== (smtp?.from ?? '') ||
        draft.smtp_starttls !== (smtp?.starttls ?? true) ||
        draft.smtp_password !== ''
      );
    }
    case 'ai':
      return (
        draft.provider !== settings.ai.provider ||
        draft.model.trim() !== (settings.ai.model ?? '') ||
        draft.anthropic_key !== '' ||
        draft.openai_key !== ''
      );
  }
}

function patchOf(section: SectionId, draft: Draft, settings: Settings): SettingsUpdate {
  switch (section) {
    case 'workspace':
      return {
        workspace: draft.workspace.trim(),
        // A member is sent the names of the environment and not its values, so they
        // have nothing to send back: the rows are read-only for them.
        ...(settings.env === null ? {} : { env: envRecord(draft.env) }),
      };
    case 'interpreter':
      return { python: draft.python.trim() };
    case 'runs':
      return {
        default_runtime: draft.default_runtime,
        default_batch: Number(draft.default_batch),
        exec_timeout: Number(draft.exec_timeout),
        max_concurrent_runs: Number(draft.max_concurrent_runs),
        cancel_grace: Number(draft.cancel_grace),
      };
    case 'history':
      return { auto_commit: draft.auto_commit };
    case 'notifications': {
      const host = draft.smtp_host.trim();
      const notifications: NotificationsUpdate = {
        webhook_default: draft.webhook_default.trim() || null,
        // No host is no mail: the server takes `null` for "forget the SMTP server".
        smtp: host
          ? {
              host,
              port: Number(draft.smtp_port),
              username: draft.smtp_username.trim(),
              from: draft.smtp_from.trim(),
              starttls: draft.smtp_starttls,
            }
          : null,
      };
      if (draft.smtp_password) notifications.smtp_password = draft.smtp_password;
      return { notifications };
    }
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

/**
 * The token this browser sends, which is not a server setting at all: it is the string
 * `tolquane web --token …` was given, kept here so the app can talk to that server. It
 * never travels to the server as a value -- only as the header on every request.
 */
function ServerTokenRow({ id }: { id: string }): JSX.Element {
  const held = apiToken();
  const [value, setValue] = useState('');

  return (
    <SettingsRow
      label="Your token"
      aside={<SettingsKeyBadge isSet={held !== null} />}
      help="Sent as an Authorization header on every request, and in the query string of the run socket and trace downloads. Kept in this browser only, never on the server."
    >
      <span className={styles.tokenRow}>
        <TextInput
          id={id}
          type="password"
          mono
          aria-label="Your token"
          autoComplete="off"
          spellCheck={false}
          placeholder={held ? 'Replace the token this browser sends' : 'Paste the server’s token'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          size="sm"
          onClick={() => {
            setApiToken(value.trim() || null);
            setValue('');
          }}
          disabled={!value.trim() && held === null}
        >
          {value.trim() ? 'Use it' : 'Clear'}
        </Button>
      </span>
      <span className={styles.tokenHint}>
        {held
          ? 'Stored in this browser. Clear it to stop sending one.'
          : 'Not stored. A server on loopback does not ask for one.'}
      </span>
    </SettingsRow>
  );
}

/** The workspace environment a member may see: the names, and nothing to change. */
function EnvNames({ names }: { names: readonly string[] }): JSX.Element {
  if (names.length === 0) {
    return <span className={styles.readonly}>Nothing is set.</span>;
  }
  return (
    <div className={styles.legend}>
      {names.map((name) => (
        <code key={name} className={styles.envName}>
          {name}
        </code>
      ))}
    </div>
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
    if (!draft || !settings) return;
    setState((current) => ({
      ...current,
      [section]: { saving: true, saved: false, error: null },
    }));
    void putSettings(patchOf(section, draft, settings))
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
        description="Settings live in the Tolquane Web database next to your workspace. API keys and the SMTP password are the exception: they are read from the environment or from a permissions-restricted settings file, never from the database."
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
            {/* An absolute path is longer than the right-hand column: it gets the width
                of the panel, so the whole of it can be read and edited. */}
            <SettingsStack
              label="Workspace directory"
              htmlFor={field('workspace')}
              help="Where flows are read from and written to. Runs use it as their working directory, and a flow outside it cannot be opened."
            >
              <TextInput
                id={field('workspace')}
                mono
                spellCheck={false}
                autoComplete="off"
                aria-label="Workspace directory"
                value={draft.workspace}
                onChange={(event) => edit('workspace', event.target.value)}
              />
            </SettingsStack>

            <SettingsStack
              label="Workspace environment"
              help="Given to every run in this workspace, before the run’s own variables. Secrets a flow needs belong here rather than in the file."
            >
              {settings.env === null ? (
                <EnvNames names={settings.env_names} />
              ) : (
                <EnvironmentRows
                  rows={draft.env}
                  idPrefix={field('env')}
                  addLabel="Add a variable"
                  onChange={(rows) => edit('env', rows)}
                />
              )}
            </SettingsStack>
          </SettingsSection>

          <SettingsSection
            title="Interpreter"
            note="Checked by running it: it has to have tolquane, of the same major version as this server."
            {...sectionProps('interpreter')}
          >
            <SettingsStack
              label="Python"
              htmlFor={field('python')}
              help="The interpreter every run and every one-shot command (check, explain, draw) uses. A bare name is looked up on PATH; a virtualenv that has gone falls back to the server’s own."
            >
              <TextInput
                id={field('python')}
                mono
                spellCheck={false}
                autoComplete="off"
                aria-label="Python"
                placeholder="/usr/bin/python3"
                invalid={Boolean(state.interpreter.error)}
                value={draft.python}
                onChange={(event) => edit('python', event.target.value)}
              />
            </SettingsStack>
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
            title="History"
            note="Nothing here ever pushes, resets or checks out: the workspace stays yours."
            {...sectionProps('history')}
          >
            <SettingsRow
              label="Commit on save"
              help="Every save commits the flow and its layout to the workspace’s git repository, with the message you gave or “Edit <path>”. A restore is never committed."
            >
              <CheckLine
                id={field('auto-commit')}
                checked={draft.auto_commit}
                onChange={(checked) => edit('auto_commit', checked)}
              >
                Commit each save
              </CheckLine>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection
            title="Notifications"
            description="What a schedule uses when it has something to say about a run. A schedule with no webhook of its own uses the default below; email needs an SMTP server, and without one the attempt is recorded as failed with the reason."
            note="The SMTP password goes to the settings file with the API keys, never to the database."
            invalid={Boolean(portError(draft))}
            {...sectionProps('notifications')}
          >
            <SettingsStack
              label="Default webhook"
              htmlFor={field('webhook')}
              help="Posted the run, the report’s busiest nodes and the last 2 KB of the log as JSON. Schedules that name their own webhook use that instead."
            >
              <TextInput
                id={field('webhook')}
                mono
                spellCheck={false}
                autoComplete="off"
                aria-label="Default webhook"
                placeholder="https://example.com/hooks/tolquane"
                value={draft.webhook_default}
                onChange={(event) => edit('webhook_default', event.target.value)}
              />
            </SettingsStack>

            <SettingsRow
              label="SMTP server"
              htmlFor={field('smtp-host')}
              help="Where notification mail is sent through. Leave it empty to turn email off entirely."
            >
              <TextInput
                id={field('smtp-host')}
                mono
                spellCheck={false}
                autoComplete="off"
                aria-label="SMTP server"
                placeholder="smtp.example.com"
                value={draft.smtp_host}
                onChange={(event) => edit('smtp_host', event.target.value)}
              />
            </SettingsRow>

            <NumberSetting
              id={field('smtp-port')}
              label="SMTP port"
              help="587 for STARTTLS, 25 for a relay on this machine."
              value={draft.smtp_port}
              error={portError(draft)}
              onChange={(value) => edit('smtp_port', value)}
            />

            <SettingsRow
              label="SMTP username"
              htmlFor={field('smtp-username')}
              help="Left empty for a relay that does not ask who you are."
            >
              <TextInput
                id={field('smtp-username')}
                mono
                spellCheck={false}
                autoComplete="off"
                aria-label="SMTP username"
                value={draft.smtp_username}
                onChange={(event) => edit('smtp_username', event.target.value)}
              />
            </SettingsRow>

            <SettingsRow
              label="From address"
              htmlFor={field('smtp-from')}
              help="Who the mail comes from. Some servers refuse an address they do not own."
            >
              <TextInput
                id={field('smtp-from')}
                mono
                spellCheck={false}
                autoComplete="off"
                aria-label="From address"
                placeholder="tolquane@example.com"
                value={draft.smtp_from}
                onChange={(event) => edit('smtp_from', event.target.value)}
              />
            </SettingsRow>

            <SettingsRow
              label="STARTTLS"
              help="Upgrade the connection before sending. Off only for a relay on this machine."
            >
              <CheckLine
                id={field('smtp-starttls')}
                checked={draft.smtp_starttls}
                onChange={(checked) => edit('smtp_starttls', checked)}
              >
                Upgrade the connection
              </CheckLine>
            </SettingsRow>

            <SettingsRow
              label="SMTP password"
              htmlFor={field('smtp-password')}
              aside={<SettingsKeyBadge isSet={settings.notifications.has_smtp_password ?? false} />}
              help="Sent once when you save this section. The server reports only whether one is stored, and reads TOLQUANE_SMTP_PASSWORD when it has none."
            >
              <SettingsKeyField
                id={field('smtp-password')}
                label="SMTP password"
                isSet={settings.notifications.has_smtp_password ?? false}
                value={draft.smtp_password}
                onChange={(value) => edit('smtp_password', value)}
              />
            </SettingsRow>
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
              aside={<SettingsKeyBadge isSet={settings.ai.has_anthropic_key ?? false} />}
              help="Sent once when you save this section. The server reports only whether a key is stored."
            >
              <SettingsKeyField
                id={field('anthropic')}
                label="Anthropic key"
                isSet={settings.ai.has_anthropic_key ?? false}
                value={draft.anthropic_key}
                onChange={(value) => edit('anthropic_key', value)}
              />
            </SettingsRow>

            <SettingsRow
              label="OpenAI key"
              htmlFor={field('openai')}
              aside={<SettingsKeyBadge isSet={settings.ai.has_openai_key ?? false} />}
              help="Sent once when you save this section. The server reports only whether a key is stored."
            >
              <SettingsKeyField
                id={field('openai')}
                label="OpenAI key"
                isSet={settings.ai.has_openai_key ?? false}
                value={draft.openai_key}
                onChange={(value) => edit('openai_key', value)}
              />
            </SettingsRow>
          </SettingsSection>

          {settings.server ? (
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
              <ServerTokenRow id={field('server-token')} />
            </SettingsSection>
          ) : null}
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
