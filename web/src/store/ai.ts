/**
 * The AI builder's conversations: one thread per flow, kept for the session.
 *
 * A thread belongs to the file it is about, so switching flows and coming back finds the
 * same conversation, with the flow the builder wrote still offered for applying. The key
 * is the flow's path inside the workspace, or `''` for a chat started with no file open.
 *
 * Like the flow store, nothing here talks to the server: `src/ai/send.ts` runs the
 * request and calls these actions as the events arrive. The one exception is `stop`,
 * which needs the `AbortController` of the request in flight; those live in a map beside
 * the store rather than in it, because an `AbortController` is not state to render.
 */

import { create } from 'zustand';
import type { AiEvent, ChatMessage, DoneEvent, FlowEvent, ToolEvent } from '../api/ai';
import type { CodeOnly, FlowModel, GraphView } from '../model/types';

export interface ToolStep {
  id: string;
  name: string;
  /** What the builder asked for: the `started` event's summary. */
  request: string;
  /** The first line of the answer, once it has one. */
  result: string | null;
  error: boolean;
  running: boolean;
}

/** A flow the builder wrote, waiting to be applied to the editor. */
export interface FlowDraft {
  source: string;
  model: FlowModel | null;
  graph: GraphView | null;
  codeOnly: CodeOnly | null;
  applied: boolean;
}

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ToolStep[];
  flow: FlowDraft | null;
  /** The builder's closing line, once the turn has ended. */
  summary: string | null;
  ok: boolean;
  error: string | null;
  streaming: boolean;
  stopped: boolean;
}

export interface Thread {
  turns: Turn[];
  /** What is in the composer, kept while the user looks at something else. */
  draft: string;
  /** A question handed over from elsewhere (a new flow described on the Flows page). */
  primed: string | null;
}

export const emptyThread = (): Thread => ({ turns: [], draft: '', primed: null });

