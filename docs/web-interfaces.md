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
- `params`: `build()`'s keyword-only parameters, in order, as section E describes them;
  `[]` when it has none, and absent in a model written before 1.3.
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
every request under `/api` needs `Authorization: Bearer T` (the WebSocket takes
`?token=T`, and so does any other request, since neither a socket nor an `EventSource`
can set a header); without it the server binds only to loopback and refuses `--host`
other than `127.0.0.1`.
`--check` starts, hits `/api/health`, stops, for CI.

The token is enforced one layer outside the routes as well as on each of them, so
`/api/openapi.json` and `/api/docs`, which FastAPI adds itself, need it too, and an
unknown `/api` path answers 401 rather than 404. It is compared with
`hmac.compare_digest` and redacted (`token=<hidden>`) in every log line. The static files
are served without it: the page is what asks the user for the token, and it reads the
token from `localStorage` under `tolquane.token`. No CORS header is ever sent. The SPA
response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a
Content-Security-Policy whose `script-src` is `'self'` plus the sha256 of each inline
script in `index.html`, `connect-src` is `'self' ws: wss:`, and `style-src` is
`'self' 'unsafe-inline'` (the code editor and the canvas insert their own stylesheets).

### Workspace and flow paths

The workspace is one directory (`--workspace`, default the current directory, stored in
settings). A flow is a `.py` file inside it, addressed by its path relative to the
workspace with forward slashes (`{path}` below, URL-encoded; `..`, absolute paths, a
Windows drive or share, and anything that resolves outside the workspace through a
symlink are rejected with 400, whether the path is being read, written, renamed or
created). A flow's sidecar is `<stem>.layout.json` next to it, checked the same way: a
sidecar that is itself a symlink pointing out is refused. The flow listing skips hidden
directories, `.tolquane-web/` and anything the server would refuse to open.

### Errors

Every error is `{"error": {"type": "GraphError", "message": "...", "detail": {...}}}`
with 400 for a bad request or a flow that does not validate, 404 for unknown paths and
ids, 409 for a stale save, 401 for a bad token, 413 for a body or a source over
`max_source_bytes`, 429 for the concurrent run limit, 500 for the rest. `GraphError` and
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
                                     "error". At most MAX_EVENTS (5000) are kept per run: when a flow sends more,
                                     the oldest go (never the "start" event) and a late client is told once, right
                                     after "start", with {"event": "dropped", "count": N, "message": "..."}; the
                                     log and the report are whole either way
