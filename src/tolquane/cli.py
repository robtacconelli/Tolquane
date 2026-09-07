"""``tolquane`` command: build flows with a model, and check, run, draw, explain them."""

from __future__ import annotations

import argparse
import ast
import contextlib
import importlib.util
import inspect
import json
import os
import sys
import threading
import time
import webbrowser
from collections.abc import Iterator
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
    if not hasattr(module, "build") and not hasattr(module, "main"):
        raise SystemExit(f"{path}: define build(source=None) returning the graph")
    return module


class _Captured(Exception):
    """Carries the block a flow's main() handed to tq.run, so the command can run it."""

    def __init__(self, block: Any) -> None:
        self.block = block


def _capture_from_main(module: Any, path: str) -> Any:
    """The graph of a flow that has no build(): the one tq.run(...) call in its main()."""
    import tolquane

    def grab(block: Any, *args: Any, **kwargs: Any) -> Any:
        raise _Captured(block)

    original = tolquane.run
    tolquane.run = grab
    try:
        module.main()
    except _Captured as found:
        return found.block
    finally:
        tolquane.run = original
    raise SystemExit(
        f"{path}: define build(source=None) returning the graph, or a main() that calls "
        "tq.run(...) once"
    )


def _graph(args: argparse.Namespace) -> Any:
    module = _load_flow(args.flow)
    sample = getattr(args, "sample", None)
    params = _params(args)
    if hasattr(module, "build"):
        _check_params(module.build, params, args.flow)
        if sample:
            params["source"] = _read_sample(Path(sample))
        graph = module.build(**params)
    elif sample or params:
        flag = "--sample" if sample else "--param"
        raise SystemExit(f"{args.flow}: {flag} needs build(source=None); this flow only has main()")
    else:
        graph = _capture_from_main(module, args.flow)
    if getattr(args, "optimize", False):
        graph = optimize(graph, verbose=True)
    return graph


def _params(args: argparse.Namespace) -> dict[str, Any]:
    """``--param workers=8 --param path=data.csv`` as the keywords build() is called with."""
    values: dict[str, Any] = {}
    for item in getattr(args, "param", None) or []:
        name, sign, text = item.partition("=")
        if not sign or not name.strip():
            raise SystemExit(f"--param takes name=value, not {item!r}")
        values[name.strip()] = _param_value(text)
    return values


def _param_value(text: str) -> Any:
    """A Python literal when it is one (`8`, `0.5`, `[1, 2]`, `"x"`), a plain word otherwise."""
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return text


