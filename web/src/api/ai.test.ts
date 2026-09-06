import { describe, expect, it, vi } from 'vitest';
import { EventStreamParser, chat, parseEventData, type AiEvent } from './ai';
import { ApiError } from './client';

/** The stream as the server writes it: one JSON object per `data:` line, blank between. */
function frame(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/** Every way of cutting `text` into `size`-byte pieces, which is what a socket does. */
function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

describe('parseEventData', () => {
  it('reads the five event types', () => {
    expect(parseEventData('{"type":"text","delta":"hi"}')).toEqual({ type: 'text', delta: 'hi' });
    expect(parseEventData('{"type":"done","ok":true,"summary":"done"}')).toMatchObject({
      type: 'done',
      ok: true,
    });
  });

  it('ignores anything that is not one of them', () => {
    expect(parseEventData('')).toBeNull();
    expect(parseEventData('not json')).toBeNull();
    expect(parseEventData('{"type":"heartbeat"}')).toBeNull();
    expect(parseEventData('[1,2,3]')).toBeNull();
  });
});

describe('EventStreamParser', () => {
  const events = [
    { type: 'text', delta: 'Reading ' },
    { type: 'text', delta: 'the flow.' },
    { type: 'tool', name: 'write_flow', status: 'started', summary: '42 lines' },
    { type: 'tool', name: 'write_flow', status: 'done', summary: 'written', error: false },
    { type: 'done', ok: true, summary: 'Wrote it.', usage: { input: 10 } },
  ];

  it('parses a whole stream at once', () => {
    const parser = new EventStreamParser();
    expect(parser.push(frame(events))).toEqual(events);
    expect(parser.flush()).toEqual([]);
  });

  /* The important case: a chunk boundary can land anywhere, including inside a line, in
   * the middle of the JSON, or between a line and its own newline. */
  for (const size of [1, 3, 7, 29, 200]) {
    it(`parses the same stream cut into ${String(size)}-character pieces`, () => {
      const parser = new EventStreamParser();
      const seen: AiEvent[] = [];
      for (const piece of chunks(frame(events), size)) seen.push(...parser.push(piece));
      seen.push(...parser.flush());
      expect(seen).toEqual(events);
    });
  }

  it('splits a line from its newline without losing it', () => {
    const parser = new EventStreamParser();
    expect(parser.push('data: {"type":"text","delta":"a"}')).toEqual([]);
    expect(parser.push('\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ type: 'text', delta: 'a' }]);
  });

  it('accepts CRLF, comments and a data line with no space', () => {
    const parser = new EventStreamParser();
    const seen = parser.push(': keep-alive\r\ndata:{"type":"text","delta":"x"}\r\n\r\n');
    expect(seen).toEqual([{ type: 'text', delta: 'x' }]);
  });

  it('joins the data lines of one event', () => {
    const parser = new EventStreamParser();
    expect(parser.push('data: {"type":"text",\ndata: "delta":"two lines"}\n\n')).toEqual([
      { type: 'text', delta: 'two lines' },
    ]);
  });

  it('delivers a last event that never got its blank line', () => {
    const parser = new EventStreamParser();
    expect(parser.push('data: {"type":"done","ok":true,"summary":"end"}\n')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: 'done', ok: true, summary: 'end' }]);
  });
});

/** A `Response` whose body arrives in pieces, the way the real one does. */
function streamed(pieces: readonly string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

describe('chat', () => {
  it('calls one handler per event, in order', async () => {
    const body = frame([
      { type: 'text', delta: 'Working' },
      { type: 'tool', name: 'check_flow', status: 'started', summary: '{}' },
      { type: 'tool', name: 'check_flow', status: 'done', summary: 'OK: 3 nodes', error: false },
      { type: 'flow', source: 'print(1)\n', model: null, graph: null },
      { type: 'done', ok: true, summary: 'Done.' },
    ]);
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(streamed(chunks(body, 11))),
    );
    vi.stubGlobal('fetch', fetchMock);

    const seen: string[] = [];
    await chat(
      { path: 'hello.py', messages: [{ role: 'user', content: 'hi' }] },
      {
        onText: (event) => seen.push(`text:${event.delta}`),
        onTool: (event) => seen.push(`tool:${event.name}:${event.status}`),
        onFlow: (event) => seen.push(`flow:${event.source.trim()}`),
        onDone: (event) => seen.push(`done:${String(event.ok)}`),
        onError: (event) => seen.push(`error:${event.message}`),
      },
    );

    expect(seen).toEqual([
      'text:Working',
      'tool:check_flow:started',
      'tool:check_flow:done',
      'flow:print(1)',
      'done:true',
    ]);
    const sent = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof sent).toBe('string');
    expect(JSON.parse(sent as string)).toMatchObject({ path: 'hello.py' });
  });

  it('reports the server saying it has no key as an error event', async () => {
    const message = 'no anthropic key: save one in settings, or export ANTHROPIC_API_KEY';
    vi.stubGlobal('fetch', () => Promise.resolve(streamed([frame([{ type: 'error', message }])])));
    const errors: string[] = [];
    await chat({ path: null, messages: [] }, { onError: (event) => errors.push(event.message) });
    expect(errors).toEqual([message]);
  });

  it('stops quietly when the caller aborts', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // What `fetch` does to a body when its signal fires: the stream errors mid-read.
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encoder.encode(frame([{ type: 'text', delta: 'half a th' }])));
          controller.signal.addEventListener('abort', () =>
            stream.error(new DOMException('aborted', 'AbortError')),
          );
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    vi.stubGlobal('fetch', () => Promise.resolve(response));

    const seen: string[] = [];
    let sawFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    const running = chat(
      { path: null, messages: [] },
      {
        onText: (event) => {
          seen.push(event.delta);
          sawFirst();
        },
      },
      controller.signal,
    );

    await first;
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(seen).toEqual(['half a th']);
  });

  it('raises the server error when the request itself fails', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { type: 'GraphError', message: 'no such flow' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(chat({ path: 'gone.py', messages: [] }, {})).rejects.toThrow(ApiError);
    await expect(chat({ path: 'gone.py', messages: [] }, {})).rejects.toThrow('no such flow');
  });

  it('raises when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('failed to fetch')));
    await expect(chat({ path: null, messages: [] }, {})).rejects.toThrow(
      'Could not reach the Tolquane server',
    );
  });
});
