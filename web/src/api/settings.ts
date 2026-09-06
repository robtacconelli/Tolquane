/**
 * The settings routes of docs/web-interfaces.md, S4 and E and N.
 *
 * The answer comes from the server's OpenAPI through `client.ts`'s `Schemas`, narrowed
 * where its models say `str` and the UI knows the three runtimes and the two providers.
 * `SettingsUpdate` is the one shape written out here: `PUT /api/settings` takes any
 * subset of the settings, so the schema has nothing but "an object", and the three
 * write-only secret fields (`ai.anthropic_key`, `ai.openai_key` and
 * `notifications.smtp_password`) exist in no answer at all. `GET` never returns a
 * secret: the server reports only whether one is set, and writes what it is given to
 * its own configuration file (mode 600).
 *
 * Three fields answer `null` to a member rather than a value: `server`, the `has_*`
 * flags and the workspace `env`, whose names come back in `env_names` instead. The
 * types say so, and the page reads the names when it cannot read the values.
 */
import { type Complete, type Schemas, api } from './client';
import type { Runtime } from './schedules';

export type AiProvider = 'anthropic' | 'openai';

export type AiSettings = Omit<Complete<Schemas['AiSettings']>, 'provider'> & {
  provider: AiProvider;
};

/** Start-up options: `tolquane web --host --port --token`. Read-only over the API. */
export type ServerSettings = Complete<Schemas['ServerSettings']>;

/** Where notification mail goes; the password is a key and never travels back. */
export type SmtpSettings = Complete<Schemas['SmtpSettings']>;

export type NotificationSettings = Omit<Complete<Schemas['NotificationSettings']>, 'smtp'> & {
  smtp: SmtpSettings | null;
};

export type Settings = Omit<
  Complete<Schemas['SettingsModel']>,
  'default_runtime' | 'ai' | 'notifications'
> & {
  default_runtime: Runtime;
  ai: AiSettings;
  notifications: NotificationSettings;
};

export interface AiSettingsUpdate {
  provider?: AiProvider;
  model?: string | null;
  /** Sent once when the user enters one; never returned by any route. */
  anthropic_key?: string;
  openai_key?: string;
}

/** `notifications.smtp` on the way in: the same five fields, and never the password. */
export type SmtpUpdate = Schemas['SmtpSettings'];

export interface NotificationsUpdate {
  webhook_default?: string | null;
  /** `null` forgets the server entirely, which turns email off. */
  smtp?: SmtpUpdate | null;
  /** Write-only, like the API keys: it goes to the key file and is never echoed. */
  smtp_password?: string | null;
}

export interface SettingsUpdate {
  workspace?: string;
  default_runtime?: Runtime;
  default_batch?: number;
  exec_timeout?: number;
  max_concurrent_runs?: number;
  max_source_bytes?: number;
  cancel_grace?: number;
  keep_traces_days?: number;
  theme?: string;
  /** The interpreter every run and one-shot command uses; validated by running it. */
  python?: string;
  /** Applied to every run, before the run's own environment. */
  env?: Record<string, string>;
  auto_commit?: boolean;
  ai?: AiSettingsUpdate;
  notifications?: NotificationsUpdate;
}

export const getSettings = () => api.get<Settings>('/settings');

export const putSettings = (patch: SettingsUpdate) => api.put<Settings>('/settings', patch);