def _check_params(build: Any, params: dict[str, Any], path: str) -> None:
    """Every ``--param`` has to be a keyword of this flow's build(); name them all if not."""
    try:
        parameters = inspect.signature(build).parameters
    except (TypeError, ValueError):  # a build() nothing can introspect: let the call speak
        return
    if any(p.kind is p.VAR_KEYWORD for p in parameters.values()):
        return
    known = [
        name
        for name, p in parameters.items()
        if name != "source" and p.kind in (p.KEYWORD_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    unknown = [name for name in params if name not in known]
    if not unknown:
        return
    takes = f"this flow's parameters are: {', '.join(known)}" if known else "this flow has none"
    raise SystemExit(f"{path}: build() has no parameter {unknown[0]!r}; {takes}")


@contextlib.contextmanager
def _environment(variables: dict[str, str]) -> Iterator[None]:
    """``--env NAME=value`` for as long as the flow is being imported and run."""
    previous = {name: os.environ.get(name) for name in variables}
    os.environ.update(variables)
    try:
        yield
    finally:
        for name, old in previous.items():
            if old is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old


def _env(args: argparse.Namespace) -> dict[str, str]:
    variables: dict[str, str] = {}
    for item in getattr(args, "env", None) or []:
        name, sign, value = item.partition("=")
        if not sign or not name.strip():
            raise SystemExit(f"--env takes NAME=value, not {item!r}")
        variables[name.strip()] = value
    return variables


def _json_safe(value: Any) -> Any:
    """A ``--param`` value as JSON: a tuple or a set becomes a list, anything else its text."""
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, str | bool | int | float):
        return value
    return repr(value)


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
    # The variables are in place before the flow is imported, so a module-level
    # os.environ read sees them, and they are put back the way they were afterwards.
    with _environment(_env(args)):
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
            stream.emit(
                "start",
                graph=graph_view(graph),
                runtime=args.runtime,
                flow=args.flow,
                # What the run was given: the parameters by value, the environment by
                # name only, because a variable's value is where secrets live.
                params={name: _json_safe(v) for name, v in _params(args).items()},
                env=sorted(_env(args)),
            )
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


WEB_MISSING = "tolquane web needs FastAPI and uvicorn ({name}): pip install 'tolquane[web]'"


def cmd_web(args: argparse.Namespace) -> int:
    """Start Tolquane Web: the server, and a browser looking at it."""
    if args.version:
        return _web_version()
    if args.openapi:
        return _web_openapi()
    try:
        import uvicorn

        from .web.server import create_app
        from .web.settings import startup_settings
    except ImportError as exc:
        print(WEB_MISSING.format(name=exc.name), file=sys.stderr)
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
    if _port_taken(settings.host, settings.port):
        print(_port_in_use(settings.host, settings.port), file=sys.stderr)
        return 1
    url = f"http://{_url_host(settings.host)}:{settings.port}/"
    print(f"Tolquane Web: {url}  workspace {settings.workspace}  (Ctrl-C to stop)", flush=True)
    if not any(importlib.util.find_spec(name) for name in ("websockets", "wsproto")):
        # uvicorn speaks HTTP on its own but needs one of these to answer an upgrade.
        print(
            "note: live run events need a WebSocket library: pip install websockets",
            file=sys.stderr,
        )
    if not args.no_browser:
        # After a moment, so the page is served rather than refused.
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    except OSError as exc:  # something took the port between the check and the bind
        print(f"{_port_in_use(settings.host, settings.port)} ({exc})", file=sys.stderr)
        return 1
    return 0


def _web_version() -> int:
    """What `tolquane web` would start: the version, the GUI assets, the server libraries."""
    from importlib.metadata import PackageNotFoundError
    from importlib.metadata import version as installed

    import tolquane

    print(f"tolquane {tolquane.__version__}")
    static = Path(__file__).parent / "web" / "static"
    if (static / "index.html").exists():
        print(f"frontend: {static}")
    else:
        print("frontend: not built (install a wheel, or run npm run build in web/)")
    parts = []
    for name in ("fastapi", "uvicorn"):
        try:
            parts.append(f"{name} {installed(name)}")
        except PackageNotFoundError:
            parts.append(f"{name} missing")
    print(f"server: {', '.join(parts)}")
    return 0


def _web_openapi() -> int:
    """Print the server's OpenAPI document. The frontend's types are generated from it.

    Nothing is started and nothing of the user's is touched: the app is built against a
    throwaway workspace and database, because the schema is the same whatever it serves.
    """
    import tempfile

    try:
        from .web.server import create_app
        from .web.settings import AppSettings
    except ImportError as exc:
        print(WEB_MISSING.format(name=exc.name), file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="tolquane-openapi-") as tmp:
        root = Path(tmp)
        app = create_app(
            AppSettings(
                workspace=root,
                db_path=root / "web.db",
                config_path=root / "web.toml",
                start_scheduler=False,
            )
        )
        try:
            json.dump(app.openapi(), sys.stdout, indent=2)
            sys.stdout.write("\n")
        finally:
            # The lifespan never ran, so close by hand what create_app opened.
            app.state.supervisor.shutdown()
            app.state.store.close()
    return 0


def _port_taken(host: str, port: int) -> bool:
    """Is something already listening there? Asked before uvicorn, to say so plainly."""
    import socket

    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False  # a name we cannot resolve is uvicorn's error to report, not ours
    for family, kind, proto, _canonical, address in addresses:
        try:
            with socket.socket(family, kind, proto) as probe:
                # uvicorn binds with SO_REUSEADDR, so a connection in TIME_WAIT from a
                # server that just stopped must not count as the port being taken.
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(address)
        except OSError:
            return True
    return False


def _port_in_use(host: str, port: int) -> str:
    return (
        f"port {port} on {host} is already in use: another Tolquane Web, or another "
        f"program. Stop it, or start this one with --port {port + 1}."
    )


def _url_host(host: str) -> str:
    """The host to connect to for a bind address: the wildcards mean loopback here."""
    if host in ("0.0.0.0", "::", ""):
        return "127.0.0.1"
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


def cmd_web_users(args: argparse.Namespace) -> int:
    """``tolquane web users ...``: who may sign in, straight in the database.

    No server is started and none has to be running: the file is the one ``tolquane web``
    would open, ``$TOLQUANE_HOME/web.db`` or ``~/.tolquane/web.db``. This is how the first
    administrator is made on a machine that is not going to be started with ``--token``.
    """
    from .web.settings import default_db_path
    from .web.store import Store

    with Store(default_db_path()) as store:
        try:
            return _users_command(store, args)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1


def _users_command(store: Any, args: argparse.Namespace) -> int:
    """One ``users`` sub-command. A ``ValueError`` from the store is the user's mistake."""
    from .web.store import LOCAL_USER

    command = args.users_command
    if command == "list":
        users = store.list_users()
        if not users:
            print(f"no users: every request is the implicit admin {LOCAL_USER!r} on loopback")
            return 0
        width = max(len(user.name) for user in users)
        for user in users:
            state = "disabled" if user.disabled else "enabled"
            if user.must_change_password:
                state += ", must change password"
            seen = user.last_seen[:19] if user.last_seen else "never"
            print(f"{user.name:<{width}}  {user.role:<6}  {state:<32}  last seen {seen}")
        return 0
    if command == "add":
        password = args.password or _ask_password(f"Password for {args.name}: ")
        user = store.add_user(args.name, password, "admin" if args.admin else "member", False)
        print(f"added {user.name} ({user.role})")
        return 0
    user = store.get_user_by_name(args.name)
    if user is None:
        raise ValueError(f"there is no user called {args.name!r}")
    if command == "passwd":
        password = args.password or _ask_password(f"New password for {user.name}: ")
        store.update_user(user.id, password=password, must_change_password=False)
        print(f"the password of {user.name} is changed")
        return 0
    if command == "disable":
        others = [admin for admin in store.enabled_admins() if admin.id != user.id]
        if user.role == "admin" and not others:
            raise ValueError(
                f"{user.name} is the last administrator who can sign in; "
                "make somebody else an administrator first"
            )
        store.update_user(user.id, disabled=True)
        print(f"{user.name} can no longer sign in, and their sessions stop working")
        return 0
    store.update_user(user.id, disabled=False)
    print(f"{user.name} can sign in again")
    return 0


def _ask_password(prompt: str) -> str:
    """Ask twice, without echoing, because nobody can see what they are typing."""
    import getpass

    first = getpass.getpass(prompt)
    if first != getpass.getpass("Again: "):
        raise ValueError("the two passwords are not the same; nothing was changed")
    return first


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
        if name in ("run", "check", "explain", "draw"):
            p.add_argument(
                "--param",
                action="append",
                default=None,
                metavar="NAME=VALUE",
                help="a keyword for build(): --param workers=8 (repeatable; the value is a "
                "Python literal, a plain word stays a string)",
            )
        if name == "run":
            p.add_argument(
                "--env",
                action="append",
                default=None,
                metavar="NAME=VALUE",
                help="an environment variable for the flow, set before it is imported (repeatable)",
            )
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
    web_p.add_argument(
        "--openapi",
        action="store_true",
        help="print the server's OpenAPI document and stop (the frontend's types come "
        "from it: tolquane web --openapi > web/openapi.json)",
    )
    web_p.add_argument(
        "--version", action="store_true", help="print the version, the GUI assets and the server"
    )
    web_p.set_defaults(func=cmd_web)

    # tolquane web users ...: the accounts, without a server. Everything else about
    # `web` is the server, so the users live one level down rather than as flags.
    web_sub = web_p.add_subparsers(dest="web_command")
    users_p = web_sub.add_parser("users", help="add and manage the people who can sign in")
    users_sub = users_p.add_subparsers(dest="users_command", required=True)
    add_p = users_sub.add_parser("add", help="add a user (prompts for the password)")
    add_p.add_argument("name", help="lower case, 2 to 32 of letters, digits, '_', '.' or '-'")
    add_p.add_argument("--admin", action="store_true", help="make them an administrator")
    add_p.add_argument("--password", default=None, help="the password, instead of a prompt")
    passwd_p = users_sub.add_parser("passwd", help="set a user's password")
    passwd_p.add_argument("name")
    passwd_p.add_argument("--password", default=None, help="the password, instead of a prompt")
    list_p = users_sub.add_parser("list", help="who there is, and when they were last seen")
    disable_p = users_sub.add_parser("disable", help="stop a user signing in, sessions and all")
    disable_p.add_argument("name")
    enable_p = users_sub.add_parser("enable", help="let a user sign in again")
    enable_p.add_argument("name")
    for leaf in (add_p, passwd_p, list_p, disable_p, enable_p):
        leaf.set_defaults(func=cmd_web_users)

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
