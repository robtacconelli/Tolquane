/**
 * `POST /api/ai/chat` (docs/web-interfaces.md, S4, "AI chat").
 *
 * The one route that does not answer with JSON: it is a `text/event-stream`, and the
 * whole point of it is to be read while it is still being written, so `request()` in
 * client.ts -- which waits for the body and parses it -- cannot serve it. This reads the
 * body itself, cuts it into events and hands each one to a typed handler.
 *
 * Nothing here keeps state between calls except the parser, which is exported on its own
 * so the cut-at-any-byte behaviour can be tested without a fetch at all.
 */

import type { CodeOnly, FlowModel, GraphView } from '../model/types';
import { API_BASE, ApiError } from './client';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  /** The flow the user has open; the server seeds the builder with its source. */
  path: string | null;
  messages: ChatMessage[];
  provider?: string | null;
  model?: string | null;
  sample?: string | null;
}

/** The four tools the builder has (docs/builder.md, `tolquane.ai.tools`). */
export const TOOL_NAMES = ['write_flow', 'check_flow', 'run_flow', 'read_docs'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface TextEvent {
  type: 'text';
  delta: string;
}

export interface ToolEvent {
  type: 'tool';
  /** One of `TOOL_NAMES` in practice, but a new tool must not break the panel. */
  name: string;
  status: 'started' | 'done';
  summary: string;
  error?: boolean;
}

export interface FlowEvent {
  type: 'flow';
  source: string;
  model: FlowModel | null;
  graph: GraphView | null;
  code_only?: CodeOnly | null;
}

export interface DoneEvent {
  type: 'done';
  ok: boolean;
  summary: string;
  usage?: Record<string, number>;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type AiEvent = TextEvent | ToolEvent | FlowEvent | DoneEvent | ErrorEvent;

export interface ChatHandlers {
  onText?: (event: TextEvent) => void;
  onTool?: (event: ToolEvent) => void;
  onFlow?: (event: FlowEvent) => void;
  onDone?: (event: DoneEvent) => void;
  onError?: (event: ErrorEvent) => void;
}

const KNOWN = new Set(['text', 'tool', 'flow', 'done', 'error']);

/** One `data:` payload as an event, or `null` when it is not one of ours. */
export function parseEventData(payload: string): AiEvent | null {
  if (!payload.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN.has(type)) return null;
  return value as AiEvent;
}

/**
 * Server-sent events, byte by byte.
 *
 * `push` may be handed any slice of the stream -- half a line, several events at once,
 * a line break split from its own newline -- and returns the events that became whole.
 * `flush` closes the stream: a last event without its blank line still counts, because a
 * server that finishes and hangs up has said everything it means to say.
 */
export class EventStreamParser {
  private buffer = '';
  private data: string[] = [];

  push(chunk: string): AiEvent[] {
    this.buffer += chunk;
    const events: AiEvent[] = [];
    for (;;) {
      const stop = this.buffer.indexOf('\n');
      if (stop < 0) break;
      const line = this.buffer.slice(0, stop).replace(/\r$/, '');
      this.buffer = this.buffer.slice(stop + 1);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  flush(): AiEvent[] {
    if (this.buffer) {
      const rest = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      const event = this.line(rest);
      if (event) return [event];
    }
    const last = this.dispatch();
    return last ? [last] : [];
  }

  private line(line: string): AiEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null; // a comment, which is how keep-alives arrive
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return null; // `event:`, `id:`, `retry:`: not used by this route
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.data.push(value);
    return null;
  }

  private dispatch(): AiEvent | null {
    if (this.data.length === 0) return null;
    const payload = this.data.join('\n');
    this.data = [];
    return parseEventData(payload);
  }
}

function deliver(events: readonly AiEvent[], handlers: ChatHandlers): void {
  for (const event of events) {
    switch (event.type) {
      case 'text':
        handlers.onText?.(event);
        break;
      case 'tool':
        handlers.onTool?.(event);
        break;
      case 'flow':
        handlers.onFlow?.(event);
        break;
      case 'done':
        handlers.onDone?.(event);
        break;
      case 'error':
        handlers.onError?.(event);
        break;
    }
  }
}

async function failure(response: Response, url: string): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let message = text.trim();
  try {
    const body: unknown = JSON.parse(text);
    const envelope = (body as { error?: { message?: unknown } } | null)?.error;
    if (typeof envelope?.message === 'string') message = envelope.message;
  } catch {
    /* not JSON: the text is the message */
  }
  return new ApiError({
    message: message || `The builder could not be reached (${String(response.status)})`,
    status: response.status,
    code: 'http',
    url,
  });
}

/**
 * Run one turn of the conversation, calling the handlers as the events arrive.
 *
 * It resolves when the server closes the stream. Aborting the signal -- the Stop button
 * -- resolves it too rather than throwing: stopping is something the user did, not a
 * failure to report. Everything else (a dead server, a 4xx) throws an `ApiError`.
 */
export async function chat(
  request: ChatRequest,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${API_BASE}/ai/chat`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: signal ?? null,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(request),
    });
  } catch (cause) {
    if (signal?.aborted) return;
    throw new ApiError({
      message: 'Could not reach the Tolquane server',
      status: 0,
      code: 'network',
      url,
      detail: cause,
    });
  }

  if (!response.ok) throw await failure(response, url);

  const parser = new EventStreamParser();
  const body = response.body;

  // Not every environment gives a readable body (jsdom does not); the whole text is
  // still an event stream, only one that arrived all at once.
  if (!body) {
    const text = await response.text();
    deliver(parser.push(text), handlers);
    deliver(parser.flush(), handlers);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      deliver(parser.push(decoder.decode(value, { stream: true })), handlers);
    }
    deliver(parser.push(decoder.decode()), handlers);
    deliver(parser.flush(), handlers);
  } catch (cause) {
    if (signal?.aborted) return;
    throw new ApiError({
      message: 'The builder stopped answering',
      status: 0,
      code: 'network',
      url,
      detail: cause,
    });
  } finally {
    if (signal?.aborted) void reader.cancel().catch(() => undefined);
  }
}
