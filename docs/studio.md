# Tolquane Studio: the web GUI, broken down

**Status:** plan, 2026-09-06. Nothing below is built yet. This page is the contract the
sub-problems are built against; each one is small enough for one agent to finish and test
on its own.

## What it is

A local web application, started with `tolquane studio`, that lets anyone create, see,
test, run, debug and schedule Tolquane flows on a canvas the way n8n does with
workflows, with the Python code always one click away and editable, and the AI builder
in a side panel. It is an optional extra (`pip install "tolquane[studio]"`). The library
stays dependency-free, and every flow the Studio makes is a plain `flow.py` that runs
with `python flow.py` on a machine that has only `tolquane` installed.

## Decisions that shape everything

1. **The Python file is the artifact; the canvas is a view of it.** A flow is a
   `flow.py` in the house style, with `build(source=None)` and `main()`, exactly what the
   AI builder writes and the CLI runs today. The Studio keeps a *flow model* (JSON) that
   it reads out of the file by importing it and walking the block tree, and writes back
   as Python by the same code generator the builder's style asks for. Node bodies are
   kept verbatim as source text in the model, so a round trip changes nothing a person
   wrote. Canvas positions live in a sidecar, `flow.layout.json`, never in the `.py`.
   A file the model cannot represent (a `Graph.link` topology, a node built at runtime)
   opens in *code-only mode*: the canvas shows the expanded graph read-only, the editor
   works, run and debug work.
2. **The canvas shows blocks, not threads.** Nodes on the canvas are what people write:
   source, node, sink, raw, farm (with its worker inside as a nested card), comb,
   feedback, all-to-all. `>>` is an edge. A toggle shows the expanded graph
   (`tq.draw`), the threads that will actually run.
3. **Flows run in a child process, never in the server.** A run is
   `tolquane run flow.py --events` in a subprocess; it streams JSON lines (node state,
   counts, busy time, sampled items, stdout, the report, errors, deadlock reports) that
   the server relays over a WebSocket. A hung or crashing flow cannot take the Studio
   down, and cancel is a signal.
4. **One server, local by default.** FastAPI and uvicorn, bound to `127.0.0.1`, no
   login. `--host 0.0.0.0 --token ...` for a shared machine. SQLite in
   `~/.tolquane/studio.db` for runs, schedules and settings; flows are files in a
   workspace directory the user picks.
5. **Frontend: React, TypeScript, Vite, `@xyflow/react` for the canvas, CodeMirror 6
   for code, Zustand for state.** Built assets ship inside the wheel, so `pip install`
   is all a user does. Node is a build-time tool only.
6. **The AI builder is the same `tolquane.ai.Builder`,** given the open flow as context,
   streaming its turns and tool calls into the panel; when it writes a flow the canvas
   updates. Keys live in the Studio settings file with owner-only permissions, or in the
   environment; never in the database, never in a flow.

## Layout in the repository

```
src/tolquane/studio/      the Python side: model, codegen, events, server, storage, scheduler
web/                      the frontend source (Vite project); builds into src/tolquane/studio/static/
docs/studio.md            this page; docs/studio-user.md later, the user guide
tests/studio/             Python tests; web/tests for frontend unit tests; e2e under web/e2e
```

## The sub-problems

Each has a name, an owner-sized scope, what it depends on, and how it is known to be
done. "Interface" means the thing the others build against.

### Wave 0: foundations (Python only, all three in parallel)

**S1. Flow model, code generator, parser.** `tolquane.studio.model`.
- Interface: a JSON schema `FlowModel` (nodes with `id, name, kind, params, source`;
  a composition tree of `pipeline | farm | comb | feedback | all2all | node` with their
  options; sample inputs; metadata), `to_python(model) -> str`, `from_python(path) ->
  FlowModel | CodeOnly`, `layout` sidecar read and write.
- Done when: every file in `examples/` and `examples/generated/` round-trips
  (`from_python` then `to_python` gives a file whose `build()` expands to the same graph
  and whose node sources are byte-identical); generated code passes `ruff` and the house
  style test; code-only fallback is exercised by the MSOM example.

**S2. Live run events in the library and CLI.** `tolquane.run(..., on_progress=,
progress_interval=, tap=)` and `tolquane run --events`.
- Interface: a `Progress` snapshot (per node: state, items in and out, busy and wait
  seconds, queue depths per edge; per run: elapsed, phase) delivered to a callback on an
  interval and at the end; `tap=N` keeps the last N items per edge as truncated reprs
  and includes them; `--events` prints one JSON object per line (`progress`, `stdout`,
  `stderr`, `report`, `error`, `deadlock`, `done`); SIGTERM cancels the run cleanly and
  reports it as `cancelled`.
- Done when: tests show snapshots on threads, processes and sync; taps see items;
  cancel ends within the deadlock timeout; overhead under 2 percent on the pipeline
  benchmark with a 0.5 s interval.