const controllers = new Map<string, AbortController>();

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}`;
};

function newTurn(role: Turn['role'], text: string): Turn {
  return {
    id: nextId(role === 'user' ? 'u' : 'a'),
    role,
    text,
    tools: [],
    flow: null,
    summary: null,
    ok: true,
    error: null,
    streaming: role === 'assistant',
    stopped: false,
  };
}

export interface AiState {
  /** The panel is showing in the editor, in place of the properties panel. */
  open: boolean;
  /** The command palette asked to build a flow; the Flows page opens its dialog. */
  wantsNewFlow: boolean;
  threads: Record<string, Thread>;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  requestNewFlow: () => void;
  clearNewFlow: () => void;

  setDraft: (key: string, draft: string) => void;
  /** Hand a question to the thread for the panel to ask as soon as it opens. */
  prime: (key: string, question: string) => void;
  takePrimed: (key: string) => string | null;

  /** Start a turn: the user's words, then an assistant turn the events fill in. */
  begin: (key: string, question: string, controller: AbortController) => string;
  appendText: (key: string, delta: string) => void;
  tool: (key: string, event: ToolEvent) => void;
  setFlow: (key: string, event: FlowEvent) => void;
  finish: (key: string, event: DoneEvent) => void;
  fail: (key: string, message: string) => void;
  /** Abort the request in flight and close its turn as stopped. */
  stop: (key: string) => void;
  /** The stream ended, whatever it ended with: nothing is in flight any more. */
  settle: (key: string) => void;
  markApplied: (key: string, turnId: string) => void;
  clear: (key: string) => void;
}

export const useAiStore = create<AiState>((set, get) => {
  /** Rewrite the thread's last assistant turn; every event lands on that one turn. */
  function onLast(key: string, change: (turn: Turn) => Turn): void {
    set((state) => {
      const thread = state.threads[key] ?? emptyThread();
      let index = -1;
      for (let at = thread.turns.length - 1; at >= 0; at -= 1) {
        if (thread.turns[at]?.role === 'assistant') {
          index = at;
          break;
        }
      }
      if (index < 0) return state;
      const turns = thread.turns.slice();
      turns[index] = change(turns[index] as Turn);
      return { threads: { ...state.threads, [key]: { ...thread, turns } } };
    });
  }

  function patch(key: string, change: (thread: Thread) => Thread): void {
    set((state) => ({
      threads: { ...state.threads, [key]: change(state.threads[key] ?? emptyThread()) },
    }));
  }

  return {
    open: false,
    wantsNewFlow: false,
    threads: {},

    setOpen: (open) => set({ open }),
    toggle: () => set((state) => ({ open: !state.open })),
    requestNewFlow: () => set({ wantsNewFlow: true }),
    clearNewFlow: () => set({ wantsNewFlow: false }),

    setDraft: (key, draft) => patch(key, (thread) => ({ ...thread, draft })),
    prime: (key, question) => patch(key, (thread) => ({ ...thread, primed: question })),

    takePrimed: (key) => {
      const question = get().threads[key]?.primed ?? null;
      if (question !== null) patch(key, (thread) => ({ ...thread, primed: null }));
      return question;
    },

    begin: (key, question, controller) => {
      controllers.get(key)?.abort();
      controllers.set(key, controller);
      const assistant = newTurn('assistant', '');
      patch(key, (thread) => ({
        ...thread,
        draft: '',
        primed: null,
        turns: [...thread.turns, newTurn('user', question), assistant],
      }));
      return assistant.id;
    },

    appendText: (key, delta) => onLast(key, (turn) => ({ ...turn, text: turn.text + delta })),

    tool: (key, event) =>
      onLast(key, (turn) => {
        if (event.status === 'started') {
          const step: ToolStep = {
            id: nextId('t'),
            name: event.name,
            request: event.summary,
            result: null,
            error: false,
            running: true,
          };
          return { ...turn, tools: [...turn.tools, step] };
        }
        // The answer belongs to the most recent call of that tool still waiting for one.
        const tools = turn.tools.slice();
        for (let at = tools.length - 1; at >= 0; at -= 1) {
          const step = tools[at];
          if (step && step.running && step.name === event.name) {
            tools[at] = {
              ...step,
              running: false,
              result: event.summary,
              error: Boolean(event.error),
            };
            return { ...turn, tools };
          }
        }
        return turn;
      }),

    setFlow: (key, event) =>
      onLast(key, (turn) => ({
        ...turn,
        flow: {
          source: event.source,
          model: event.model,
          graph: event.graph,
          codeOnly: event.code_only ?? null,
          applied: false,
        },
      })),

    finish: (key, event) =>
      onLast(key, (turn) => ({
        ...turn,
        summary: event.summary,
        ok: event.ok,
        streaming: false,
      })),

    fail: (key, message) =>
      onLast(key, (turn) => ({ ...turn, error: message, ok: false, streaming: false })),

    stop: (key) => {
      controllers.get(key)?.abort();
      controllers.delete(key);
      onLast(key, (turn) =>
        turn.streaming ? { ...turn, streaming: false, stopped: true, ok: false } : turn,
      );
    },

    settle: (key) => {
      controllers.delete(key);
      onLast(key, (turn) => (turn.streaming ? { ...turn, streaming: false } : turn));
    },

    markApplied: (key, turnId) =>
      patch(key, (thread) => ({
        ...thread,
        turns: thread.turns.map((turn) =>
          turn.id === turnId && turn.flow
            ? { ...turn, flow: { ...turn.flow, applied: true } }
            : turn,
        ),
      })),

    clear: (key) => {
      controllers.get(key)?.abort();
      controllers.delete(key);
      patch(key, () => emptyThread());
    },
  };
});

/** The thread for a flow, or an empty one; never `undefined`, so the panel can render it. */
export function threadOf(state: AiState, key: string): Thread {
  return state.threads[key] ?? EMPTY;
}

const EMPTY = emptyThread();

/** True while a turn of this thread is still arriving. */
export function isStreaming(thread: Thread): boolean {
  return thread.turns.some((turn) => turn.streaming);
}

/** The conversation so far, as the route wants it: the words, without the tool noise. */
export function historyOf(thread: Thread, question: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of thread.turns) {
    const text = turn.role === 'assistant' ? turn.text.trim() : turn.text;
    if (text) messages.push({ role: turn.role, content: text });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

/** Apply an event to a thread; the panel's stream handler is this, one event at a time. */
export function applyEvent(state: AiState, key: string, event: AiEvent): void {
  switch (event.type) {
    case 'text':
      state.appendText(key, event.delta);
      break;
    case 'tool':
      state.tool(key, event);
      break;
    case 'flow':
      state.setFlow(key, event);
      break;
    case 'done':
      state.finish(key, event);
      break;
    case 'error':
      state.fail(key, event.message);
      break;
  }
}
