# Tolquane Web: the contracts between the parts

Wave 0 builds three parts at once; wave 1 and 2 build on them. These are the interfaces
they agree on. Change one here first, then in the code.

## S1. The flow model (`tolquane.web.model`)

A flow file in the house style (see `docs/style.md`) is a module with a docstring,
imports, node functions or classes, `build(source=None)` returning the graph, `main()`
and the `__main__` guard. The model is that file as data.

```python
from tolquane.web.model import (
    FlowModel, CodeOnly, parse_source, parse_file, to_python, graph_view,
    read_layout, write_layout, check_model,
)
parse_source(text: str, name: str) -> FlowModel | CodeOnly
parse_file(path: str | Path) -> FlowModel | CodeOnly
to_python(model: FlowModel) -> str             # ruff-clean, house style, deterministic
graph_view(block_or_model_or_source) -> dict    # the expanded graph, for the "threads" view
check_model(model: FlowModel) -> list[str]      # [] when tq.check passes on the generated code
read_layout(path) -> Layout | None              # the sidecar next to the flow
write_layout(path, layout: Layout) -> None
```

The command line form isolates user code from whoever calls it:

```
python -m tolquane.web.model parse flow.py        # prints the model as JSON, or {"code_only": true, "reason": ..., "graph": ...}
python -m tolquane.web.model generate model.json  # prints the Python
python -m tolquane.web.model graph flow.py        # prints graph_view as JSON
```

### FlowModel as JSON

```json
{
  "version": 1,
  "name": "word_count",
  "doc": "Count words per line with eight workers.",
  "prelude": ["import re", "PATTERN = re.compile(r\"\\w+\")"],
  "nodes": [
    {"id": "lines", "kind": "source", "is_class": false, "is_async": false,
     "params": ["path"], "doc": "Yield the lines of the file.",
     "source": "@tq.source\ndef lines():\n    ..."}
  ],
  "flow": {"type": "pipeline", "stages": [{"type": "start"}, {"type": "farm", "...": "..."}]},
  "start": "lines",
  "main": null,
  "epilogue": []
}
```

- `prelude`: every top-level statement that is not a node definition, `build`, `main`
  or the `__main__` guard, verbatim and in order (imports, constants, helper functions).
- `nodes`: in file order. `source` is the whole definition including decorator lines,
  verbatim. `kind` is one of `source`, `node`, `sink`, `raw`; `is_class` for classes
  (`__call__`, `on_start`, `on_end`), `is_async` for coroutines and async generators.
  `params` are the positional parameter names of the function or of `__call__`.
- `flow`: the tree of the expression `build()` returns.
- `start`: the id of the node used when `source is None`, following the convention
  `start = <node> if source is None else tq.from_iterable(source)`; `null` when the
  flow has no source slot (then `build` ignores `source`).
- `main`: `null` when `main()` is the standard three lines (`tq.run(build())`, or with
  `print(report)`); otherwise its source verbatim.
- `epilogue`: statements after `main` other than the guard, verbatim.
- `build_notes`: comments found inside `build()`, kept at the top of its body.
- `guard`: the statement inside `if __name__ == "__main__":` when it is not `main()`
  (`sys.exit(main())` for instance), else `null`.

As built, the parser also accepts two shapes the style allows: a file with no `build()`
whose `main()` is one `tq.run(<graph>)` call (the graph is lifted into `build()`), and
the start line written the other way round (`tq.from_iterable(source) if source is not
None else rows`). Generation always writes the forms above, so the first round trip
normalizes those, plus `workers=N` to positional and sub-block assignments in `build`
inlined into the return; from the second trip on the output is byte-stable.

### The tree

```json
{"type": "start"}
{"type": "ref", "id": "double"}
{"type": "inline", "source": "lambda x: x * 2"}
{"type": "pipeline", "stages": [ ... ]}
{"type": "farm", "worker": <tree> | [<tree>, ...], "workers": 8,
 "options": {"emit": "round_robin", "collect": null, "ordered": false, "key": <tree> | null,
             "emitter": <tree> | false | null, "collector": <tree> | false | null,
             "prefetch": 1, "window": null, "name": null, "capacity": null, "runtime": null}}
{"type": "comb", "first": <tree>, "second": <tree>}
{"type": "feedback", "inner": <tree>, "name": null}
{"type": "all2all", "left": <farm tree>, "right": <farm tree>, "R": <tree> | null, "G": <tree> | null, "merge": false}
```

