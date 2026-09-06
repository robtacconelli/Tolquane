"""``tolquane`` command: build flows with a model, and check, run, draw, explain them."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from . import check, draw, explain, optimize, run
from .errors import DeadlockError, RunCancelled, TolquaneError


def _load_flow(path: str) -> Any:
    file = Path(path)
    if not file.exists():
        raise SystemExit(f"{path}: no such file")
    spec = importlib.util.spec_from_file_location(file.stem, file)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(file.parent))
    spec.loader.exec_module(module)
    if not hasattr(module, "build"):
        raise SystemExit(f"{path}: define build(source=None) returning the graph")
    return module


def _graph(args: argparse.Namespace) -> Any:
    module = _load_flow(args.flow)
    if getattr(args, "sample", None):
        items = _read_sample(Path(args.sample))
        graph = module.build(source=items)
    else:
        graph = module.build()
    if getattr(args, "optimize", False):
        graph = optimize(graph, verbose=True)
    return graph


def _read_sample(path: Path) -> list[Any]:
    text = path.read_text()
    if path.suffix == ".json":
        data = json.loads(text)
        return list(data) if isinstance(data, list) else [data]
    lines = [line for line in text.splitlines() if line.strip()]
    return [json.loads(line) for line in lines] if path.suffix == ".jsonl" else lines


def cmd_check(args: argparse.Namespace) -> int:
    g = check(_graph(args))
    print(f"OK: {len(g.nodes)} nodes, {len(g.edges)} edges")
    print(explain(g))
    return 0


def cmd_explain(args: argparse.Namespace) -> int:
    print(explain(_graph(args)))
    return 0


def cmd_draw(args: argparse.Namespace) -> int:
    print(draw(_graph(args)))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    if bool(args.deploy) != bool(args.group):
        raise SystemExit("--deploy and --group go together")
    if args.events:
        return _run_with_events(args)
    report = run(
        _graph(args),
        runtime=args.runtime,
        batch=args.batch,
        deploy=args.deploy,
        group=args.group,
        trace=args.trace,
    )
    if args.stats:
        print(report, file=sys.stderr)
    return 0


EXIT_CODES = {"done": 0, "failed": 1, "deadlock": 1, "cancelled": 130}


def _run_with_events(args: argparse.Namespace) -> int:
    """Run the flow and report it as JSON lines: what a supervisor watches a run through."""
    from ._events import EventStream, capture_output, graph_view, stop_on_signal

    stream = EventStream(sys.stdout)  # the real stdout, taken before the flow's is swapped
    stop = threading.Event()
    status = "done"
    start = time.perf_counter()
    # The capture is up before the flow is imported, so nothing a flow prints, at import
    # time or later, can end up in the middle of the line stream.
    with stop_on_signal(stop), capture_output(stream):
        try:
            graph = check(_graph(args))
            stream.emit("start", graph=graph_view(graph), runtime=args.runtime, flow=args.flow)
            report = run(
                graph,
                runtime=args.runtime,
                batch=args.batch,
                deploy=args.deploy,
                group=args.group,
                trace=args.trace,
                on_progress=stream.progress,
                progress_interval=args.progress_interval,
                tap=args.tap,
                stop=stop,
            )
        except (RunCancelled, KeyboardInterrupt):
            status = "cancelled"
        except DeadlockError as exc:
            stream.emit("deadlock", message=str(exc))
            status = "deadlock"
        except ExceptionGroup as group:
            for failure in group.exceptions:
                stream.error(failure)
            status = "failed"
        except (Exception, SystemExit) as exc:
            stream.error(exc)
            status = "failed"
        else:
            stream.emit("report", report=report.to_dict())
    stream.emit("done", status=status, elapsed=time.perf_counter() - start)
    return EXIT_CODES[status]


def cmd_optimize(args: argparse.Namespace) -> int:
    notes: list[str] = []
    block = optimize(_graph(args), notes=notes, all2all=args.all2all)
    for line in notes:
        print(line)
    print(explain(block))
    return 0


def cmd_launch(args: argparse.Namespace) -> int:
    from .launch import launch

    return launch(
        args.deploy,
        args.flow,
        runtime=args.runtime,
        batch=args.batch,
        stats=args.stats,
        show=args.show.split(",") if args.show else None,
        dry_run=args.dry_run,
        optimize=args.optimize,
    )


def cmd_web(args: argparse.Namespace) -> int:
    """Start Tolquane Web: the server, and a browser looking at it."""
    try:
        import uvicorn

        from .web.server import create_app
        from .web.settings import startup_settings
    except ImportError as exc:
        print(
            f"tolquane web needs FastAPI and uvicorn ({exc.name}): pip install 'tolquane[web]'",
            file=sys.stderr,
        )
        return 1
    settings = startup_settings(
        workspace=args.workspace, host=args.host, port=args.port, token=args.token
    )
    if not settings.local_only and not settings.token:
        print(
            f"refusing to listen on {settings.host} without a token: anyone who can reach "
            "this machine could run code on it. Add --token SECRET, or leave the host at "
            "127.0.0.1.",
            file=sys.stderr,
        )
        return 2
    try:
        app = create_app(settings)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.check:
        return _web_check(uvicorn, app, settings)
    url = f"http://{_url_host(settings.host)}:{settings.port}/"
    print(f"Tolquane Web: {url}  (workspace {settings.workspace})")
    if not any(importlib.util.find_spec(name) for name in ("websockets", "wsproto")):
        # uvicorn speaks HTTP on its own but needs one of these to answer an upgrade.
        print(
            "note: live run events need a WebSocket library: pip install websockets",
            file=sys.stderr,
        )
    if not args.no_browser:
        # After a moment, so the page is served rather than refused.
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host


def _web_check(uvicorn: Any, app: Any, settings: Any) -> int:
    """Start the server on a free port, ask it how it is, stop it. For CI."""
    import json as _json
    import urllib.request

    server = uvicorn.Server(uvicorn.Config(app, host=settings.host, port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, name="tolquane-web-check", daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:
        print("the server did not start", file=sys.stderr)
        return 1
    try:
        port = server.servers[0].sockets[0].getsockname()[1]
        request = urllib.request.Request(
            f"http://{_url_host(settings.host)}:{port}/api/health",
            headers={"Authorization": f"Bearer {settings.token}"} if settings.token else {},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = _json.loads(response.read().decode())
    except Exception as exc:
        print(f"the server did not answer: {exc}", file=sys.stderr)
        return 1
    finally:
        server.should_exit = True
        thread.join(15)
    if not payload.get("ok"):
        print(f"the server is unwell: {payload}", file=sys.stderr)
        return 1
    print(f"tolquane web {payload.get('version')}: ok, workspace {payload.get('workspace')}")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    from .ai import Builder, RecordingProvider, ReplayProvider, make_provider

    workdir = Path(args.out).parent if args.out.endswith(".py") else Path(args.out)
    if args.replay:
        provider: Any = ReplayProvider(args.replay)
    else:
        provider = make_provider(args.provider, args.model)
        if args.record:
            provider = RecordingProvider(provider, args.record)

    def on_event(kind: str, payload: Any) -> None:
        if args.quiet:
            return
        if kind == "text":
            print(f"\n{payload}\n")
        elif kind == "call":
            summary = "" if payload.name == "write_flow" else json.dumps(payload.args)[:120]
            print(f"  -> {payload.name} {summary}".rstrip())
        elif kind == "result":
            _call, outcome = payload
            first = outcome.content.splitlines()[0] if outcome.content else ""
            mark = "error" if outcome.is_error else "ok"
            print(f"     {mark}: {first[:110]}")

    builder = Builder(
        provider,
        workdir,
        sample_path=args.sample,
        max_rounds=args.max_rounds,
        on_event=on_event,
    )
    result = builder.build(args.description)
    if args.out.endswith(".py") and result.code:
        Path(args.out).write_text(result.code)
        if result.flow_path and result.flow_path.resolve() != Path(args.out).resolve():
            result.flow_path.unlink(missing_ok=True)
    _report(result, args)
    if args.no_interactive or not sys.stdin.isatty():
        return 0 if result.ok else 1
    while True:
        try:
            feedback = input("Change something (empty line to finish): ").strip()
        except EOFError:
            break
        if not feedback:
            break
        result = builder.improve(feedback)
        if args.out.endswith(".py") and result.code:
            Path(args.out).write_text(result.code)
        _report(result, args)
    return 0 if result.ok else 1


def _report(result: Any, args: argparse.Namespace) -> None:
    status = "checked and ran" if result.ok else "NOT verified"
    where = args.out
    tokens = result.usage.get("input_tokens", 0) + result.usage.get("output_tokens", 0)
    print(f"[{status}] {where}  ({result.rounds} round(s), {tokens} tokens)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tolquane", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="write, check and run a flow from a description")
    b.add_argument("description")
    b.add_argument("--provider", default="anthropic", choices=["anthropic", "openai"])
    b.add_argument("--model", default=None, help="model id (default: the provider's best)")
    b.add_argument("--out", default="flow.py", help="file to write (default flow.py)")
    b.add_argument("--sample", default=None, help="sample input file: text, .json or .jsonl")
    b.add_argument("--max-rounds", type=int, default=12)
    b.add_argument("--no-interactive", action="store_true", help="do not ask for changes")
    b.add_argument("--quiet", action="store_true")
    b.add_argument("--record", default=None, help="save the conversation to this JSON file")
    b.add_argument("--replay", default=None, help="replay a recorded conversation (no key)")
    b.set_defaults(func=cmd_build)

    for name, func, help_text in (
        ("check", cmd_check, "validate a flow's wiring"),
        ("explain", cmd_explain, "list nodes, policies and wiring rules"),
        ("draw", cmd_draw, "print a Mermaid diagram"),
        ("run", cmd_run, "run a flow"),
        ("optimize", cmd_optimize, "show the flow with fewer threads: fused ends, no collectors"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("flow", help="path to a flow.py that defines build(source=None)")
        p.add_argument("--sample", default=None, help="feed a sample file instead of the source")
        if name == "run":
            p.add_argument("--runtime", default="threads", choices=["threads", "processes", "sync"])
            p.add_argument("--batch", type=int, default=32)
            p.add_argument("--stats", action="store_true", help="print the run report")
            p.add_argument(
                "--events",
                action="store_true",
                help="print the run as JSON lines (start, progress, stdout, report, done); "
                "the flow's own output becomes events, SIGTERM cancels the run",
            )
            p.add_argument(
                "--progress-interval",
                type=float,
                default=0.5,
                metavar="S",
                help="seconds between --events progress snapshots (default 0.5)",
            )
            p.add_argument(
                "--tap",
                type=int,
                default=0,
                metavar="N",
                help="keep the last N items of every edge in the progress snapshots",
            )
            p.add_argument("--optimize", action="store_true", help="cut threads before running")
            p.add_argument(
                "--trace",
                default=None,
                metavar="FILE",
                help="write a Chrome trace file of every node's work and waits "
                "(open it in Perfetto or chrome://tracing)",
            )
            p.add_argument(
                "--deploy", default=None, help="deploy file (TOML) cutting the graph into groups"
            )
            p.add_argument("--group", default=None, help="which group this host runs")
        if name == "optimize":
            p.add_argument("--all2all", action="store_true", help="also join farm pairs")
        p.set_defaults(func=func)

    launch_p = sub.add_parser("launch", help="start every group of a deploy file, here or over ssh")
    launch_p.add_argument("deploy", help="deploy file (TOML)")
    launch_p.add_argument("flow", help="flow.py, at the same path on every host")
    launch_p.add_argument("--runtime", default="threads", choices=["threads", "processes"])
    launch_p.add_argument("--batch", type=int, default=32)
    launch_p.add_argument("--stats", action="store_true", help="print each group's run report")
    launch_p.add_argument("--optimize", action="store_true", help="cut threads before running")
    launch_p.add_argument(
        "--show", default=None, help="comma-separated groups whose output to show (default: all)"
    )
    launch_p.add_argument("--dry-run", action="store_true", help="print the commands and stop")
    launch_p.set_defaults(func=cmd_launch)

    web_p = sub.add_parser("web", help="open the Tolquane Web GUI (pip install 'tolquane[web]')")
    web_p.add_argument("--host", default=None, help="address to listen on (default 127.0.0.1)")
    web_p.add_argument("--port", type=int, default=None, help="port to listen on (default 8765)")
    web_p.add_argument("--workspace", default=None, help="directory the flows live in")
    web_p.add_argument("--token", default=None, help="require this bearer token on every request")
    web_p.add_argument("--no-browser", action="store_true", help="do not open a browser")
    web_p.add_argument("--check", action="store_true", help="start, ask /api/health, stop")
    web_p.set_defaults(func=cmd_web)

    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except TolquaneError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