```

The supervisor owns the child processes: `python -m tolquane run <path> --events
--progress-interval 0.5 --tap N [--sample tmpfile] [--runtime R] [--batch B] [--trace
file] [--optimize]` with the workspace as the working directory and the flow's directory
on `sys.path`. No child inherits a secret: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`TOLQUANE_WEB_TOKEN` and any variable whose value is the access token are taken out of
the environment of every child, the one-shot commands included; the AI chat is the only
thing that needs a key, and it is handed one directly. It limits concurrent runs (setting `max_concurrent_runs`, default 4;
beyond it `POST /api/runs` answers 429), records every event into the run's log (the
store keeps the last 64 KB), writes the report and status to the store on `done`, sends
SIGTERM on cancel and SIGKILL after `cancel_grace` seconds (default 10), and kills every
child when the server exits. A child that outlives SIGKILL by another `cancel_grace` is
given up on: the run is recorded as `failed` with an error naming the process rather than
left `running` for ever. At startup the supervisor clears everything under
`.tolquane-web/` (traces, samples, scratch) older than `keep_traces_days`. A sample is written to a temporary `.json` file the CLI
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
                       "max_concurrent_runs": 4, "max_source_bytes": 2000000, "cancel_grace": 10,
                       "keep_traces_days": 7, "theme": "dark",
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

# 1.3: users, inputs and environments, history, schedule outcomes

Four additions, built against the contracts below. Version 1.3.

## U. Users and sessions

**Modes.** `GET /api/auth/me` reports `mode`: `local` (bound to loopback, no `--token`,
no users defined: every request is the implicit admin `local`, no login), `users`
(at least one user exists: login required, on loopback too), `token` (`--token` given
and no users yet: the token acts as an admin API token, and lets the first admin be
created from the login page). The `--token` value keeps working as an admin API token
in every mode, for scripts and setup.

With `--token` *and* users, the wall of S4 takes a session or an API token as well as
the token itself, and the public routes (`GET /api/health`, `GET /api/auth/me`,
`POST /api/auth/login`) stop asking for the token: a login page that needed the token
to offer a login box would be a lock with two keys. With `--token` and no users -- token
mode -- nothing under `/api` answers without it, exactly as in 1.2.

**Store.** `users(id, name unique, role 'admin'|'member', password_hash, created,
disabled, must_change_password)` with `hashlib.scrypt` (`n=2**14, r=8, p=1`, per-user
salt, stored as `scrypt$<salt b64>$<hash b64>`); `sessions(id, token_hash sha256,
user_id, kind 'session'|'api', label, created, expires, last_seen)`. Session tokens
are `secrets.token_urlsafe(32)`, shown once, sliding 30-day expiry; API tokens do not
expire. `runs` and `schedules` gain a `user` column (the name; `local` in local mode,
and `local` for every row written before 1.3). A password change keeps the sessions
that were open: it is made from one of them. Disabling a user stops theirs at once, and
deleting a user takes them with it.

**Routes.**

```
POST /api/auth/login        {"name", "password"} -> {"token", "user"}; 401 on a wrong pair, 403 when disabled
POST /api/auth/logout       -> {"ok": true}   (the session is deleted)
GET  /api/auth/me           -> {"user": {"id", "name", "role", "created", "disabled", "must_change_password", "last_seen"} | null,
                                "mode": "local"|"users"|"token", "can_setup": true when mode is token and no users exist}
                            local mode and the --token value are users too, with id 0 and the names `local` and `token`
POST /api/auth/setup        {"name", "password"} -> 201 {"token", "user"}, signed in as the first admin;
                            only in token mode with the token, 409 afterwards, 403 without --token
POST /api/auth/password     {"current", "new"} -> {"ok": true}; clears must_change_password; 401 on a wrong current
GET  /api/auth/tokens       -> {"tokens": [{"id", "label", "created", "last_seen"}]}
POST /api/auth/tokens       {"label"} -> 201 {"id", "token", "label"}   (the token is shown once)
DELETE /api/auth/tokens/{id} -> {"ok": true}; somebody else's token id is a 404
GET  /api/users             admin -> {"users": [{"id", "name", "role", "created", "disabled", "must_change_password", "last_seen"}]}
POST /api/users             admin {"name", "role", "password"} -> 201, the user (must_change_password true)
PUT  /api/users/{id}        admin {"role"?, "disabled"?, "password"?} -> the user; 400 when it would leave no enabled admin;
                            a new password sets must_change_password
