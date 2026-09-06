"""The flow model: every example round-trips, and what cannot be modelled stays code.

The bar is the one in ``docs/web.md``: parse a flow file, write it back, and the file
that comes out builds the same graph, keeps every node's source byte for byte, and is
the same bytes again after a second trip.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from tolquane.web.model import (
    CodeOnly,
    FlowModel,
    Layout,
    Position,
    Sample,
    Viewport,
    check_model,
    graph_view,
    layout_path,
    parse_file,
    parse_source,
    read_layout,
    to_python,
    write_layout,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples"
CONFIG = ROOT / "pyproject.toml"

CODE_ONLY = {"msom.py", "som.py"}
"""The two examples the model is not meant to represent: they build graphs at runtime."""

FLOWS = sorted(p for p in EXAMPLES.glob("*.py") if p.name not in CODE_ONLY)
FLOWS += sorted(EXAMPLES.glob("generated/*/flow.py"))
IDS = [p.stem if p.stem != "flow" else p.parent.name for p in FLOWS]


# --------------------------------------------------------------------------- helpers


def model_of(path: Path) -> FlowModel:
    parsed = parse_file(path)
    assert isinstance(parsed, FlowModel), getattr(parsed, "reason", "")
    return parsed


def ruff() -> str:
    found = shutil.which("ruff", path=str(Path(sys.executable).parent)) or shutil.which("ruff")
    if found is None:
        pytest.skip("ruff is not installed in this environment")
    return found


def ruff_codes(path: Path) -> Counter[str]:
    """The rule codes ruff reports for a file, with the repository's settings."""
    done = subprocess.run(
        [ruff(), "check", "--config", str(CONFIG), "--output-format", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return Counter(item["code"] for item in json.loads(done.stdout or "[]"))


EVERY_BLOCK = '''"""Every block the model knows, in one file."""

import tolquane as tq


@tq.source
def numbers():
    yield from range(10)


@tq.node
def double(x: int) -> int:
    return x * 2


@tq.node
def triple(x: int) -> int:
    return x * 3


@tq.node
def route(item: int, ctx: tq.Context) -> None:
    ctx.send(item)


@tq.raw
def merge(ctx: tq.Context) -> None:
    for _source, item in ctx.inputs():
        ctx.send(item)


@tq.sink
def show(x: int) -> None:
    print(x)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return (
        start
        >> tq.comb(double, triple)
        >> tq.all2all(tq.farm(double, 2), tq.farm(triple, 3), R=route)
        >> tq.farm([double, triple, double], emit="on_demand", prefetch=2)
        >> tq.feedback(tq.farm(double, 2, collector=route), name="again")
        >> tq.farm(double, 4, emitter=merge, collector=False, window=64, name="last", capacity=8)
        >> show
    )


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
'''

ORDERED_FARM = '''"""A farm that keeps the input order, for the graph view."""

import tolquane as tq


@tq.source
def numbers():
    yield from range(10)


@tq.node
def double(x: int) -> int:
    return x * 2


@tq.sink
def show(x: int) -> None:
    print(x)


def build(source=None):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.farm(double, 4, ordered=True) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
'''

DEAD_END = ORDERED_FARM.replace(
    "return start >> tq.farm(double, 4, ordered=True) >> show",
    "return start >> tq.farm(double, 4)",
)


# --------------------------------------------------------------------------- round trip


@pytest.mark.parametrize("path", FLOWS, ids=IDS)
def test_example_round_trips(path: Path) -> None:
    model = model_of(path)
    first = to_python(model)
    again = parse_source(first, model.name)
    assert isinstance(again, FlowModel), getattr(again, "reason", "")
    assert to_python(again) == first  # a second trip changes nothing


@pytest.mark.parametrize("path", FLOWS, ids=IDS)
def test_example_keeps_every_node_verbatim(path: Path) -> None:
    original = path.read_text(encoding="utf-8")
    model = model_of(path)
    assert model.nodes, "a flow has at least one node"
    for node in model.nodes:
        assert node.source in original, f"{node.id} was rewritten"
    generated = to_python(model)
    for node in model.nodes:
        assert node.source in generated


@pytest.mark.parametrize("path", FLOWS, ids=IDS)
def test_example_builds_the_same_graph(path: Path) -> None:
    model = model_of(path)
    assert graph_view(to_python(model)) == graph_view(path)


@pytest.mark.parametrize("path", FLOWS, ids=IDS)
def test_generated_code_is_formatted_and_no_dirtier_than_the_original(
    path: Path, tmp_path: Path
) -> None:
    generated = tmp_path / "flow.py"
    generated.write_text(to_python(model_of(path)), encoding="utf-8")
    formatted = subprocess.run(
        [ruff(), "format", "--check", "--config", str(CONFIG), str(generated)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert formatted.returncode == 0, formatted.stdout
    # The docstring and the node bodies are the author's, so a lint error already in the
    # file survives the trip; the generator must not add one of its own.
    added = ruff_codes(generated) - ruff_codes(path)
    assert not added, f"the generated file has new lint errors: {sorted(added)}"


def test_hello_moves_the_graph_from_main_into_build() -> None:
    model = model_of(EXAMPLES / "hello.py")
    generated = to_python(model)
    assert "def build(source=None):" in generated
    assert "def main() -> None:\n    tq.run(build())" in generated
    assert model.main is None
    assert "# ordered=True makes the farm deliver results in input order." in model.build_notes


def test_word_count_keeps_its_own_guard() -> None:
    model = model_of(EXAMPLES / "word_count.py")
    assert model.guard == "sys.exit(main())"
    assert to_python(model).endswith('if __name__ == "__main__":\n    sys.exit(main())\n')


def test_the_start_line_follows_the_convention() -> None:
    model = model_of(EXAMPLES / "generated/word_frequency/flow.py")
    assert model.start == "lines"
    assert "    start = lines if source is None else tq.from_iterable(source)" in to_python(model)


def test_a_long_pipeline_is_wrapped_one_stage_per_line() -> None:
    model = model_of(EXAMPLES / "generated/word_frequency/flow.py")
    generated = to_python(model)
    assert "    return (\n        start\n        >> tq.farm(words, 2)\n" in generated
    assert all(len(line) <= 100 for line in generated.split("\n") if ">>" in line)


def test_a_farm_too_wide_for_a_line_gets_one_option_per_line(tmp_path: Path) -> None:
    text = ORDERED_FARM.replace(
        "tq.farm(double, 4, ordered=True)",
        'tq.farm(double, 16, emit="on_demand", prefetch=4, name="a_farm_with_a_very_long_name", '
        "capacity=128)",
    )
    model = parse_source(text, "wide")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    generated = to_python(model)
    assert "        >> tq.farm(\n            double,\n            16,\n" in generated
    assert "            capacity=128,\n        )\n" in generated  # a magic trailing comma
    assert max(len(line) for line in generated.split("\n")) <= 100
    written = tmp_path / "wide.py"
    written.write_text(generated, encoding="utf-8")
    done = subprocess.run(
        [ruff(), "format", "--check", "--config", str(CONFIG), str(written)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stdout


def test_comments_around_build_and_after_the_guard_survive() -> None:
    text = (
        ORDERED_FARM.replace(
            "def build(source=None):", "# Why the farm has four workers.\ndef build(source=None):"
        )
        + "\n\n# A parting thought.\n"
    )
    model = parse_source(text, "commented")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    assert model.build_notes == ["# Why the farm has four workers."]
    assert model.epilogue == ["# A parting thought."]
    generated = to_python(model)
    assert "# Why the farm has four workers." in generated
    assert "# A parting thought." in generated


# --------------------------------------------------------------------------- code only


@pytest.mark.parametrize("name", sorted(CODE_ONLY))
def test_a_flow_built_at_runtime_opens_read_only(name: str) -> None:
    parsed = parse_file(EXAMPLES / name)
    assert isinstance(parsed, CodeOnly)
    assert parsed.reason
    assert parsed.reason[0].islower()
    assert parsed.graph is not None, "the canvas still needs the expanded graph to draw"
    assert parsed.graph["nodes"]
    assert parsed.graph["edges"]


def test_msom_keeps_its_links_and_its_loop() -> None:
    parsed = parse_file(EXAMPLES / "msom.py")
    assert isinstance(parsed, CodeOnly)
    assert parsed.graph is not None
    assert any(edge["rule"] == "link" for edge in parsed.graph["edges"])
    assert [loop["name"] for loop in parsed.graph["loops"]] == ["loop"]


def test_a_file_that_is_not_a_flow_is_code_only() -> None:
    parsed = parse_source("x = 1\n", "notaflow")
    assert isinstance(parsed, CodeOnly)
    assert "tolquane" in parsed.reason
    assert parsed.graph is None


def test_a_build_that_uses_the_sample_twice_is_code_only() -> None:
    text = ORDERED_FARM.replace(
        "return start >> tq.farm(double, 4, ordered=True) >> show",
        "return start >> tq.farm(double, len(source), ordered=True) >> show",
    )
    parsed = parse_source(text, "twice")
    assert isinstance(parsed, CodeOnly)
    assert "source" in parsed.reason


# --------------------------------------------------------------------------- the tree


def test_every_block_round_trips() -> None:
    model = parse_source(EVERY_BLOCK, "every_block")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    first = to_python(model)
    again = parse_source(first, "every_block")
    assert isinstance(again, FlowModel)
    assert to_python(again) == first
    stages = model.flow["stages"]
    assert [stage["type"] for stage in stages] == [
        "start",
        "comb",
        "all2all",
        "farm",
        "feedback",
        "farm",
        "ref",
    ]
    assert stages[3]["worker"] == [
        {"type": "ref", "id": "double"},
        {"type": "ref", "id": "triple"},
        {"type": "ref", "id": "double"},
    ]
    assert stages[3]["workers"] == 3
    assert stages[3]["options"]["emit"] == "on_demand"
    assert stages[4]["name"] == "again"
    assert stages[5]["options"]["collector"] is False
    assert stages[5]["options"]["emitter"] == {"type": "ref", "id": "merge"}


def test_a_lambda_and_a_call_stay_verbatim() -> None:
    model = model_of(EXAMPLES / "generated/csv_region_totals/flow.py")
    stages = model.flow["stages"]
    farm = next(stage for stage in stages if stage["type"] == "farm")
    assert farm["options"]["key"] == {"type": "inline", "source": "lambda p: p[0]"}
    assert stages[-1] == {"type": "inline", "source": "tq.sink(Report)"}
    assert model.node("Report") is not None, "a class an inline names is still a node"
    assert model.node("Report").kind == "sink"  # type: ignore[union-attr]


def test_a_farm_sized_by_a_constant_stays_one_expression() -> None:
    text = ORDERED_FARM.replace(
        "import tolquane as tq\n", "import tolquane as tq\n\nWORKERS = 4\n"
    ).replace("tq.farm(double, 4, ordered=True)", "tq.farm(double, WORKERS, ordered=True)")
    model = parse_source(text, "sized")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    assert model.flow["stages"][1] == {
        "type": "inline",
        "source": "tq.farm(double, WORKERS, ordered=True)",
    }
    assert "tq.farm(double, WORKERS, ordered=True)" in to_python(model)


def test_node_metadata() -> None:
    model = model_of(EXAMPLES / "word_count.py")
    kinds = {node.id: node.kind for node in model.nodes}
    assert kinds == {"lines": "source", "words": "node", "Count": "node", "show": "sink"}
    count = model.node("Count")
    assert count is not None
    assert count.is_class
    assert count.params == ["word"]
    assert not count.is_async
    assert model.prelude[0] == "import sys"
    assert model.prelude[1].startswith('TEXT = """the quick brown fox')


def test_an_async_node_is_marked() -> None:
    text = ORDERED_FARM.replace(
        "@tq.node\ndef double(x: int) -> int:\n    return x * 2",
        "@tq.node\nasync def double(x: int) -> int:\n    return x * 2",
    ).replace(", ordered=True", "")
    model = parse_source(text, "async_flow")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    double = model.node("double")
    assert double is not None
    assert double.is_async


def test_the_model_is_json() -> None:
    model = model_of(EXAMPLES / "generated/newton_sqrt_feedback/flow.py")
    data = json.loads(json.dumps(model.to_dict()))
    assert data["version"] == 1
    assert data["name"] == "flow"
    assert to_python(FlowModel.from_dict(data)) == to_python(model)


# --------------------------------------------------------------------------- checking


def test_check_model_is_quiet_about_a_good_model() -> None:
    model = parse_source(ORDERED_FARM, "ordered")
    assert isinstance(model, FlowModel)
    assert check_model(model) == []


def test_check_model_names_a_farm_with_nothing_after_it() -> None:
    model = parse_source(DEAD_END, "dead_end", verify=False)
    assert isinstance(model, FlowModel)
    problems = check_model(model)
    assert len(problems) == 1
    assert "double" in problems[0]
    assert "go nowhere" in problems[0]


def test_check_model_names_a_stage_that_is_not_a_node() -> None:
    model = parse_source(ORDERED_FARM, "ordered")
    assert isinstance(model, FlowModel)
    model.flow["stages"][-1] = {"type": "ref", "id": "missing"}
    assert check_model(model) == ["the flow uses 'missing', which is not one of its nodes"]


# --------------------------------------------------------------------------- graph view


def test_graph_view_of_an_ordered_farm() -> None:
    view = graph_view(ORDERED_FARM)
    assert set(view) == {"nodes", "edges", "loops", "windows"}
    names = [node["name"] for node in view["nodes"]]
    assert names == [
        "numbers",
        "double.emitter",
        "double.0",
        "double.1",
        "double.2",
        "double.3",
        "double.collector",
        "show",
    ]
    workers = [n for n in view["nodes"] if n["role"] == "worker"]
    assert len(workers) == 4
    assert all(worker["tagged"] and worker["group"] == "double" for worker in workers)
    assert view["windows"] == {"double.window": 256}
    assert view["loops"] == []
    assert {
        "src": "double.emitter",
        "dst": "double.0",
        "rule": "farm",
        "feedback": False,
        "capacity": None,
        "batch": None,
    } in view["edges"]


def test_graph_view_takes_a_block_a_model_and_a_path() -> None:
    model = parse_source(ORDERED_FARM, "ordered")
    assert isinstance(model, FlowModel)
    from_model = graph_view(model)
    assert from_model == graph_view(ORDERED_FARM)
    assert graph_view(EXAMPLES / "hello.py")["windows"] == {"double.window": 256}


def test_graph_view_of_a_feedback_flow_names_the_loop() -> None:
    view = graph_view(EXAMPLES / "generated/newton_sqrt_feedback/flow.py")
    assert [loop["name"] for loop in view["loops"]] == ["loop"]
    assert any(edge["feedback"] for edge in view["edges"])


# --------------------------------------------------------------------------- the sidecar


def test_layout_reads_and_writes(tmp_path: Path) -> None:
    flow = tmp_path / "flow.py"
    flow.write_text(ORDERED_FARM, encoding="utf-8")
    assert read_layout(flow) is None  # nothing written yet
    layout = Layout(
        positions={"stages.0": Position(0, 0), "stages.1.worker": Position(260, 40)},
        viewport=Viewport(10, 20, 1.5),
        samples=[Sample("three lines", ["a b", "b c", "c"])],
    )
    write_layout(flow, layout)
    assert layout_path(flow) == tmp_path / "flow.layout.json"
    assert layout_path(flow).exists()
    back = read_layout(flow)
    assert back is not None
    assert back.to_dict() == layout.to_dict()
    assert back.positions["stages.1.worker"].x == 260
    assert back.samples[0].items == ["a b", "b c", "c"]
    assert back.viewport is not None
    assert back.viewport.zoom == 1.5


def test_layout_takes_the_sidecar_path_too(tmp_path: Path) -> None:
    sidecar = tmp_path / "flow.layout.json"
    write_layout(sidecar, Layout())
    assert layout_path(sidecar) == sidecar
    data = json.loads(sidecar.read_text(encoding="utf-8"))
    assert data == {"version": 1, "positions": {}, "viewport": None, "samples": []}


def test_layout_survives_a_broken_sidecar(tmp_path: Path) -> None:
    flow = tmp_path / "flow.py"
    (tmp_path / "flow.layout.json").write_text("{not json", encoding="utf-8")
    assert read_layout(flow) is None


# --------------------------------------------------------------------------- the cli


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "tolquane.web.model", *args],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=ROOT,
    )


def test_cli_parse_prints_the_model() -> None:
    done = run_cli("parse", str(EXAMPLES / "hello.py"))
    assert done.returncode == 0, done.stderr
    data: dict[str, Any] = json.loads(done.stdout)
    assert data["name"] == "hello"
    assert [node["id"] for node in data["nodes"]] == ["numbers", "double", "show"]


def test_cli_parse_prints_code_only_with_a_graph() -> None:
    done = run_cli("parse", str(EXAMPLES / "msom.py"))
    assert done.returncode == 0, done.stderr
    data = json.loads(done.stdout)
    assert data["code_only"] is True
    assert data["reason"]
    assert data["graph"]["nodes"]


def test_cli_generate_prints_python(tmp_path: Path) -> None:
    model = model_of(EXAMPLES / "generated/primes_in_order/flow.py")
    path = tmp_path / "model.json"
    path.write_text(json.dumps(model.to_dict()), encoding="utf-8")
    done = run_cli("generate", str(path))
    assert done.returncode == 0, done.stderr
    assert done.stdout == to_python(model)


def test_cli_graph_prints_the_expanded_graph() -> None:
    done = run_cli("graph", str(EXAMPLES / "hello.py"))
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == graph_view(EXAMPLES / "hello.py")


def test_cli_reports_a_bad_file() -> None:
    done = run_cli("parse", str(EXAMPLES / "nothing_here.py"))
    assert done.returncode == 1
    assert "error" in json.loads(done.stdout)


def test_cli_without_a_command() -> None:
    done = run_cli("explain", "flow.py")
    assert done.returncode == 2
    assert "usage" in done.stderr


# --------------------------------------------------------------------------- parameters


PARAMETERS = '''"""A flow whose build() takes parameters."""

import tolquane as tq


@tq.source
def numbers():
    yield from range(10)


@tq.node
def double(x: int) -> int:
    return x * 2


@tq.sink
def show(x: int) -> None:
    print(x)


def build(source=None, *, workers: int = 2, label="doubling"):
    start = numbers if source is None else tq.from_iterable(source)
    return start >> tq.farm(double, workers, name=label) >> show


def main() -> None:
    tq.run(build())


if __name__ == "__main__":
    main()
'''

NO_DEFAULT = PARAMETERS.replace("workers: int = 2", "workers: int")
COMPUTED = PARAMETERS.replace("workers: int = 2", "workers: int = len(TEXT)")
POSITIONAL = PARAMETERS.replace("source=None, *, workers: int = 2, label=", "source=None, workers=")


def test_the_parameters_of_build_are_read_in_order() -> None:
    model = parse_source(PARAMETERS, "parameters")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    assert [p.to_dict() for p in model.params] == [
        {"name": "workers", "default": "2", "annotation": "int"},
        {"name": "label", "default": '"doubling"', "annotation": None},
    ]


def test_a_flow_with_parameters_makes_the_whole_round_trip(tmp_path: Path) -> None:
    original = tmp_path / "parameters.py"
    original.write_text(PARAMETERS, encoding="utf-8")
    model = model_of(original)
    first = to_python(model)
    assert 'def build(source=None, *, workers: int = 2, label="doubling"):' in first
    assert first == PARAMETERS  # the file was already in the house style
    again = parse_source(first, "parameters")
    assert isinstance(again, FlowModel), getattr(again, "reason", "")
    assert to_python(again) == first
    assert graph_view(first) == graph_view(original)
    for node in model.nodes:
        assert node.source in first
    generated = tmp_path / "generated.py"
    generated.write_text(first, encoding="utf-8")
    done = subprocess.run(
        [ruff(), "format", "--check", "--config", str(CONFIG), str(generated)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stdout
    assert not ruff_codes(generated) - ruff_codes(original)


def test_main_still_calls_build_with_the_defaults() -> None:
    model = parse_source(PARAMETERS, "parameters")
    assert isinstance(model, FlowModel)
    assert model.main is None
    assert "def main() -> None:\n    tq.run(build())" in to_python(model)


def test_a_parameter_is_a_name_the_flow_can_use() -> None:
    """`workers` sizes the farm, so the farm stays verbatim and build() still runs."""
    model = parse_source(PARAMETERS, "parameters")
    assert isinstance(model, FlowModel)
    assert model.flow["stages"][1] == {
        "type": "inline",
        "source": "tq.farm(double, workers, name=label)",
    }
    assert check_model(model) == []


def test_every_literal_default_survives_the_trip() -> None:
    signature = (
        "source=None, *, ratio: float = 0.5, quiet: bool = False, tag: str = 'a\"b', "
        "limit=None, rows: tuple = (1, 2), gap: int = -1"
    )
    text = PARAMETERS.replace(
        'source=None, *, workers: int = 2, label="doubling"', signature
    ).replace("tq.farm(double, workers, name=label)", "tq.farm(double, 2)")
    model = parse_source(text, "literals")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    assert [(p.name, p.default) for p in model.params] == [
        ("ratio", "0.5"),
        ("quiet", "False"),
        ("tag", "'a\"b'"),
        ("limit", "None"),
        ("rows", "(1, 2)"),
        ("gap", "-1"),
    ]
    first = to_python(model)
    again = parse_source(first, "literals")
    assert isinstance(again, FlowModel), getattr(again, "reason", "")
    assert to_python(again) == first


def test_a_long_signature_is_written_one_parameter_per_line(tmp_path: Path) -> None:
    signature = (
        'source=None, *, threshold: float = 0.5, path: str = "some/rather/long/data.csv", '
        'retries: int = 3, verbose: bool = False, label: str = "the run of the day"'
    )
    text = PARAMETERS.replace(
        'source=None, *, workers: int = 2, label="doubling"', signature
    ).replace("tq.farm(double, workers, name=label)", "tq.farm(double, retries)")
    model = parse_source(text, "wide_signature")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    generated = to_python(model)
    assert "def build(\n    source=None,\n    *,\n    threshold: float = 0.5,\n" in generated
    assert '    label: str = "the run of the day",\n):\n' in generated
    assert max(len(line) for line in generated.split("\n")) <= 100
    written = tmp_path / "wide_signature.py"
    written.write_text(generated, encoding="utf-8")
    done = subprocess.run(
        [ruff(), "format", "--check", "--config", str(CONFIG), str(written)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stdout


def test_a_parameter_without_a_default_is_code_only() -> None:
    parsed = parse_source(NO_DEFAULT, "no_default")
    assert isinstance(parsed, CodeOnly)
    assert parsed.reason == (
        "build()'s parameter 'workers' has no default; the model runs the flow with its "
        "defaults, so every parameter needs one"
    )
    # Nothing can draw it either: build() cannot be called without a value for it.
    assert parsed.graph is None


def test_a_default_that_is_not_a_literal_is_code_only() -> None:
    parsed = parse_source(COMPUTED, "computed")
    assert isinstance(parsed, CodeOnly)
    assert parsed.reason == (
        "the default of build()'s parameter 'workers' is `len(TEXT)`, which is not a literal"
    )


def test_a_second_positional_parameter_is_still_code_only() -> None:
    parsed = parse_source(POSITIONAL, "positional")
    assert isinstance(parsed, CodeOnly)
    assert "positional parameters" in parsed.reason
    assert "build(source=None, *, name=default, ...)" in parsed.reason


def test_the_parameters_are_in_the_json_and_an_older_model_has_none() -> None:
    model = parse_source(PARAMETERS, "parameters")
    assert isinstance(model, FlowModel)
    data = json.loads(json.dumps(model.to_dict()))
    assert data["params"] == [
        {"name": "workers", "default": "2", "annotation": "int"},
        {"name": "label", "default": '"doubling"', "annotation": None},
    ]
    assert to_python(FlowModel.from_dict(data)) == to_python(model)
    older = {key: value for key, value in data.items() if key != "params"}
    revived = FlowModel.from_dict(older)
    assert revived.params == []
    assert "def build(source=None):" in to_python(revived)


def test_a_build_with_star_args_or_kwargs_is_code_only() -> None:
    for signature in ("source=None, *args, workers: int = 2", "source=None, **extra"):
        text = PARAMETERS.replace('source=None, *, workers: int = 2, label="doubling"', signature)
        parsed = parse_source(text, "loose")
        assert isinstance(parsed, CodeOnly)
        assert parsed.reason == (
            "build() takes the sample source and keyword-only parameters, nothing else"
        )


def test_a_build_with_parameters_and_no_source_gets_one_back() -> None:
    text = (
        PARAMETERS.replace('source=None, *, workers: int = 2, label="doubling"', "*, workers=2")
        .replace("    start = numbers if source is None else tq.from_iterable(source)\n", "")
        .replace("return start >>", "return numbers >>")
        .replace("tq.farm(double, workers, name=label)", "tq.farm(double, workers)")
    )
    model = parse_source(text, "no_source")
    assert isinstance(model, FlowModel), getattr(model, "reason", "")
    assert [p.name for p in model.params] == ["workers"]
    assert "def build(source=None, *, workers=2):" in to_python(model)
