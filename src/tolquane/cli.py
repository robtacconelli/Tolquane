"""``tolquane`` command: build flows with a model, and check, run, draw, explain them."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from . import check, draw, explain, optimize, run
from .errors import TolquaneError


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
    report = run(
        _graph(args), runtime=args.runtime, batch=args.batch, deploy=args.deploy, group=args.group
    )
    if args.stats:
        print(report, file=sys.stderr)
    return 0


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
            p.add_argument("--optimize", action="store_true", help="cut threads before running")
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
