/**
 * The settings routes of docs/web-interfaces.md, S4.
 *
 * `GET` never returns a key: the server reports only whether one is set. `PUT` accepts
 * any subset of the settings, plus the two write-only key fields, which the server
 * writes to its own configuration file (mode 600) and never echoes back.
 */
import { api } from './client';
import type { Runtime } from './schedules';

export type AiProvider = 'anthropic' | 'openai';

export interface AiSettings {
  provider: AiProvider;
  model: string | null;
  has_anthropic_key: boolean;
  has_openai_key: boolean;
}

/** Start-up options: `tolquane web --host --port --token`. Read-only over the API. */
export interface ServerSettings {
  host: string;
  port: number;
  token_set: boolean;
}

export interface Settings {
  workspace: string;
  default_runtime: Runtime;
  default_batch: number;
  exec_timeout: number;
  max_concurrent_runs: number;
  cancel_grace: number;
  theme: string;
  ai: AiSettings;
  server: ServerSettings;
}

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
  cancel_grace?: number;
  theme?: string;
  ai?: AiSettingsUpdate;
}

export const getSettings = () => api.get<Settings>('/settings');

export const putSettings = (patch: SettingsUpdate) => api.put<Settings>('/settings', patch);