**S3. Storage and scheduler.** `tolquane.studio.store`, `tolquane.studio.schedule`.
- Interface: SQLite schema and a repository for `runs` (id, flow path, started, ended,
  status, report JSON, log excerpt, trace path), `schedules` (id, flow, cron, sample,
  runtime, enabled, last and next run), `settings` (key, value); a five-field cron
  parser with `next_after(dt)`; a scheduler loop that fires due schedules through a
  callback and survives restarts.
- Done when: parser tests cover ranges, steps, lists, names and DST; the loop fires
  exactly once per due minute in a simulated clock; the store migrates from an empty
  file.

### Wave 1: the server and the app shell (parallel once wave 0 interfaces are fixed)

**S4. Server.** `tolquane.studio.server`, FastAPI.
- Interface: REST for the workspace (list, open, save, create, delete, rename flows),
  model (parse, generate, check, explain, draw, optimize), runs (start with sample or
  source, cancel, list, get, log, trace download), schedules, settings, AI chat
  (server-sent events with turns and tool calls, apply result); a WebSocket per run
  relaying S2's events; a supervisor that owns child processes, limits concurrent runs
  and kills orphans on exit; static serving of the built frontend; `tolquane studio`
  opens the browser. OpenAPI is the contract the frontend client is generated from.
- Done when: `httpx` tests cover every route, a run's events arrive over the socket, a
  crashing flow leaves the server healthy, and `tolquane studio --check` starts and
  stops the server in CI.

**F1. App shell.** Vite, React, TypeScript; routes for Flows, Editor, Runs, Schedules,
Settings; a typed API client generated from the OpenAPI file; a WebSocket hook; theme;
error toasts.
- Done when: the shell builds, the client compiles against the server's OpenAPI, and
  a smoke test loads every route.

### Wave 2: the editor and the tools (parallel, each against S4 and F1)

**F2. Canvas editor.** Block cards per kind with a palette to drag from, `>>` edges,
farms as containers holding their worker card, feedback as a container with the loop
edge drawn, all-to-all as two farms side by side, property panels for every option
(workers, emit, collect, ordered, key, prefetch, capacity, runtime, custom ends),
auto-layout (dagre) for files without a sidecar, `check` errors shown on the offending
card, undo and redo, expanded-graph toggle.
- Done when: every example builds on the canvas without code-only mode, edits regenerate
  code that round-trips, and a flow drawn from an empty canvas runs.

**F3. Code view and edit.** CodeMirror with Python mode, two-way sync (canvas edit
regenerates code; code edit re-parses and updates the canvas, with a clear message when
the file drops to code-only), per-node body editor in the property panel, diff before
overwriting a file changed on disk.

**F4. Run and debug.** Run with the source or a sample (samples saved with the flow),
live overlay on the cards (state colour, items, busy percent), queue depth on edges,
tapped items in a side drawer per edge, console for stdout and stderr, errors and
deadlock reports pointing at the card, the report table, trace download, run history
with re-run.

**F5. AI panel.** Chat with streaming, the builder's tool calls shown as steps, "apply
to editor", quick actions (explain this flow, make it faster, add a stage that ...),
provider and model picked from settings.

**F6. Schedules and settings.** Cron editor with a human preview and the next five
times, enable and disable, last result; settings for providers and keys, workspace
directory, default runtime and batch, run limits, server host, port and token, theme.

### Wave 3: packaging, tests, docs

**I1. Build and ship.** Hatch build hook that runs `npm ci && npm run build` and puts
the assets in the wheel; CI job with Node; `tolquane[studio]` extra; the wheel works
without Node installed.
**I2. End-to-end tests.** Playwright journeys: create a flow from the palette, run it
with a sample, see items in a tap, ask the AI to change it, schedule it.
**I3. User guide and hardening.** `docs/studio-user.md` with screenshots; token auth,
CORS, path checks so the workspace cannot be escaped, Windows and macOS paths.

### Later, not in the first release

A deploy editor (assign cards to groups, write `deploy.toml`, launch and watch every
group), a gallery of templates, sharing a flow as a link, multi-user workspaces,
breakpoints that pause a node.

## Order and parallelism

Wave 0 runs as three agents at once; their interfaces are written down first (the JSON
schema, the events format, the store API) so wave 1 can start on them before the code
is final. Wave 1 is two agents. Wave 2 is up to five agents, each owning one area of the
frontend against the running server. Wave 3 closes. The orchestrating session writes
the interface documents, reviews every merge against the "done when" line, and keeps
the library's own tests green throughout: S2 is the only sub-problem that touches
`src/tolquane/` outside `studio/`.

## Risks

- Round-tripping arbitrary Python is the hard part of S1. The house style makes it
  tractable (one function per node, `build()` composes blocks); anything else falls back
  to code-only mode rather than losing code.
- Event overhead: snapshots read counters without locks; taps copy reprs, so `tap`
  defaults to off outside the Studio.
- Frontend size: CodeMirror and the canvas library together stay under 1 MB gzipped;
  Monaco was rejected for that reason.
- Agents cannot see the browser. Every frontend sub-problem carries unit tests on its
  logic and an e2e journey in I2; the orchestrator inspects screenshots from Playwright.
