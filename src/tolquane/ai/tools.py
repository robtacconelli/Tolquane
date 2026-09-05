"""The tools the builder hands the model. Generated code always runs in a subprocess."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from .providers import ToolSpec

FLOW_FILE = "flow.py"

TOOL_SPECS: list[ToolSpec] = [
    ToolSpec(
        "write_flow",
        "Save the complete flow.py (the whole file, not a diff). The file must define "
        "build(source=None) returning the graph and main() running it. Returns the "
        "line count, or the syntax error.",
        {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "The whole file."}},
            "required": ["code"],
            "additionalProperties": False,
        },
    ),
    ToolSpec(
        "check_flow",
        "Validate the wiring of flow.py without running it: imports the file, calls "
        "build() and tq.check(). Returns tq.explain() on success, or the GraphError, "
        "which always says how to fix it.",
        {"type": "object", "properties": {}, "additionalProperties": False},
    ),
    ToolSpec(
        "run_flow",
        "Run flow.py to completion on the deterministic sync runtime and return the run "
        "report, stdout, and any NodeError or DeadlockError. Pass `sample` (a list of "
        "items) to feed build(source=sample) instead of the flow's own source, or set "
        "use_sample_file when the user provided a sample file.",
        {
            "type": "object",
            "properties": {
                "sample": {
                    "type": "array",
                    "items": {},
                    "description": "Items to feed instead of the real source.",
                },
                "use_sample_file": {
                    "type": "boolean",
                    "description": "Feed the user's sample file (one item per line).",
                },
                "timeout": {"type": "integer", "description": "Seconds; default 60."},
            },
            "additionalProperties": False,
        },
    ),
    ToolSpec(
        "read_docs",
        "Read a reference by name: 'api-card' (the whole API on one page), 'style' (the "
        "house style), or one of the example flows listed in the system prompt.",
        {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
            "additionalProperties": False,
        },
    ),
]


@dataclass(frozen=True)
class ToolOutcome:
    content: str
    is_error: bool = False


_CHILD = r"""
import contextlib, io, json, sys, traceback
workdir, mode, sample_json, timeout = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
sys.path.insert(0, workdir)
out = {"ok": False}
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        import tolquane as tq
        import flow
        if not hasattr(flow, "build"):
            raise RuntimeError("flow.py must define build(source=None) returning the graph")
        sample = None if sample_json == "null" else json.loads(sample_json)
        graph = flow.build(source=sample) if sample is not None else flow.build()
        if mode == "check":
            g = tq.check(graph)
            out.update(ok=True, nodes=len(g.nodes), explain=tq.explain(g))
        else:
            report = tq.run(graph, runtime="sync", deadlock_timeout=timeout)
            out.update(ok=True, report=str(report))
except BaseException as exc:
    out["error"] = f"{type(exc).__name__}: {exc}"
    out["traceback"] = traceback.format_exc()[-3000:]