Options that are absent or equal to the default are written as `null` (or the default)
and omitted when generating code. `inline` holds any expression the model does not
understand (a lambda, `tq.to_list()`, a call building a node at runtime), kept verbatim
and rendered back where it was; the canvas shows it as an expression card. A `farm`
whose worker is a list is FastFlow's heterogeneous farm.

### Parsing

Parse with `ast`: find the node definitions (decorated with `tq.` decorators, or any
`def`/`class` referenced from `build`), the prelude, `build`, `main`. Inside `build`,
accept exactly the house-style shape: an optional `start = ... if source is None else
tq.from_iterable(source)` line, optional simple assignments of sub-blocks to names
(`work = tq.farm(...)`), and a `return` whose expression is built from `>>`,
`tq.pipeline`, `tq.farm`, `tq.comb`, `tq.feedback`, `tq.all2all`, names and inline
expressions. Anything else makes the file `CodeOnly(reason=..., graph=graph_view(...))`.
After parsing, verify: generate the Python back, import both the original and the
generated module in the same process (the CLI form runs in its own process), and check
that `expand(build())` gives the same nodes, edges, loops and windows; a mismatch is
`CodeOnly` with the difference as the reason.

### Code generation

`to_python` writes: the docstring, `import tolquane as tq` and the prelude, a blank line
and each node source, `build(source=None)` with the `start` line and the return
expression on one line per stage (long farms wrapped by ruff), `main()` and the guard.
The output passes `ruff check` and `ruff format --check` with the repository's settings
and is identical after a second round trip.

### The layout sidecar

`flow.layout.json` next to `flow.py`:

```json
{"version": 1,
 "positions": {"stages.0": {"x": 0, "y": 0}, "stages.1.worker": {"x": 260, "y": 0}},
 "viewport": {"x": 0, "y": 0, "zoom": 1},
 "samples": [{"name": "three lines", "items": ["a b", "b c", "c"]}]}
```

Positions are keyed by the path of the tree element (`stages.1`, `stages.1.worker`,
`stages.1.options.emitter`); the frontend re-keys them when it edits the tree. Samples
are the sample inputs the Run panel offers; items are JSON values.

### graph_view

```json
{"nodes": [{"name": "double.0", "kind": "map", "role": "worker", "group": "double",
            "is_sink": false, "is_async": false, "tagged": false}],
 "edges": [{"src": "double.emitter", "dst": "double.0", "rule": "farm", "feedback": false,
            "capacity": null, "batch": null}],
 "loops": [{"name": "loop", "nodes": ["..."], "heads": ["..."]}],
 "windows": {"double.window": 512}}
```

## S2. Live run events (library and CLI)

```python
report = tq.run(block, ..., on_progress=callback, progress_interval=0.5, tap=0, stop=None)
```

- `on_progress(p: Progress)` is called from the run's watchdog thread every
  `progress_interval` seconds and once more when the run ends. `Progress` is:

```python
@dataclass
class Progress:
    elapsed: float
    phase: str                       # "running", "done", "failed", "cancelled", "deadlock"
    nodes: dict[str, NodeProgress]   # name -> state "new"|"running"|"waiting"|"done"|"failed",
                                     #         reason ("input"|"output"|"window"|...), detail,
                                     #         items_in, items_out, dropped, busy, wait_in, wait_out
    edges: dict[str, EdgeProgress]   # "src->dst" -> queued, high_water, capacity, taps: list[str]
    def to_dict(self) -> dict: ...
```

- `tap=N` keeps the last `N` items that crossed each edge, as `repr` cut to 200
  characters, in `EdgeProgress.taps`. Off (`0`) by default.
- `stop` is a `threading.Event`; when set, the run cancels the way an error does and
  `run()` raises `tq.RunCancelled` (a `TolquaneError`). Sessions accept it too.
