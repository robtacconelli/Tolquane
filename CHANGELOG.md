# Changelog

## 1.3.0, 2026-09-06

Four additions to Tolquane Web, chosen after the first release.

- **Users.** Accounts with roles (admin, member), sessions and personal API tokens,
  a login page with first-admin setup and a forced password change, a users page
  for admins, `tolquane web users add|list|disable|enable|passwd`. A local server
  with no users keeps working with no login; the first user turns sign-in on.
  Runs and schedules record who started them.
- **Inputs and environments.** `build(source=None, *, name: type = default)`
  declares parameters that the run popover, schedules and `tolquane run --param`
  set; per-run and per-schedule environment variables and `--env`; an interpreter
  per workspace checked by importing tolquane; a workspace environment; missing
  imports reported on Check with their pip name.
- **History.** When the workspace is a git repository, a history tab shows every
  version of a flow with its diff, restores one, and commits on save with a
  message (or automatically); the AI panel's changes commit with the request as
  the message. `git init` from the app for a workspace without history.
- **Schedule outcomes.** Notify by webhook or mail on chosen statuses, retries
  with a delay as a chain of runs that notifies once at the end, a test send,
  and the attempts listed on the run.

## 1.2.0, 2026-09-06

**Tolquane Web**, the GUI: `pip install "tolquane[web]"`, then `tolquane web`. The plan
is `docs/web.md`, the contracts `docs/web-interfaces.md`, the guide `docs/web-user.md`.

- A flow is still a plain `flow.py`. The editor reads it into a model, shows it as
  block cards on a canvas (farms and loops as containers, all-to-all as two farms with
  the cross edges), writes it back in the house style, and keeps positions in a
  `flow.layout.json` sidecar. What the model cannot say opens in a code-only mode.
- Canvas and code edit each other: typing re-parses after a pause, canvas edits
  regenerate the file, node bodies are edited in the properties panel, a save that
  would overwrite a change on disk shows a diff.
- Runs happen in a child process that streams events: cards colour by state, counters
  and busy time move, taps show items on an edge, the drawer has the console, the
  report and the problems pointing at their card; errors and deadlocks land on the
  card that caused them. A runs page keeps the history with re-run and cancel.
- The AI builder in a side panel: streamed answers, tool steps, a flow card with a
  diff and apply-to-editor that respects undo, threads kept per flow.
- Schedules with cron presets and a live preview of the next times; settings for the
  workspace, runs, AI keys (a mode-600 file or the environment, never echoed), server
  and appearance.
- One local FastAPI server with SQLite for runs, schedules and settings; a token wall
  for shared machines; a workspace fence; children never see API keys; a bounded
  event buffer; a content security policy.

**Library**

- `tq.run(..., on_progress=, progress_interval=, tap=, stop=)`: live snapshots of every
  node and edge, the last items per edge, a stop event that raises `RunCancelled`;
  `Report.to_dict()`; `tolquane run --events` prints one JSON object per line and
  `--trace FILE` writes a Chrome trace.
- `tolquane run` accepts a flow whose `main()` calls `tq.run` once.
- A source whose sends are all dropped after cancellation now stops instead of
  spinning until the join timeout.

## 1.1.0, 2026-09-06

What a review of FastFlow (see `docs/decisions/0002-fastflow-review.md`) showed was
worth taking.

- **Any block as a farm worker.** `tq.farm(a >> b, 4)` copies the pipeline four times;
  farms, feedback loops and all-to-alls work the same, and all-to-all sets may hold them.
  Copies are named `farm.<i>.<node>`; deploy files and `runtime="processes"` address them
  as workers of that farm.
- **`tq.optimize(block)`.** Fewer threads, same results: a stage before a farm becomes its
  emitter, a farm's default collector goes when the next stage can read the workers,
  an ordered farm's collector absorbs the next stage, a farm of farms becomes one farm,
  and, on request, two farms in a row become an all-to-all. Also `tolquane optimize`
  and `tolquane run --optimize`.
- **`tolquane launch deploy.toml flow.py`.** Starts every group of a deploy file, here
  or over `ssh`, with prefixed output; one failure stops the rest. `ssh`, `python` and
  `workdir` per group or in `[options]`.
- **Busy and wait time per node** in the run report, and `report.busiest()`.
- Eleven FastFlow composition tests ported.

## 1.0.0, 2026-09-05

The first release, built from the design in `DESIGN.md` on the vocabulary of the
FastFlow building blocks and the lessons of BBFlow, its Java predecessor.

### Blocks
- A function is a node: `def f(x)` returns what to send, `tq.SKIP` sends nothing,
  `None` is a value, a generator yields many, `def f(x, ctx)` sends explicitly, a class
  holds state with `on_start` and `on_end`, `@tq.raw` has full control.
- `>>` pipelines with the five FastFlow wiring rules; farms with round-robin, on-demand,
  broadcast, scatter and keyed emitters and first-come, round-robin, gather and
  ordered collectors, custom or absent ends, lists of different workers; `comb()`
  fusion; `all2all()` with its eight cases; `feedback()` with a termination rule;
  `session()`; `Graph.link()` for topologies the blocks cannot say.

### Runtimes
- Threads, with one inbox per node, bounded edges, batching, EOS as a message, errors
  that cancel the run and name the node, and a deadlock detector that names the cycle.
- Processes: farm workers in spawned children, everything else in the parent, credits
  kept exact by a completion marker per item; 5.5x on eight workers on a GIL build.
- Async nodes: `async def` nodes on an event loop, and a farm of them as one pool
  running `workers` coroutines at a time on one thread.
- Distributed: a deploy file cuts the graph into groups; edges between groups are TCP
  channels with backpressure, resend after a drop, and an optional shared secret.
- Sync: deterministic, one node at a time, exact deadlock detection, for tests.

### Tools
- `tq.check`, `tq.explain`, `tq.draw`, `trace=` for Chrome trace files, `tq.to_list`
  and `tq.from_iterable` for tests.
- The AI builder: `tolquane build "..."` and `tolquane.ai.build()`, Claude Opus 5 by
  default or GPT, writes, checks and runs a flow and takes change requests; ten flows it
  wrote are in `examples/generated`.
- `tolquane check | run | explain | draw` on any file that defines `build(source=None)`.

### Provenance
- Every BBFlow program has a counterpart test, including the MSOM use case with grid
  links, whose parallel map equals the sequential one exactly.
