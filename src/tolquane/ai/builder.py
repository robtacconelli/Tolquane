"""The build loop: describe, write, check, run, fix, improve."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .prompt import system_prompt
from .providers import Provider, ToolResult, Turn
from .tools import TOOL_SPECS, Tools


@dataclass
class BuildResult:
    ok: bool
    code: str
    summary: str
    rounds: int
    usage: dict[str, int] = field(default_factory=dict)
    flow_path: Path | None = None


Event = Callable[[str, Any], None]
"""``on_event(kind, payload)``: kind is 'text', 'call', 'result' or 'done'."""


class Builder:
    """One conversation with the model about one flow."""

    def __init__(
        self,
        provider: Provider,
        workdir: str | Path,
        *,
        sample_path: str | Path | None = None,
        max_rounds: int = 12,
        run_timeout: float = 60.0,
        on_event: Event | None = None,
    ) -> None:
        self.provider = provider
        self.tools = Tools(workdir, sample_path=sample_path, run_timeout=run_timeout)
        self.max_rounds = max_rounds
        self.on_event = on_event or (lambda kind, payload: None)
        self.usage: dict[str, int] = {}
        self.rounds = 0
        self._started = False
        note = None
        if sample_path:
            note = (
                f"The user provided a sample file at {Path(sample_path).name} (one item "
                "per line). Call run_flow with use_sample_file=true to test with it."
            )
        self._system = system_prompt(sample_note=note)

    def build(self, description: str) -> BuildResult:
        """Write a flow for ``description`` and test it."""
        if not self._started:
            self.provider.start(self._system, TOOL_SPECS)
            self._started = True
        return self._converse(f"Build this flow:\n\n{description.strip()}")

    def improve(self, feedback: str) -> BuildResult:
        """Continue the same conversation with a change request."""
        if not self._started:
            raise RuntimeError("call build() before improve()")
        return self._converse(feedback.strip())

    # ------------------------------------------------------------------ the loop

    def _converse(self, user_text: str) -> BuildResult:
        turn = self._send(user_text, [])
        rounds = 0
        while turn.calls and rounds < self.max_rounds:
            rounds += 1
            results = []
            for call in turn.calls:
                self.on_event("call", call)
                outcome = self.tools.call(call.name, call.args)
                self.on_event("result", (call, outcome))
                results.append(ToolResult(call.id, outcome.content, outcome.is_error))
            turn = self._send(None, results)
        if turn.calls:
            # Out of rounds: tell the model to stop and summarise, once.
            turn = self._send(
                "Stop using tools now. In two sentences, say what state flow.py is in and "
                "what is still wrong.",
                [
                    ToolResult(c.id, "skipped: the round limit was reached", True)
                    for c in turn.calls
                ],
            )
        code = self.tools.flow_path.read_text() if self.tools.flow_path.exists() else ""
        ok = bool(code) and self.tools.last_check_ok and self.tools.last_run_ok
        result = BuildResult(
            ok, code, turn.text.strip(), rounds, dict(self.usage), self.tools.flow_path
        )
        self.on_event("done", result)
        return result

    def _send(self, user_text: str | None, results: list[ToolResult]) -> Turn:
        turn = self.provider.send(user_text, results)
        self.rounds += 1
        for key, value in turn.usage.items():
            self.usage[key] = self.usage.get(key, 0) + int(value)
        if turn.text.strip():
            self.on_event("text", turn.text.strip())
        return turn