- `Report.to_dict()` gives the report as JSON-ready data (nodes, edges, elapsed,
  runtime, busiest).
- Snapshots read counters without taking channel locks; the pipeline benchmark with a
  0.5 s interval stays within 2 percent of the plain run.

```
tolquane run flow.py --events [--progress-interval 0.5] [--tap 5] [--sample file] [--runtime ...]
```

With `--events` the command prints one JSON object per line on its real stdout, and
the flow's own `print` and `sys.stderr` writes become events instead of reaching the
terminal (child processes of the processes runtime still write to the terminal):

```json
{"event": "start", "graph": <graph_view>, "runtime": "threads", "flow": "flow.py"}
{"event": "progress", "progress": <Progress.to_dict()>}
{"event": "stdout", "text": "got 4\n"}
{"event": "stderr", "text": "..."}
{"event": "report", "report": <Report.to_dict()>}
{"event": "error", "type": "NodeError", "message": "...", "node": "double.1", "traceback": "..."}
{"event": "deadlock", "message": "deadlock: ..."}
{"event": "done", "status": "done" | "failed" | "cancelled" | "deadlock", "elapsed": 1.23}
```

`SIGTERM` (and `SIGINT`) set the stop event; the process exits 0 after `done`, 1 after
`failed` or `deadlock`, 130 after `cancelled`.

## S3. Storage and the scheduler (`tolquane.web.store`, `tolquane.web.cron`, `tolquane.web.scheduler`)

```python
store = Store(path)                     # SQLite; creates or migrates the schema
store.add_run(flow: str, runtime: str, sample: str | None, trigger: str) -> Run     # trigger "manual"|"schedule:<id>"|"api"
store.finish_run(run_id, status, report: dict | None, log: str, trace_path: str | None, error: str | None)
store.get_run(run_id) -> Run | None
store.list_runs(flow: str | None = None, limit: int = 50) -> list[Run]
store.add_schedule(flow, cron: str, sample: str | None, runtime: str, enabled: bool = True) -> Schedule
store.update_schedule(schedule_id, **fields) -> Schedule
store.delete_schedule(schedule_id) -> None
store.list_schedules(flow: str | None = None) -> list[Schedule]
store.get_setting(key, default=None) -> Any; store.set_setting(key, value) -> None; store.settings() -> dict
```

`Run`: `id, flow, runtime, sample, trigger, started (UTC ISO), ended, status
("running"|"done"|"failed"|"cancelled"|"deadlock"), report (dict | None), log (str, the
last 64 KB), trace_path, error`. `Schedule`: `id, flow, cron, sample, runtime, enabled,
created, last_run (id | None), last_status, next_run (UTC ISO | None)`. Settings values
are JSON. API keys are never stored here.

```python
cron = Cron.parse("*/15 8-18 * * mon-fri")   # five fields; names; ranges; steps; lists; "@hourly" and friends
cron.next_after(dt: datetime) -> datetime     # dt and result timezone-aware; the schedule's zone is the local one
cron.describe() -> str                        # "every 15 minutes from 8:00 to 18:59, Monday to Friday"
```

```python
scheduler = Scheduler(store, fire: Callable[[Schedule], None], clock=datetime.now, interval=1.0)
scheduler.start(); scheduler.stop()
scheduler.reload()                            # after schedules changed
```

The loop wakes every `interval` seconds, fires each enabled schedule whose `next_run`
has passed exactly once, records `next_run` in the store before calling `fire`, and
skips runs missed while the server was down (one fire, not a backlog). `fire` is the
server's "start a run" and must not block.

## S4. The server (`tolquane.web.server`, `tolquane.web.supervisor`)

FastAPI, started by `tolquane web [--host 127.0.0.1] [--port 8765] [--workspace DIR]
[--token T] [--no-browser] [--check]`. Everything under `/api`; OpenAPI at
`/api/openapi.json` (the frontend client is generated from it); the built frontend is
served at `/` with an SPA fallback (unknown paths return `index.html`). With `--token`,
every request needs `Authorization: Bearer T` (the WebSocket takes `?token=T`, and so
does any other request, since neither a socket nor an `EventSource` can set a header);
without it the server binds only to loopback and refuses `--host` other than
`127.0.0.1`.
`--check` starts, hits `/api/health`, stops, for CI.

