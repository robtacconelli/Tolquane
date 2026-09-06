import { useEffect, useRef, useState } from 'react';
import { ApiError, health, type Health } from '../api/client';

export type ServerStatus = 'checking' | 'online' | 'offline';

export interface HealthState {
  status: ServerStatus;
  info: Health | null;
  error: string | null;
  /** Consecutive failures; the banner waits for the first one to avoid flicker on load. */
  failures: number;
}

/**
 * Polls `/api/health`. Until the server of wave 1 exists this always ends in `offline`,
 * which is exactly the state the shell has to look calm in.
 */
export function useHealth(intervalMs = 5000): HealthState {
  const [state, setState] = useState<HealthState>({
    status: 'checking',
    info: null,
    error: null,
    failures: 0,
  });
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const controllers = new Set<AbortController>();

    async function check(): Promise<void> {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const info = await health({ signal: controller.signal });
        if (cancelled) return;
        failures.current = 0;
        setState({ status: 'online', info, error: null, failures: 0 });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'aborted') return;
        failures.current += 1;
        setState({
          status: 'offline',
          info: null,
          error: error instanceof Error ? error.message : String(error),
          failures: failures.current,
        });
      } finally {
        controllers.delete(controller);
      }
    }

    void check();
    const timer = setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort('caller');
    };
  }, [intervalMs]);

  return state;
}
