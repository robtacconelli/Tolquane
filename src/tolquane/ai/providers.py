"""Model providers behind one small interface, plus record and replay for tests.

A provider keeps its own conversation in the format its API wants and exposes one
call: ``send`` a user message and/or tool results, get back the assistant's text and
the tool calls it wants made. The builder loop never sees provider-specific shapes.
"""

from __future__ import annotations

import json
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import TolquaneError


class ProviderError(TolquaneError):
    """The model API could not be used: missing package, missing key, refusal."""


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    content: str
    is_error: bool = False


@dataclass
class Turn:
    """What the model said and what it wants done."""

    text: str
    calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    model: str = ""


class Provider:
    """Interface. ``start`` once, then ``send`` for every exchange."""

    name = "provider"

    def start(self, system: str, tools: Sequence[ToolSpec]) -> None:
        raise NotImplementedError

    def send(self, user_text: str | None, results: Sequence[ToolResult] = ()) -> Turn:
        raise NotImplementedError


# --------------------------------------------------------------------------- Anthropic


class AnthropicProvider(Provider):
    """Claude through the official ``anthropic`` SDK.

    Opus 5 by default: thinking is adaptive on this model, so the request only sets
    the effort. Streaming keeps long code answers clear of HTTP timeouts, and
    ``fallbacks="default"`` re-runs a declined request on Anthropic's recommended
    fallback model instead of returning a refusal.
    """

    name = "anthropic"
    DEFAULT_MODEL = "claude-opus-5"

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        effort: str = "high",
        max_tokens: int = 32000,
        client: Any = None,
    ) -> None:
        if client is None:
            try:
                import anthropic
            except ImportError as exc:  # pragma: no cover - depends on the environment
                raise ProviderError(
                    "the anthropic package is not installed; pip install 'tolquane[ai]'"
                ) from exc
            client = anthropic.Anthropic()
        self.client = client
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.system: list[dict[str, Any]] = []
        self.tools: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []

    def start(self, system: str, tools: Sequence[ToolSpec]) -> None:
        # The system prompt is the stable prefix: mark it cacheable.
        self.system = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        self.tools = [
            {"name": t.name, "description": t.description, "input_schema": t.parameters}
            for t in tools
        ]
        self.messages = []

    def send(self, user_text: str | None, results: Sequence[ToolResult] = ()) -> Turn:
        if results:
            self.messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": r.call_id,
                            "content": r.content,
                            "is_error": r.is_error,
                        }
                        for r in results
                    ],
                }
            )
        if user_text:
            self.messages.append({"role": "user", "content": user_text})
        with self.client.beta.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=self.system,
            tools=self.tools,
            messages=self.messages,
            output_config={"effort": self.effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            message = stream.get_final_message()
        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            why = getattr(details, "explanation", None) or "no explanation given"
            raise ProviderError(f"the model declined the request: {why}")
        self.messages.append({"role": "assistant", "content": message.content})
        text = "".join(b.text for b in message.content if b.type == "text")
        calls = [
            ToolCall(b.id, b.name, dict(b.input)) for b in message.content if b.type == "tool_use"
        ]
        usage = {
            "input_tokens": message.usage.input_tokens,
            "output_tokens": message.usage.output_tokens,
            "cache_read_input_tokens": getattr(message.usage, "cache_read_input_tokens", 0) or 0,
        }
        return Turn(text, calls, usage, message.model)


# --------------------------------------------------------------------------- OpenAI


class OpenAIProvider(Provider):
    """GPT through the official ``openai`` SDK, Responses API with function tools."""

    name = "openai"
    DEFAULT_MODEL = "gpt-5.5"

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        effort: str = "medium",
        client: Any = None,
    ) -> None:
        if client is None:
            try:
                import openai
            except ImportError as exc:  # pragma: no cover - depends on the environment
                raise ProviderError(
                    "the openai package is not installed; pip install 'tolquane[ai]'"
                ) from exc
            client = openai.OpenAI()
        self.client = client
        self.model = model
        self.effort = effort
        self.instructions = ""
        self.tools: list[dict[str, Any]] = []
        self.input: list[Any] = []

    def start(self, system: str, tools: Sequence[ToolSpec]) -> None:
        self.instructions = system
        self.tools = [
            {
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
                "strict": False,
            }
            for t in tools
        ]
        self.input = []

    def send(self, user_text: str | None, results: Sequence[ToolResult] = ()) -> Turn:
        for r in results:
            output = ("Error: " + r.content) if r.is_error else r.content
            self.input.append(
                {"type": "function_call_output", "call_id": r.call_id, "output": output}
            )
        if user_text:
            self.input.append({"role": "user", "content": user_text})
        response = self.client.responses.create(
            model=self.model,
            instructions=self.instructions,
            input=self.input,
            tools=self.tools,
            reasoning={"effort": self.effort},
        )
        self.input.extend(response.output)
        calls = [
            ToolCall(item.call_id, item.name, json.loads(item.arguments or "{}"))
            for item in response.output
            if item.type == "function_call"
        ]
        usage = {}
        if response.usage is not None:
            usage = {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            }
        return Turn(response.output_text or "", calls, usage, response.model)


# --------------------------------------------------------------------------- record / replay


class RecordingProvider(Provider):
    """Wraps a real provider and writes every turn to a JSON file for later replay."""

    def __init__(self, inner: Provider, path: str | Path) -> None:
        self.inner = inner
        self.path = Path(path)
        self.name = inner.name
        self.log: dict[str, Any] = {"provider": inner.name, "turns": []}

    def start(self, system: str, tools: Sequence[ToolSpec]) -> None:
        self.log["system_chars"] = len(system)
        self.log["tools"] = [t.name for t in tools]
        self.inner.start(system, tools)

    def send(self, user_text: str | None, results: Sequence[ToolResult] = ()) -> Turn:
        turn = self.inner.send(user_text, results)
        self.log["turns"].append(
            {
                "user": user_text,
                "results": [
                    {"call_id": r.call_id, "is_error": r.is_error, "content": r.content[:2000]}
                    for r in results
                ],
                "text": turn.text,
                "calls": [{"id": c.id, "name": c.name, "args": c.args} for c in turn.calls],
                "usage": turn.usage,
                "model": turn.model,
                "at": time.time(),
            }
        )
        self.path.write_text(json.dumps(self.log, indent=1))
        return turn


class ReplayProvider(Provider):
    """Plays back a recorded conversation; tools still run for real."""

    name = "replay"

    def __init__(self, path: str | Path) -> None:
        self.log = json.loads(Path(path).read_text())
        self.turns = list(self.log["turns"])
        self.sent: list[tuple[str | None, list[ToolResult]]] = []

    def start(self, system: str, tools: Sequence[ToolSpec]) -> None:
        self.sent = []

    def send(self, user_text: str | None, results: Sequence[ToolResult] = ()) -> Turn:
        self.sent.append((user_text, list(results)))
        if not self.turns:
            raise ProviderError("the recording has no more turns")
        t = self.turns.pop(0)
        calls = [ToolCall(c["id"], c["name"], c["args"]) for c in t["calls"]]
        return Turn(t["text"], calls, dict(t.get("usage", {})), t.get("model", "replay"))


def make_provider(name: str, model: str | None = None, **options: Any) -> Provider:
    if name == "anthropic":
        return AnthropicProvider(model or AnthropicProvider.DEFAULT_MODEL, **options)
    if name == "openai":
        return OpenAIProvider(model or OpenAIProvider.DEFAULT_MODEL, **options)
    raise ProviderError(f"unknown provider {name!r}; use 'anthropic' or 'openai'")
