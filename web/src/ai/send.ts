/**
 * One turn of the conversation: the request, and the store actions its events drive.
 *
 * This is the only place in the AI panel that talks to the server, the way the editor
 * page is the only place that talks to it for the flow. The panel calls it and forgets
 * it: everything the user sees comes back through the store.
 */

import { chat } from '../api/ai';
import { ApiError } from '../api/client';
import { historyOf, threadOf, useAiStore } from '../store/ai';

export interface SendOptions {
  /** The thread: the flow's path, or `''` when no flow is open. */
  key: string;
  /** The flow the builder should work on, or `null`. */
  path: string | null;
  question: string;
  provider?: string | null;
  model?: string | null;
  sample?: string | null;
}

export async function sendTurn(options: SendOptions): Promise<void> {
  const { key, path, question } = options;
  const store = useAiStore.getState();
  // The history is what was said before this question; `begin` adds the question itself.
  const messages = historyOf(threadOf(store, key), question);
  const controller = new AbortController();
  store.begin(key, question, controller);

  try {
    await chat(
      {
        path,
        messages,
        provider: options.provider ?? null,
        model: options.model ?? null,
        sample: options.sample ?? null,
      },
      {
        onText: (event) => useAiStore.getState().appendText(key, event.delta),
        onTool: (event) => useAiStore.getState().tool(key, event),
        onFlow: (event) => useAiStore.getState().setFlow(key, event),
        onDone: (event) => useAiStore.getState().finish(key, event),
        onError: (event) => useAiStore.getState().fail(key, event.message),
      },
      controller.signal,
    );
  } catch (caught) {
    const message =
      caught instanceof ApiError
        ? caught.message
        : caught instanceof Error
          ? caught.message
          : 'The builder could not be reached';
    useAiStore.getState().fail(key, message);
  } finally {
    useAiStore.getState().settle(key);
  }
}
