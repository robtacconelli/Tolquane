/**
 * The inputs a run is given: `build()`'s parameters and the child process's environment
 * (`docs/web-interfaces.md`, section E).
 *
 * The model keeps a parameter's default as *source* -- `2`, `"x"`, `True` -- because the
 * Python file is the artifact. That source is what says which field to draw: a number
 * gets a number field, a boolean a toggle, a string a text field, and anything else a
 * code field whose text is read as a literal. Everything here is pure, so the popover,
 * the schedule dialog and the properties panel all read a default the same way.
 */

import type { FlowParam } from '../model/types';
import { readStorage, writeStorage } from '../store/storage';

/** The four fields a parameter can be edited with. */
export type ParamFieldType = 'number' | 'boolean' | 'text' | 'code';

/** A literal read from source: `ok` is false when it is not one this build understands. */
export interface Literal {
  ok: boolean;
  value: unknown;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const PLAIN_STRING = /^(?:"([^"\\]*)"|'([^'\\]*)')$/;

/**
 * A Python (or JSON) literal as a value.
 *
 * `ast.literal_eval` is what the server and the CLI use; this is the small part of it
 * the browser needs, and it says `ok: false` rather than guessing when a literal is
 * beyond it -- a tuple with a trailing comma, a set, a byte string.
 */
export function pythonLiteral(source: string): Literal {
  const text = source.trim();
  if (!text) return { ok: false, value: null };
  if (text === 'True') return { ok: true, value: true };
  if (text === 'False') return { ok: true, value: false };
  if (text === 'None') return { ok: true, value: null };
  if (NUMBER.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, value: null };
  }
  const quoted = PLAIN_STRING.exec(text);
  if (quoted) return { ok: true, value: quoted[1] ?? quoted[2] ?? '' };
  // A list or an object: JSON once the three Python words are spelled the JSON way.
  const asJson = text.replace(/\b(True|False|None)\b/g, (word) =>
    word === 'True' ? 'true' : word === 'False' ? 'false' : 'null',
  );
  try {
    return { ok: true, value: JSON.parse(asJson) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

/** A value as Python source, so an edited default goes back into the file as a literal. */
export function toPythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None');
}

const FROM_ANNOTATION: Record<string, ParamFieldType> = {
  int: 'number',
  float: 'number',
  bool: 'boolean',
  str: 'text',
};

/**
 * Which field this parameter is edited with, read from its default literal. A default of
 * `None` says nothing about the type, so the annotation gets the last word there.
 */
export function paramFieldType(param: FlowParam): ParamFieldType {
  const literal = pythonLiteral(param.default);
  if (literal.ok) {
    if (typeof literal.value === 'boolean') return 'boolean';
    if (typeof literal.value === 'number') return 'number';
    if (typeof literal.value === 'string') return 'text';
    if (literal.value !== null) return 'code';
  }
  const annotation = (param.annotation ?? '').trim().replace(/\s*\|\s*None$/, '');
  return FROM_ANNOTATION[annotation] ?? 'code';
}

/** The parameter's own default as a value, for the field that starts out untouched. */
export function paramDefault(param: FlowParam): unknown {
  const literal = pythonLiteral(param.default);
  return literal.ok ? literal.value : null;
}

/** What the field holds before anything is typed: the remembered value, else the default. */
export function paramInitial(param: FlowParam, remembered: Record<string, unknown>): unknown {
  return param.name in remembered ? remembered[param.name] : paramDefault(param);
}

/** A value as the text of its field. A code field shows a literal, not JSON. */
export function paramText(type: ParamFieldType, value: unknown): string {
  if (type === 'text') return typeof value === 'string' ? value : '';
  if (type === 'number') return typeof value === 'number' ? String(value) : '';
  if (type === 'boolean') return value === true ? 'True' : 'False';
  return toPythonLiteral(value);
}

/** Why what was typed is not a value yet, or `null` when it is. */
export function paramError(type: ParamFieldType, text: string): string | null {
  if (type === 'number') {
    if (!text.trim()) return 'Enter a number.';
    return NUMBER.test(text.trim()) ? null : 'A number, like 8 or 0.5.';
  }
  if (type === 'code') {
    if (!text.trim()) return 'Enter a value.';
    return pythonLiteral(text).ok ? null : 'A Python or JSON literal: 8, "x", [1, 2], {"a": 1}.';
  }
  return null;
}

/** What was typed, as the value that goes into the request body as JSON. */
export function paramValue(type: ParamFieldType, text: string): unknown {
  if (type === 'text') return text;
  if (type === 'number') return Number(text.trim());
  if (type === 'boolean') return text === 'True' || text === 'true';
  return pythonLiteral(text).value;
}

/**
 * The parameters a run should be started with: every one the flow declares, with the
 * value on screen, and nothing the flow does not declare. A value equal to the
 * parameter's own default is still sent -- the flow's default may change under a
 * schedule that was set up when it was something else.
 */
export function paramsToSend(
  params: readonly FlowParam[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of params) {
    out[param.name] = param.name in values ? values[param.name] : paramDefault(param);
  }
  return out;
}

/* ------------------------------------------------------------------ the environment */

/** One row of the environment editor. `id` keeps React's keys stable while it is typed in. */
export interface EnvRow {
  id: string;
  name: string;
  value: string;
}

let nextRowId = 0;

export function blankEnvRow(): EnvRow {
  nextRowId += 1;
  return { id: `env-${String(nextRowId)}`, name: '', value: '' };
}

export function envRows(env: Record<string, string> | null | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([name, value]) => ({ ...blankEnvRow(), name, value }));
}

/** The rows as the object the routes take; a row without a name is not a variable yet. */
export function envRecord(rows: readonly EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) out[name] = row.value;
  }
  return out;
}

/** Why this variable name will not do, or `null`. The shell's own rule, and no more. */
export function envNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null; // an empty row is a row waiting to be filled in, not an error
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)
    ? null
    : 'Letters, digits and underscores only, not starting with a digit.';
}

/* ------------------------------------------------- what this browser remembers, per flow */

export interface RunInputs {
  params: Record<string, unknown>;
  env: Record<string, string>;
}

export const EMPTY_INPUTS: RunInputs = { params: {}, env: {} };

const KEY = 'tolquane.run.inputs';

function storageKey(path: string): string {
  return `${KEY}.${path}`;
}

/**
 * The parameters and environment this browser last ran that flow with.
 *
 * Remembering them per flow is what makes the popover worth opening once: a threshold
 * typed on Monday is still there on Tuesday, and it is this browser's business, not the
 * server's -- the run that used them is stored with them anyway.
 */
export function readRunInputs(path: string | null): RunInputs {
  if (!path) return EMPTY_INPUTS;
  const raw = readStorage(storageKey(path));
  if (raw === null) return EMPTY_INPUTS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return EMPTY_INPUTS;
    const { params, env } = parsed as Partial<RunInputs>;
    return {
      params: params && typeof params === 'object' ? params : {},
      env: env && typeof env === 'object' ? envRecord(envRows(env)) : {},
    };
  } catch {
    return EMPTY_INPUTS;
  }
}

export function writeRunInputs(path: string | null, inputs: RunInputs): void {
  if (!path) return;
  writeStorage(storageKey(path), JSON.stringify(inputs));
}