### Workspace and flow paths

The workspace is one directory (`--workspace`, default the current directory, stored in
settings). A flow is a `.py` file inside it, addressed by its path relative to the
workspace with forward slashes (`{path}` below, URL-encoded; `..` and absolute paths are
rejected with 400). A flow's sidecar is `<stem>.layout.json` next to it.

### Errors

Every error is `{"error": {"type": "GraphError", "message": "...", "detail": {...}}}`
with 400 for a bad request or a flow that does not validate, 404 for unknown paths and
ids, 409 for a stale save, 401 for a bad token, 500 for the rest. `GraphError` and
`TolquaneError` messages are passed through unchanged: they already say the fix.

### Flows

```
GET  /api/flows                     -> {"workspace": "/abs/path", "flows": [{"path": "hello.py", "name": "hello",
                                        "modified": "2026-09-06T10:00:00Z", "size": 1234, "has_layout": true,
                                        "last_run": {"id": 12, "status": "done", "ended": "..."} | null}]}
POST /api/flows                     {"path": "new.py", "template": "empty" | "hello" | {"model": <FlowModel>}} -> the flow (below)
GET  /api/flows/{path}              -> {"path": ..., "source": "...", "modified": ..., "model": <FlowModel> | null,
                                        "code_only": {"reason": "..."} | null, "graph": <graph_view>, "layout": <Layout> | null}
PUT  /api/flows/{path}              {"source": "...", "modified": <the modified you were given>} -> the flow; 409 with the
                                     current source when the file changed since (client shows a diff)
PUT  /api/flows/{path}/layout       <Layout> -> {"ok": true}
DELETE /api/flows/{path}            -> {"ok": true}
POST /api/flows/{path}/rename       {"path": "other.py"} -> the flow
POST /api/flows/parse               {"source": "...", "name": "flow"} -> {"model": ... | null, "code_only": ... | null, "graph": ...}
POST /api/flows/generate            {"model": <FlowModel>} -> {"source": "..."}
POST /api/flows/{path}/check        -> {"ok": true, "nodes": 12, "edges": 14} or 400 with the GraphError
POST /api/flows/{path}/explain      -> {"text": "..."}
POST /api/flows/{path}/draw         -> {"mermaid": "..."}
POST /api/flows/{path}/optimize     {"all2all": false} -> {"source": null, "notes": ["..."], "graph": <graph_view>}
```

`parse`, `generate`, `check`, `explain`, `draw` and `optimize` run user code, so the
server runs them in a child process through `python -m tolquane.web.model ...` and
`python -m tolquane ...` with a timeout (settings `exec_timeout`, default 30 s), never
by importing the flow itself. (`optimize` has no command line form that answers with
data, so its child runs `tq.optimize` and prints the notes and the graph as JSON.)
As built, `optimize` answers `"source": null`: `tq.optimize` rewrites the block tree at
run time and there is no way back from it to Python yet, so the notes and the optimized
graph are what the canvas shows, and the last note says to run with `optimize` set.
`generate` is pure text and runs in the server itself; nothing is imported.

### Runs

```
POST /api/runs                      {"path": "hello.py", "runtime": "threads" | "processes" | "sync",
                                     "sample": "three lines" | null, "batch": 32, "tap": 5, "trace": false,
                                     "optimize": false} -> <Run>
GET  /api/runs?flow=hello.py&limit=50 -> {"runs": [<Run>]}   (with "log": "", which can be 64 KB each)
GET  /api/runs/{id}                 -> <Run> (the store's Run.to_dict(), plus "live": true while running)
POST /api/runs/{id}/cancel          -> <Run>
GET  /api/runs/{id}/log             -> text/plain, the captured stdout and stderr
GET  /api/runs/{id}/trace           -> the Chrome trace file, 404 when the run had none
WS   /api/runs/{id}/events          -> every event line of the run as a JSON message, in order; a client that
                                     connects late first receives the events so far (the supervisor keeps them
                                     in memory until the run ends and for 10 minutes after), then live ones; the
                                     socket closes after the "done" event. A run whose events have been forgotten
                                     answers with one "done" carrying its stored status; an unknown id, with one
                                     "error"
```

