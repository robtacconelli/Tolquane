import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '../api/runs';
import { useRunStore } from '../store/run';
import { useRunEvents } from './useRunEvents';

/*
 * The hook against a socket that does what the server's does: replay first, live after,
 * close when it feels like it. Nothing here talks to a real WebSocket, and the store is
 * the only thing checked, because the store is the only thing the page reads.
 */

class FakeSocket {
  static open: FakeSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedByClient = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.open.push(this);
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  send(event: RunEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  /** The server, or the network, going away. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }
}

function watch(runId: number | null) {
  return renderHook(
    ({ id }: { id: number | null }) =>
      useRunEvents(id, {
        retryDelayMs: 0,
        createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      }),
    { initialProps: { id: runId } },
  );
}

const BACKLOG: RunEvent[] = [
  {
    event: 'start',
    graph: { nodes: [], edges: [], loops: [], windows: {} },
    runtime: 'threads',
    flow: 'hello.py',
  },
  { event: 'stdout', text: 'two\nlines\n' },
  {
    event: 'report',
    report: { runtime: 'threads', elapsed: 1, nodes: {}, edges: {}, busiest: [] },
  },
  { event: 'done', status: 'done', elapsed: 1 },
];

function last(): FakeSocket {
  const socket = FakeSocket.open[FakeSocket.open.length - 1];
  if (!socket) throw new Error('no socket was opened');
  return socket;
}

describe('useRunEvents', () => {
  beforeEach(() => {
    FakeSocket.open = [];
    useRunStore.getState().reset();
    useRunStore.getState().start(9, { path: 'hello.py' });
  });

  it('opens the run’s socket and marks the connection', async () => {
    watch(9);
    expect(FakeSocket.open).toHaveLength(1);
    expect(last().url).toContain('/api/runs/9/events');
    act(() => {
      last().accept();
    });
    await waitFor(() => {
      expect(useRunStore.getState().connection).toBe('open');
    });
  });

  it('feeds every event to the store, in order', () => {
    watch(9);
    act(() => {
      last().accept();
      for (const event of BACKLOG) last().send(event);
    });
    const state = useRunStore.getState();
    expect(state.status).toBe('done');
    expect(state.lines.map((line) => line.text)).toEqual(['two', 'lines']);
    expect(state.report?.elapsed).toBe(1);
  });

  it('replays a run that had already started without doubling anything', () => {
    // Joining late is the same path: the whole backlog arrives at once.
    watch(9);
    act(() => {
      last().accept();
      for (const event of BACKLOG) last().send(event);
    });
    expect(useRunStore.getState().lines).toHaveLength(2);
    expect(useRunStore.getState().problems).toHaveLength(0);
  });

  it('reconnects once when the socket drops before done, and replays cleanly', async () => {
    watch(9);
    act(() => {
      last().accept();
      last().send(BACKLOG[0] as RunEvent);
      last().send(BACKLOG[1] as RunEvent);
    });
    expect(useRunStore.getState().lines).toHaveLength(2);

    act(() => {
      last().drop();
    });
    await waitFor(() => {
      expect(FakeSocket.open).toHaveLength(2);
    });

    // The second socket replays the run from the beginning; the console is emptied
    // first, so the two lines are still two lines.
    act(() => {
      last().accept();
      for (const event of BACKLOG) last().send(event);
    });
    const state = useRunStore.getState();
    expect(state.lines.map((line) => line.text)).toEqual(['two', 'lines']);
    expect(state.status).toBe('done');
  });

  it('gives up after the second drop', async () => {
    watch(9);
    act(() => {
      last().drop();
    });
    await waitFor(() => {
      expect(FakeSocket.open).toHaveLength(2);
    });
    act(() => {
      last().drop();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeSocket.open).toHaveLength(2);
    expect(useRunStore.getState().connection).toBe('closed');
  });

  it('does not reconnect after the run is done', async () => {
    watch(9);
    act(() => {
      last().accept();
      last().send({ event: 'done', status: 'done', elapsed: 1 });
      last().drop();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeSocket.open).toHaveLength(1);
  });

  it('watches nothing without a run, and lets go on unmount', () => {
    const idle = watch(null);
    expect(FakeSocket.open).toHaveLength(0);
    idle.unmount();

    const live = watch(9);
    act(() => {
      last().accept();
    });
    const socket = last();
    live.unmount();
    expect(socket.closedByClient).toBe(true);
    expect(useRunStore.getState().connection).toBe('idle');
  });

  it('follows the run it is given', async () => {
    const view = watch(9);
    expect(last().url).toContain('/runs/9/');
    view.rerender({ id: 10 });
    await waitFor(() => {
      expect(FakeSocket.open).toHaveLength(2);
    });
    expect(last().url).toContain('/runs/10/');
  });
});
