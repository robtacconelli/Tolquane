/**
 * The typed HTTP client for the Tolquane Web server.
 *
 * Every route lives under `/api` (see docs/web-interfaces.md, S4); in development Vite
 * proxies that prefix to the local server, in production the server serves this bundle
 * itself, so the base path is the same in both.
 */

import type { components } from './schema';
import { authHeaders, reportUnauthorized } from './token';

export const API_BASE = '/api';

/* --------------------------------------------------------------- the generated types */

/**
 * Every shape the server publishes, by name: `Schemas['RunModel']`.
 *
 * `schema.d.ts` is generated from `web/openapi.json`, which is
 * `tolquane web --openapi`; `npm run api:types` makes it again. Nothing in `src/api/`
 * writes a server shape by hand -- the wrappers below and beside this file take theirs
 * from here, and add only what the server cannot say: a `str` the UI knows is one of
 * three words, a `dict` that is really an S1 flow model, an event that never travels
 * over HTTP at all.
 */
export type Schemas = components['schemas'];

/**
 * A response body as it actually arrives.
 *
 * FastAPI serialises every field of a response model, defaults included, so a field its
 * schema leaves optional (`log`, `next_run`, `sample`) is still always in the JSON.
 * Responses are therefore read through this; request bodies are not.
 */
export type Complete<T> = { [K in keyof T]-?: T[K] };

/** A request body with the fields the server fills in for itself left out. */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Every failure the client raises, transport and HTTP alike, is one of these. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly detail: unknown;
  readonly url: string;

  constructor(init: {
    message: string;
    status: number;
    code: ApiErrorCode;
    url: string;
    detail?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.url = init.url;
    this.detail = init.detail ?? null;
  }

  /** True when the server could not be reached at all, as opposed to answering badly. */
  get isOffline(): boolean {
    return this.code === 'network' || this.code === 'timeout';
  }
}

export type ApiErrorCode =
  | 'network' // fetch itself failed: server down, DNS, CORS
  | 'timeout' // the request was aborted by its own deadline
  | 'aborted' // the caller aborted it
  | 'http' // the server answered with a non-2xx status
  | 'parse'; // a 2xx body that was not the JSON we expected

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Serialised as JSON. Use `formData` or a raw `BodyInit` through `rawBody` instead. */
  body?: unknown;
  rawBody?: BodyInit;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Milliseconds before the request aborts itself. `0` disables the deadline. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function buildUrl(path: string, query: RequestOptions['query']): string {
  const base = path.startsWith('/') ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * The server's error envelope is `{"error": {"type", "message", "detail"}}` (S4), whose
 * message already says the fix; FastAPI's own errors arrive as `detail` instead, and a
 * proxy or a crash can answer with plain text. Try all three, then the status line.
 */
function messageFromBody(body: unknown, status: number, statusText: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const envelope = (body as { error?: unknown }).error;
    if (envelope && typeof envelope === 'object') {
      const message = (envelope as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail) return detail;
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return statusText || `Request failed with status ${status}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, rawBody, query, signal, headers, timeoutMs } = options;
  const url = buildUrl(path, query);
  const deadline = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const abortCaller = () => controller.abort('caller');
  signal?.addEventListener('abort', abortCaller, { once: true });
  const timer = deadline > 0 ? setTimeout(() => controller.abort('timeout'), deadline) : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // A server started with `--token` wants it on everything; a caller that passes
        // its own Authorization (the token prompt, trying one out) still wins.
        ...authHeaders(),
        ...headers,
      },
      ...(rawBody !== undefined
        ? { body: rawBody }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    const reason = controller.signal.reason as unknown;
    if (reason === 'timeout') {
      throw new ApiError({
        message: `The server did not answer within ${deadline} ms`,
        status: 0,
        code: 'timeout',
        url,
      });
    }
    if (signal?.aborted || reason === 'caller') {
      throw new ApiError({ message: 'Request cancelled', status: 0, code: 'aborted', url });
    }
    throw new ApiError({
      message: 'Could not reach the Tolquane server',
      status: 0,
      code: 'network',
      url,
      detail: cause,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abortCaller);
  }

  const payload = await readBody(response);
  if (!response.ok) {
    // The server wants a token and this browser has none, or the wrong one. The shell
    // watches for this and asks for one rather than showing four failed panels.
    if (response.status === 401) reportUnauthorized();
    throw new ApiError({
      message: messageFromBody(payload, response.status, response.statusText),
      status: response.status,
      code: 'http',
      url,
      detail: payload,
    });
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

/** `GET /api/health`: the version, the live workspace, and whether the parts are up. */
export type Health = Complete<Schemas['Health']>;

export function health(options?: {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Trying a token before it is kept: the prompt sends its own Authorization. */
  headers?: Record<string, string>;
}): Promise<Health> {
  return api.get<Health>('/health', { timeoutMs: 4000, ...options });
}
