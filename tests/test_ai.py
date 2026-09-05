"""The AI builder without a key: tools, prompt, replayed conversations, CLI."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import tolquane as tq
from tolquane.ai import Builder, ReplayProvider, build
from tolquane.ai.prompt import SHOWN_EXAMPLES, example_text, resource_text, system_prompt
from tolquane.ai.providers import ToolCall, ToolSpec, Turn
from tolquane.ai.tools import TOOL_SPECS, Tools

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "ai"

GOOD_FLOW = '''"""Double numbers."""
import tolquane as tq

@tq.source
def numbers():
    yield from range(5)

@tq.node
def double(x):
    return x * 2

@tq.sink
def show(x):
    print(x)

def build(source=None):
    start = tq.from_iterable(source) if source is not None else numbers
    return start >> tq.farm(double, 2) >> show

def main():
    tq.run(build())
'''

BAD_FLOW = GOOD_FLOW.replace("tq.farm(double, 2) >> show", "tq.farm(double, 2)")

SLOW_FLOW = GOOD_FLOW.replace(
    "    yield from range(5)\n", "    import itertools\n    yield from itertools.count()\n"
)


# ----------------------------------------------------------------------------- tools


def test_packaged_resources_match_the_docs_and_examples() -> None:
    assert resource_text("api-card.md") == (ROOT / "docs" / "api-card.md").read_text()
    assert resource_text("style.md") == (ROOT / "docs" / "style.md").read_text()
    for name in SHOWN_EXAMPLES:
        assert example_text(name) == (ROOT / "examples" / f"{name}.py").read_text()


def test_system_prompt_has_card_style_examples_and_contract() -> None:
    text = system_prompt(sample_note="a note")
    assert "# API card" in text
    assert "tq.farm(work, workers=8)" in text
    assert "# House style" in text
    assert "# Example: hello.py" in text
    assert "def build(source=None):" in text
    assert "# Sample\n\na note" in text
    assert len(text) < 20_000


def test_tool_specs_are_well_formed() -> None:
    names = [t.name for t in TOOL_SPECS]
    assert names == ["write_flow", "check_flow", "run_flow", "read_docs"]
    for t in TOOL_SPECS:
        assert t.parameters["type"] == "object"
        assert t.parameters["additionalProperties"] is False


def test_write_check_run_read(tmp_path: Path) -> None:
    tools = Tools(tmp_path)
    assert tools.check_flow().is_error  # nothing written yet
    bad = tools.write_flow("def build(:\n")
    assert bad.is_error
    assert "SyntaxError" in bad.content
    ok = tools.write_flow(GOOD_FLOW)
    assert ok.content.startswith("wrote flow.py")
    checked = tools.check_flow()
    assert not checked.is_error
    assert "OK: 6 nodes" in checked.content
    assert "double.emitter" in checked.content
    ran = tools.run_flow(sample=[1, 2, 3])
    assert not ran.is_error
    assert "run on sync" in ran.content
    printed = ran.content.split("stdout:\n", 1)[1].split()
    assert sorted(printed) == ["2", "4", "6"]  # first-come collection: any order
    assert tools.last_check_ok
    assert tools.last_run_ok
    assert "farm" in tools.read_docs("api-card").content
    assert "@tq.source" in tools.read_docs("hello").content
    assert tools.read_docs("nope").is_error


def test_graph_errors_come_back_with_the_fix(tmp_path: Path) -> None:
    tools = Tools(tmp_path)
    tools.write_flow(BAD_FLOW)
    checked = tools.check_flow()
    assert checked.is_error
    assert "results go nowhere" in checked.content
    assert "add a stage after it" in checked.content


def test_run_timeout_is_reported_not_hung(tmp_path: Path) -> None:
    tools = Tools(tmp_path, run_timeout=2)
    tools.write_flow(SLOW_FLOW)
    ran = tools.run_flow(sample=None, timeout=2)
    assert ran.is_error
    assert "did not finish within" in ran.content


def test_sample_file_formats(tmp_path: Path) -> None:
    for name, text, expected in (
        ("s.txt", "a\n\nb\n", ["a", "b"]),
        ("s.json", "[1, 2]", [1, 2]),
        ("s.jsonl", '{"k": 1}\n{"k": 2}\n', [{"k": 1}, {"k": 2}]),
    ):
        path = tmp_path / name
        path.write_text(text)
        tools = Tools(tmp_path, sample_path=path)
        assert tools._read_sample_file() == expected
    tools = Tools(tmp_path)
    assert tools.run_flow(use_sample_file=True).is_error


# ----------------------------------------------------------------------------- replay


@pytest.mark.parametrize("fixture", ["square_sum_anthropic.json", "square_sum_openai.json"])
def test_replayed_conversations_rebuild_the_flow(tmp_path: Path, fixture: str) -> None:
    events: list[str] = []
    result = build(
        "read integers from numbers.txt, square them, sum the even squares",
        workdir=tmp_path,
        provider=ReplayProvider(FIXTURES / fixture),
        on_event=lambda kind, payload: events.append(kind),
    )
    assert result.ok
    assert result.rounds == 2
    assert "def build(source=None)" in result.code
    assert (tmp_path / "flow.py").read_text() == result.code
    assert events.count("call") == 3
    assert events[-1] == "done"
    assert result.summary


def _fixture(turns: list[dict]) -> dict:  # type: ignore[type-arg]
    return {"provider": "fake", "turns": turns}


def test_error_feedback_loop_and_round_limit(tmp_path: Path) -> None:
    fixture = tmp_path / "rec.json"
    fixture.write_text(
        json.dumps(
            _fixture(
                [
                    {
                        "text": "plan",
                        "calls": [{"id": "1", "name": "write_flow", "args": {"code": BAD_FLOW}}],
                    },
                    {"text": "", "calls": [{"id": "2", "name": "check_flow", "args": {}}]},
                    {
                        "text": "fixing",
                        "calls": [{"id": "3", "name": "write_flow", "args": {"code": GOOD_FLOW}}],
                    },
                    {
                        "text": "",
                        "calls": [
                            {"id": "4", "name": "check_flow", "args": {}},
                            {"id": "5", "name": "run_flow", "args": {"sample": [1]}},
                        ],
                    },
                    {"text": "done: doubles numbers", "calls": []},
                ]
            )
        )
    )
    provider = ReplayProvider(fixture)
    builder = Builder(provider, tmp_path / "w")
    result = builder.build("double numbers")
    assert result.ok
    assert result.summary == "done: doubles numbers"
    # The model saw the GraphError text as an error result.
    errors = [r for _, results in provider.sent for r in results if r.is_error]
    assert any("results go nowhere" in r.content for r in errors)

    fixture.write_text(
        json.dumps(
            _fixture(
                [
                    {"text": "", "calls": [{"id": str(i), "name": "check_flow", "args": {}}]}
                    for i in range(4)  # three tool rounds, then the answer to 'stop using tools'
                ]
                + [{"text": "stuck", "calls": []}]
            )
        )
    )
    builder = Builder(ReplayProvider(fixture), tmp_path / "w2", max_rounds=3)
    result = builder.build("anything")
    assert not result.ok
    assert result.summary == "stuck"
    assert result.rounds == 3


def test_improve_continues_the_conversation(tmp_path: Path) -> None:
    fixture = tmp_path / "rec.json"
    fixture.write_text(
        json.dumps(
            _fixture(
                [
                    {
                        "text": "",
                        "calls": [
                            {"id": "1", "name": "write_flow", "args": {"code": GOOD_FLOW}},
                            {"id": "2", "name": "check_flow", "args": {}},
                            {"id": "3", "name": "run_flow", "args": {"sample": [2]}},
                        ],
                    },
                    {"text": "first", "calls": []},
                    {
                        "text": "",
                        "calls": [
                            {
                                "id": "4",
                                "name": "write_flow",
                                "args": {"code": GOOD_FLOW.replace("x * 2", "x * 3")},
                            },
                            {"id": "5", "name": "check_flow", "args": {}},
                            {"id": "6", "name": "run_flow", "args": {"sample": [2]}},
                        ],
                    },
                    {"text": "now triples", "calls": []},
                ]
            )
        )
    )
    provider = ReplayProvider(fixture)
    builder = Builder(provider, tmp_path / "w")
    first = builder.build("double")
    second = builder.improve("triple instead")
    assert first.ok
    assert second.ok
    assert "x * 3" in second.code
    assert provider.sent[2][0] == "triple instead"


def test_turn_and_toolcall_types() -> None:
    call = ToolCall("id", "write_flow", {"code": "x"})
    turn = Turn("hi", [call], {"input_tokens": 1})
    assert turn.calls[0].name == "write_flow"
    assert ToolSpec("n", "d", {"type": "object"}).name == "n"


# ----------------------------------------------------------------------------- cli


def _cli(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "tolquane.cli", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=120,
    )


def test_cli_check_explain_draw_run(tmp_path: Path) -> None:
    (tmp_path / "flow.py").write_text(GOOD_FLOW)
    out = _cli("check", "flow.py", cwd=tmp_path)
    assert out.returncode == 0
    assert "OK: 6 nodes" in out.stdout
    assert "draw" not in out.stdout
    assert "flowchart LR" in _cli("draw", "flow.py", cwd=tmp_path).stdout
    assert "double.emitter" in _cli("explain", "flow.py", cwd=tmp_path).stdout
    sample = tmp_path / "s.txt"
    sample.write_text("3\n")
    ran = _cli("run", "flow.py", "--sample", "s.txt", "--runtime", "sync", "--stats", cwd=tmp_path)
    assert ran.returncode == 0
    assert ran.stdout.strip() == "33"  # the sample is a line of text: '3' * 2
    assert "run on sync" in ran.stderr
    bad = _cli("check", "missing.py", cwd=tmp_path)
    assert bad.returncode != 0


def test_cli_build_with_replay_needs_no_key(tmp_path: Path) -> None:
    env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
    out = subprocess.run(
        [
            sys.executable,
            "-m",
            "tolquane.cli",
            "build",
            "square and sum",
            "--replay",
            str(FIXTURES / "square_sum_anthropic.json"),
            "--out",
            "out.py",
            "--no-interactive",
        ],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env=env,
        timeout=120,
    )
    assert out.returncode == 0, out.stderr
    assert "[checked and ran] out.py" in out.stdout
    assert "sum of even squares" in (tmp_path / "out.py").read_text()
    assert not (tmp_path / "flow.py").exists()


# ----------------------------------------------------------------------------- live


@pytest.mark.skipif(not os.environ.get("TOLQUANE_LIVE"), reason="set TOLQUANE_LIVE=1 with API keys")
@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_live_build(tmp_path: Path, provider: str) -> None:
    result = build(
        "emit the numbers 1 to 10 and print each one doubled",
        workdir=tmp_path,
        provider=provider,
        max_rounds=6,
    )
    assert result.ok, result.summary
    g = tq.check(__import__("importlib").util.spec_from_file_location("f", tmp_path / "flow.py"))  # noqa: F841  # pragma: no cover