The supervisor owns the child processes: `python -m tolquane run <path> --events
--progress-interval 0.5 --tap N [--sample tmpfile] [--runtime R] [--batch B] [--trace
file] [--optimize]` with the workspace as the working directory and the flow's directory
on `sys.path`. It limits concurrent runs (setting `max_concurrent_runs`, default 4;
beyond it `POST /api/runs` answers 429), records every event into the run's log (the
store keeps the last 64 KB), writes the report and status to the store on `done`, sends
SIGTERM on cancel and SIGKILL after `cancel_grace` seconds (default 10), and kills every
child when the server exits. A sample is written to a temporary `.json` file the CLI
reads with `--sample`.

### Schedules

```
GET    /api/schedules?flow=          -> {"schedules": [<Schedule> + {"description": cron.describe(), "next_five": [...]}]}
POST   /api/schedules                {"flow": "hello.py", "cron": "*/15 * * * *", "sample": null, "runtime": "threads",
                                      "enabled": true} -> <Schedule>; 400 with the cron error otherwise
PUT    /api/schedules/{id}           any of the fields above -> <Schedule>
DELETE /api/schedules/{id}           -> {"ok": true}
POST   /api/schedules/{id}/run       -> <Run>   (fire now)
POST   /api/schedules/preview        {"cron": "..."} -> {"description": "...", "next_five": ["..."]}
```

The scheduler's `fire` starts a run with trigger `schedule:<id>` through the supervisor.

### Settings

```
GET /api/settings  -> {"workspace": "...", "default_runtime": "threads", "default_batch": 32, "exec_timeout": 30,
                       "max_concurrent_runs": 4, "cancel_grace": 10, "theme": "dark",
                       "ai": {"provider": "anthropic", "model": null, "has_anthropic_key": true, "has_openai_key": false},
                       "server": {"host": "127.0.0.1", "port": 8765, "token_set": false}}
PUT /api/settings  any subset of the above; "ai.anthropic_key" and "ai.openai_key" may be sent to store a key
```

Keys never enter the SQLite store: the server writes them to `~/.tolquane/web.toml`
with mode 600 (or the file named by `TOLQUANE_WEB_CONFIG`), reads them from there or
from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the environment, and only ever reports
whether one is set. Every other setting lives in the store. `workspace`, `server.host`
and `server.port` are what the *next* `tolquane web` starts with when no flag says
otherwise: a running server keeps the ones it was given, and `GET /api/health` is where
the live workspace is. A setting the server does not know, or a value it cannot use, is
a 400 naming it rather than a value nothing reads.

### AI chat

```
POST /api/ai/chat   {"path": "hello.py" | null, "messages": [{"role": "user", "content": "..."}], "provider": ..., "model": ...,
                     "sample": "three lines" | null}
                    -> text/event-stream
```

Events: `{"type": "text", "delta": "..."}` for the assistant's words, `{"type":
"tool", "name": "write_flow", "status": "started" | "done", "summary": "...", "error":
false}` for each tool call the builder makes, `{"type": "flow", "source": "...",
"model": ..., "graph": ...}` when the builder has written or changed the flow (the
frontend offers "apply"), `{"type": "done", "usage": {...}, "ok": true, "summary":
"..."}`, `{"type": "error", "message": "..."}`. The server runs `tolquane.ai.Builder`
in a directory of its own under the workspace (`.tolquane-web/ai/<id>`, removed when the
stream ends) seeded with the open flow's source, so `write_flow` can never touch the
open file: the client applies the result through `PUT /api/flows/{path}`. The open
flow's source and the sample are in the first user turn's context, along with the
earlier messages of the conversation.

### Health

`GET /api/health -> {"ok": true, "version": "1.2.0", "workspace": "...", "runs_live": 1, "scheduler": true}`