DELETE /api/users/{id}      admin -> {"ok": true}; 400 for yourself or the last admin
```

The bearer token is a session token, an API token, or the `--token` value, in the
`Authorization` header or as `?token=`. The three `/api/auth` routes that are about an
account -- `password`, `tokens`, `tokens/{id}` -- answer 400 to the local admin and to
the `--token` value, which are not people and have no password to change.
Passwords are at least 8 characters. Names are `[a-z0-9_.-]{2,32}`, lower-cased.

**Roles.** `member`: flows, runs, schedules, AI, history; `GET /api/settings` (the
`server` section and the `has_*_key` flags come back `null`); `PUT /api/settings` only
for `theme`, and 403 naming the other fields. `admin`: everything, including users,
settings, keys, `history/init`. A route the role cannot use answers 403 `{"error":
{"type": "Forbidden", ...}}`. `GET /api/health` needs no login and leaves `workspace`
out altogether when the caller is not signed in. The table lives in
`tolquane.web.server.ROUTE_ROLES`, as data: everything under `/api/users` is `admin`,
`GET /api/health`, `GET /api/auth/me`, `POST /api/auth/login` and `POST /api/auth/setup`
are public, and everything else needs a signed-in member.

**CLI.** `tolquane web users add NAME [--admin] [--password P]` (prompts when no
`--password`, twice, and refuses two that differ), `users list`, `users disable NAME`,
`users enable NAME`, `users passwd NAME [--password P]`; all operate on the store named
by `TOLQUANE_HOME` or the defaults, without a running server. A user made at the command
line is not asked to change their password: whoever typed it chose it. A duplicate name,
a name that is not a name, a password under 8 characters, an unknown user and disabling
the last administrator each print one line and exit 1.

**Frontend.** A `/login` page (name, password; "create the first admin" in token
mode; the token dialog stays for token mode); an account menu at the bottom of the
sidebar (name, role, change password, personal API tokens, sign out); a `/users` page
for admins (list, create with a temporary password shown once, change role, disable,
reset password, delete); route guards (members never see Users, and Settings hides
the admin sections); a 401 anywhere sends to `/login` and back afterwards; a forced
password change on first login.

## E. Inputs and environments

**Parameters.** A flow may declare keyword-only parameters after `source`, each with a
literal default: `def build(source=None, *, threshold: float = 0.5, path: str =
"data.csv")`. The model gains `params: [{"name", "default": "<python literal source>",
"annotation": "<source>" | null}]`, in order; the code generator writes them back; a
parameter without a default, or a default that is not a literal (`ast.literal_eval`),
makes the file `CodeOnly` with that reason.

**CLI.** `tolquane run|check|explain|draw flow.py --param name=value` (repeatable;
`value` goes through `ast.literal_eval`, a plain word stays a string) and
`tolquane run --env NAME=value` (repeatable). `build()` is called with the parameters
as keywords; unknown names are an error naming the flow's parameters. `--env` is applied
to the process environment before the flow module is imported and put back afterwards,
so an in-process caller is left as it was found. The `--events` `start` event carries
`params` (what `--param` gave, JSON-safe) and `env` (names only).

**Runs and schedules.** `POST /api/runs` and the schedule bodies gain `params: {name:
value}` and `env: {NAME: value}` (both JSON, stored with the run and the schedule);
`Run.to_dict()` and schedules return them. The supervisor passes `--param`/`--env`
to the child; per-run env is applied after the workspace env below and after the
secret stripping, so a run can set anything except the server's own keys.

**Workspace settings.** `python`: the interpreter for runs and one-shot commands
(default: the server's own `sys.executable`); on `PUT`, the server runs it with
`-c "import tolquane, sys; print(tolquane.__version__)"` and answers 400 with a `pip
install tolquane` line when that fails or the major version differs. `env: {NAME:
value}`: applied to every run; admins see values, members see names only
(`env_names`). Both in `GET /api/settings`.

**Import probe.** `tolquane.web.probe.probe_imports(source: str, python: str, *, path=None,
timeout=20.0) -> list[Probe]` with `Probe(module, ok, hint)`: the top-level modules the
file imports (ast, every statement including the ones inside functions), minus the
standard library (`sys.stdlib_module_names`), `tolquane` and the flow's own neighbours
(a `.py` or a package next to `path`, which is why the call takes one), each tried with
`python -c "import <module>"` in one child call, in sorted order; `hint` is `pip install
<name>` with a small map for the usual renames (`cv2` opencv-python, `PIL` pillow,
`sklearn` scikit-learn, `yaml` pyyaml, `bs4` beautifulsoup4, `dotenv` python-dotenv).
An interpreter that cannot be run or does not answer within `timeout` is not an
exception: every module comes back `ok=False` with `could not ask <python>: <reason>`.
`POST /api/flows/{path}/check` gains `"imports": [Probe]`; the frontend shows a
missing import as a warning in Problems with the hint, and the Run popover shows the
interpreter in use.

**Frontend.** The Run popover gains a Parameters section (one field per parameter,
typed from the default: number, boolean toggle, text, or a code field for anything
else; last values remembered per flow in localStorage) and an Environment section
(name/value rows); the schedule dialog gains the same two; the properties panel of the
start card lists the parameters and lets the user add, rename, retype and remove them
(a model edit that regenerates `build()`); Settings gains Interpreter and Workspace
environment rows (admin).

## H. History of a flow

Git, through `subprocess`, nothing else. Everything degrades to "history unavailable"
with a reason when `git` is not on PATH or the workspace is not in a repository.

```
GET  /api/workspace/history          -> {"available": bool, "reason": str | null, "repo": bool, "root": path | null, "dirty": n}
POST /api/workspace/history/init     admin -> {"ok": true}   (git init in the workspace; writes .gitignore with .tolquane-web/ and __pycache__/)
GET  /api/flows/{path}/history?limit=50 -> {"entries": [{"rev", "short", "author", "date", "message", "head": bool}], "uncommitted": bool}
GET  /api/flows/{path}/history/{rev} -> {"rev", "source", "diff": "<unified diff, that revision against the file now>"}
POST /api/flows/{path}/restore       {"rev"} -> the flow (the file and its sidecar as they were at rev; not committed)
PUT  /api/flows/{path}               gains optional "commit": {"message": "..."}; the response gains "commit": {"rev", "short"} | null
```

`git log --follow` for the entries; `git show rev:path` for a version; the sidecar
is included in commits and restores when it exists. Commits use `--author "<user
name> <name@tolquane.local>"` and only add the flow's own files. Setting
`auto_commit: bool` (default false): every save commits, with the given message or
`Edit <path>`; the AI apply passes `AI: <first line of the request>`; a restore does
not commit. Nothing ever runs `git push`, `reset` or `checkout`.

