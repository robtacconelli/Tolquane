"""The system prompt: the API card, the house style, two examples, and the contract."""

from __future__ import annotations

from importlib import resources
from pathlib import Path

_EXAMPLES_DIR = Path(__file__).resolve().parents[3] / "examples"

EXAMPLE_FILES: dict[str, Path] = {
    p.stem: p for p in sorted(_EXAMPLES_DIR.glob("*.py")) if _EXAMPLES_DIR.exists()
}
"""Example flows in the repository, offered through read_docs when available."""

SHOWN_EXAMPLES = ("hello", "word_count")
"""Examples embedded in the system prompt; shipped inside the package as resources."""


def resource_text(name: str) -> str:
    return (resources.files("tolquane.ai") / "resources" / name).read_text()


def example_text(name: str) -> str:
    """An example flow's source, from the package so installed wheels have it too."""
    return resource_text(f"example_{name}.py.txt")


CONTRACT = """
# Your job

You write one Python file, `flow.py`, that solves the user's task with Tolquane, then you
check it, run it on a sample, and fix it until it works. Work with the tools:

1. write_flow with the complete file.
2. check_flow. If it fails, read the message: it names the node and says the fix.
3. run_flow with a small sample you make up (a list of realistic items), or with the
   user's sample file when one is mentioned. Read the report and stdout. Fix and repeat.
4. When check and run both pass, answer with two or three sentences: what the flow does,
   how to run it, and anything the user should know. No code in the final answer.

# The file

- Module docstring: one sentence saying what the flow does.
- `import tolquane as tq` and only the standard library unless the user names a package.
- Small named functions or classes for the nodes, in the house style, each with a
  one-line comment saying what it does and, when it matters, why it is its own node.
- `def build(source=None):` returns the graph. When `source` is given (an iterable of
  items) the graph must start from `tq.from_iterable(source)` instead of its real source,
  so the flow can be tested with a sample. Keep the rest of the graph identical.
- `def main():` runs `tq.run(build())` and prints or writes the results.
- `if __name__ == "__main__": main()`.

# Rules that save round trips

- A function is a node. `def f(x)` returns what to send; `return tq.SKIP` sends nothing;
  `None` is a normal value. A generator function yields zero or many items.
- `def f(x, ctx)` must send with `ctx.send(...)` and return nothing.
- A sink (`@tq.sink`) ends the graph. A map node cannot be last.
- Use a farm for the stage that is slow or I/O bound; keep pure functions stateless;
  use a class for state, with `on_end` to flush.
- Prefer few blocks. Twenty lines of logic is a lot. Do not add error handling around
  the graph; NodeError names the failing node.
- Never loop forever in a source; sources must end.
"""


def system_prompt(*, sample_note: str | None = None) -> str:
    parts = [
        "You are the Tolquane builder. Tolquane is a Python library for parallel and "
        "streaming programs made of building blocks: sources, nodes, sinks, farms, "
        "pipelines. You write short, readable flows that anyone can maintain.",
        "# API card\n\n" + resource_text("api-card.md"),
        "# House style\n\n" + resource_text("style.md"),
    ]
    for name in SHOWN_EXAMPLES:
        parts.append(f"# Example: {name}.py\n\n```python\n{example_text(name)}```")
    others = sorted(set(EXAMPLE_FILES) - set(SHOWN_EXAMPLES))
    if others:
        parts.append("More examples are available through read_docs: " + ", ".join(others) + ".")
    parts.append(CONTRACT.strip())
    if sample_note:
        parts.append("# Sample\n\n" + sample_note)
    return "\n\n".join(parts)
