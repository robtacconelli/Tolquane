/**
 * The settings routes of docs/web-interfaces.md, S4.
 *
 * The answer comes from the server's OpenAPI through `client.ts`'s `Schemas`, narrowed
 * where its models say `str` and the UI knows the three runtimes and the two providers.
 * `SettingsUpdate` is the one shape written out here: `PUT /api/settings` takes any
 * subset of the settings, so the schema has nothing but "an object", and the two
 * write-only key fields exist in no answer at all. `GET` never returns a key: the server
 * reports only whether one is set, and writes what it is given to its own configuration
 * file (mode 600).
 */
import { type Complete, type Schemas, api } from './client';
import type { Runtime } from './schedules';

export type AiProvider = 'anthropic' | 'openai';

export type AiSettings = Omit<Complete<Schemas['AiSettings']>, 'provider'> & {
  provider: AiProvider;
};

/** Start-up options: `tolquane web --host --port --token`. Read-only over the API. */
export type ServerSettings = Complete<Schemas['ServerSettings']>;

export type Settings = Omit<
  Complete<Schemas['SettingsModel']>,
  'default_runtime' | 'ai' | 'server'
> & {
  default_runtime: Runtime;
  ai: AiSettings;
  server: ServerSettings;
};

export interface AiSettingsUpdate {
  provider?: AiProvider;
  model?: string | null;
  /** Sent once when the user enters one; never returned by any route. */
  anthropic_key?: string;
  openai_key?: string;
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
  ai?: AiSettingsUpdate;
}

export const getSettings = () => api.get<Settings>('/settings');

export const putSettings = (patch: SettingsUpdate) => api.put<Settings>('/settings', patch);