**Frontend.** The editor's right column gains a History tab (Properties | AI |
History): the entries with relative dates, author and message, "uncommitted changes"
on top when the file differs from HEAD, click to see the diff (the existing diff
view), Restore with a confirmation, Initialize history when the workspace is not a
repository (admin), and Save with message (Cmd/Ctrl+Shift+S) as a small dialog; the
Save button shows a dot while uncommitted changes exist.

## N. Schedule outcomes

**Schedule fields.** `notify: {"events": ["failed", "deadlock", "cancelled", "done"],
"webhook": url | null, "emails": [address]}` (default: no events), `retries: 0..5`
(default 0), `retry_delay: seconds` (default 60). A retry re-runs the flow after a
`failed` or `deadlock` end, never after `cancelled`, as a new run with trigger
`retry:<schedule id>:<attempt>`; the notification for the schedule fires once, after
the last attempt, with the final status and the attempt count.

**Settings.** `notifications: {"webhook_default": url | null, "smtp": {"host", "port",
"username", "from", "starttls": bool} | null, "has_smtp_password": bool}`; `PUT` accepts
`notifications.smtp_password` write-only (it goes to the key file). A schedule with
`webhook: null` uses the default; emails need the SMTP settings, else the attempt is
recorded as failed with the reason.

**Delivery.** Webhook: `POST` JSON `{"event", "status", "attempts", "flow", "schedule":
{"id", "cron"}, "run": <Run.to_dict()>, "busiest", "error", "log_tail": "<last 2 KB>",
"url": "<server url>/runs/<id>"}` with a 10 s timeout and one retry after 30 s.
Email: `smtplib`, STARTTLS when set, subject `[Tolquane] <flow>: <status>`, a plain
text body with the same facts. Attempts are recorded in `notifications(id, run_id,
schedule_id, channel 'webhook'|'email', target, status 'sent'|'failed', error,
created)`.

```
GET  /api/runs/{id}/notifications    -> {"notifications": [...]}
POST /api/schedules/{id}/test        -> {"results": [{"channel", "target", "status", "error"}]}   (sends a test event now)
```

Schedule rows gain `last_outcome: {"status", "attempts", "notified": bool}`.

**Frontend.** The schedule dialog gains an Outcomes section (notify-on chips, webhook
with "use the default", emails, retries and delay, Send a test); the schedule list
shows a bell when notifications are set and the last outcome; Settings gains a
Notifications section (default webhook, SMTP with the password field that is never
echoed); the run dialog lists the notification attempts and the retry chain.