out["stdout"] = buf.getvalue()[-4000:]
print("\n@@RESULT@@" + json.dumps(out))
"""


class Tools:
    """Executes tool calls for one build, inside ``workdir``."""

    def __init__(
        self,
        workdir: str | Path,
        *,
        sample_path: str | Path | None = None,
        run_timeout: float = 60.0,
    ) -> None:
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.sample_path = Path(sample_path) if sample_path else None
        self.run_timeout = run_timeout
        self.last_check_ok = False
        self.last_run_ok = False

    @property
    def flow_path(self) -> Path:
        return self.workdir / FLOW_FILE

    def call(self, name: str, args: dict[str, Any]) -> ToolOutcome:
        try:
            if name == "write_flow":
                return self.write_flow(str(args.get("code", "")))
            if name == "check_flow":
                return self.check_flow()
            if name == "run_flow":
                return self.run_flow(
                    sample=args.get("sample"),
                    use_sample_file=bool(args.get("use_sample_file", False)),
                    timeout=args.get("timeout"),
                )
            if name == "read_docs":
                return self.read_docs(str(args.get("name", "")))
        except Exception as exc:  # a tool must never take the loop down
            return ToolOutcome(f"{type(exc).__name__}: {exc}", is_error=True)
        return ToolOutcome(f"unknown tool {name!r}", is_error=True)

    # ------------------------------------------------------------------ tools

    def write_flow(self, code: str) -> ToolOutcome:
        if not code.strip():
            return ToolOutcome("write_flow needs the file content in `code`", is_error=True)
        try:
            compile(code, FLOW_FILE, "exec")
        except SyntaxError as exc:
            return ToolOutcome(f"SyntaxError at line {exc.lineno}: {exc.msg}", is_error=True)
        self.flow_path.write_text(code)
        self.last_check_ok = self.last_run_ok = False
        return ToolOutcome(f"wrote {FLOW_FILE} ({len(code.splitlines())} lines)")

    def check_flow(self) -> ToolOutcome:
        if not self.flow_path.exists():
            return ToolOutcome("flow.py does not exist yet; call write_flow first", is_error=True)
        result = self._child("check", None, 30.0)
        if result.get("ok"):
            self.last_check_ok = True
            return ToolOutcome(f"OK: {result['nodes']} nodes.\n{result['explain']}")
        return ToolOutcome(self._failure("check failed", result), is_error=True)

    def run_flow(
        self,
        sample: list[Any] | None = None,
        use_sample_file: bool = False,
        timeout: int | None = None,
    ) -> ToolOutcome:
        if not self.flow_path.exists():
            return ToolOutcome("flow.py does not exist yet; call write_flow first", is_error=True)
        if use_sample_file:
            if self.sample_path is None:
                return ToolOutcome("the user did not provide a sample file", is_error=True)
            sample = self._read_sample_file()
        seconds = float(timeout or self.run_timeout)
        result = self._child("run", sample, seconds)
        if result.get("ok"):
            self.last_run_ok = True
            text = f"OK.\n{result['report']}"
            if result.get("stdout"):
                text += "\nstdout:\n" + result["stdout"]
            return ToolOutcome(text)
        return ToolOutcome(self._failure("run failed", result), is_error=True)

    def read_docs(self, name: str) -> ToolOutcome:
        from .prompt import EXAMPLE_FILES, SHOWN_EXAMPLES, example_text, resource_text

        if name in ("api-card", "style"):
            return ToolOutcome(resource_text(f"{name}.md"))
        if name in SHOWN_EXAMPLES:
            return ToolOutcome(example_text(name))
        if name in EXAMPLE_FILES:
            return ToolOutcome(EXAMPLE_FILES[name].read_text())
        names = sorted(set(EXAMPLE_FILES) | set(SHOWN_EXAMPLES))
        return ToolOutcome(
            f"unknown document {name!r}; use 'api-card', 'style' or one of " + ", ".join(names),
            is_error=True,
        )

    # ------------------------------------------------------------------ helpers

    def _read_sample_file(self) -> list[Any]:
        assert self.sample_path is not None
        text = self.sample_path.read_text()
        if self.sample_path.suffix == ".json":
            data = json.loads(text)
            return list(data) if isinstance(data, list) else [data]
        items: list[Any] = []
        for line in text.splitlines():
            if not line.strip():
                continue
            if self.sample_path.suffix == ".jsonl":
                items.append(json.loads(line))
            else:
                items.append(line)
        return items

    def _child(self, mode: str, sample: list[Any] | None, timeout: float) -> dict[str, Any]:
        sample_json = "null" if sample is None else json.dumps(sample)
        try:
            proc = subprocess.run(
                [sys.executable, "-c", _CHILD, str(self.workdir), mode, sample_json, str(timeout)],
                capture_output=True,
                text=True,
                timeout=timeout + 15,
                cwd=str(self.workdir),
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "error": f"the flow did not finish within {timeout:.0f}s; it may be waiting "
                "for input that never comes or running an unbounded source",
            }
        marker = "\n@@RESULT@@"
        if marker in proc.stdout:
            payload = proc.stdout.rsplit(marker, 1)[1]
            try:
                return dict(json.loads(payload))
            except json.JSONDecodeError:
                pass
        return {
            "ok": False,
            "error": f"the flow process exited with code {proc.returncode}",
            "stdout": (proc.stdout + proc.stderr)[-4000:],
        }

    @staticmethod
    def _failure(title: str, result: dict[str, Any]) -> str:
        text = f"{title}: {result.get('error', 'unknown error')}"
        tb = result.get("traceback")
        if tb:
            text += "\n" + tb
        if result.get("stdout"):
            text += "\nstdout:\n" + result["stdout"]
        return text


def package_resource(name: str) -> str:
    return (resources.files("tolquane.ai") / "resources" / name).read_text()
