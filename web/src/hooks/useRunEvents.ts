/**
 * The socket a run is watched through: `WS /api/runs/{id}/events` (S4).
 *
 * The server sends every event the run has produced so far the moment the socket opens,
 * then the live ones, and closes after `done`. That makes joining late the same code
 * path as starting a run -- and it makes a reconnect a replay, so the accumulating parts
 * of the store (the console, the problems, the report) are emptied first and filled
 * again in order rather than twice.
 *
 * One reconnect, and only before `done`: a socket that drops once is a hiccup, a socket
 * that drops twice is a server that has gone, and the drawer says so rather than
 * hammering it.
 */

import { useEffect, useRef } from 'react';
import { parseRunEvent, runEventsUrl, type RunEvent } from '../api/runs';
import { useRunStore } from '../store/run';

export interface RunEventsOptions {
  /** Every event, after the store has taken it: the page can follow along. */
  onEvent?: (event: RunEvent) => void;
  /** How long to wait before the one retry. */
  retryDelayMs?: number;
  /** Injected by the tests; the browser's `WebSocket` otherwise. */
  createSocket?: (url: string) => WebSocket;
}

/** Watch a run. Passing `null` closes whatever was open and watches nothing. */
export function useRunEvents(runId: number | null, options: RunEventsOptions = {}): void {
  const { retryDelayMs = 500, createSocket } = options;
  // The callback is read through a ref so a page that passes a fresh arrow function on
  // every render does not tear the socket down and build it again.
  const onEvent = useRef(options.onEvent);
  useEffect(() => {
    onEvent.current = options.onEvent;
  }, [options.onEvent]);

  useEffect(() => {
    if (runId === null) return;
    const id = runId;
    const store = useRunStore.getState();
    const open = createSocket ?? ((url: string) => new WebSocket(url));

    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let finished = false;
    let retried = false;
    let closed = false;

    function connect(replay: boolean): void {
      if (closed) return;
      if (replay) store.rewind();
      store.setConnection('connecting');
      let next: WebSocket;
      try {
        next = open(runEventsUrl(id));
      } catch {
        store.setConnection('closed');
        return;
      }
      socket = next;

      next.onopen = () => {
        if (!closed) store.setConnection('open');
      };
      next.onmessage = (message: MessageEvent) => {
        if (closed) return;
        const event = parseRunEvent(message.data);
        if (!event) return;
        if (event.event === 'done') finished = true;
        store.applyEvent(event);
        onEvent.current?.(event);
      };
      next.onerror = () => {
        // `close` follows an error, and that is where the retry is decided.
      };
      next.onclose = () => {
        if (closed) return;
        store.setConnection('closed');
        if (finished || retried) return;
        retried = true;
        timer = window.setTimeout(() => {
          connect(true);
        }, retryDelayMs);
      };
    }

    connect(false);

    return () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        // 0 CONNECTING, 1 OPEN: anything further along is closing already.
        if (socket.readyState <= 1) socket.close();
      }
      useRunStore.getState().setConnection('idle');
    };
    // `onEvent` is not a dependency: it is read through the ref, so a page may pass a
    // fresh arrow function on every render without the socket noticing.
  }, [runId, retryDelayMs, createSocket]);
}
