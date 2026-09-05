"""The AI builder: describe a flow, get a checked and tested ``flow.py``.

    from tolquane.ai import build
    result = build("count words per line in log.txt, 8 workers", workdir="out")
    print(result.summary); print(result.code)

Needs ``pip install "tolquane[ai]"`` and ``ANTHROPIC_API_KEY`` (or ``OPENAI_API_KEY``
with ``provider="openai"``). Generated code runs on this machine in a subprocess.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .builder import Builder, BuildResult
from .providers import (
    AnthropicProvider,
    OpenAIProvider,
    Provider,
    ProviderError,
    RecordingProvider,
    ReplayProvider,
    make_provider,
)


def build(
    description: str,
    *,
    workdir: str | Path = ".",
    provider: str | Provider = "anthropic",
    model: str | None = None,
    sample_path: str | Path | None = None,
    max_rounds: int = 12,
    on_event: Any = None,
) -> BuildResult:
    """One-shot: build, check and run a flow for ``description``; returns the result."""
    p = make_provider(provider, model) if isinstance(provider, str) else provider
    builder = Builder(p, workdir, sample_path=sample_path, max_rounds=max_rounds, on_event=on_event)
    return builder.build(description)


__all__ = [
    "AnthropicProvider",
    "BuildResult",
    "Builder",
    "OpenAIProvider",
    "Provider",
    "ProviderError",
    "RecordingProvider",
    "ReplayProvider",
    "build",
    "make_provider",
]
