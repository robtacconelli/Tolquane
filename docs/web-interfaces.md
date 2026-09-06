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

## S4. The server (wave 1), for reference

FastAPI under `/api`, WebSocket at `/api/runs/{id}/events`, OpenAPI at `/api/openapi.json`,
static files at `/`. Routes: `GET/POST /api/flows`, `GET/PUT/DELETE /api/flows/{path}`,
`POST /api/flows/{path}/parse|generate|check|explain|draw|optimize`, `GET/POST /api/runs`,
`GET /api/runs/{id}`, `POST /api/runs/{id}/cancel`, `GET /api/runs/{id}/log|trace`,
`GET/POST/PUT/DELETE /api/schedules`, `GET/PUT /api/settings`, `POST /api/ai/chat`
(server-sent events), `GET /api/health`.
