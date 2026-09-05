# Tolquane: notes for Claude Code sessions

- Name: **Tolquane** in prose, `tolquane` in code, package names and URLs. Decision record in `docs/decisions/0001-naming.md`.
- The design contract is `DESIGN.md`. Section 6 (liveness rules), section 9 (AI builder) and section 11 (decisions) are settled; do not reopen them without the owner.
- Predecessor: BBFlow (Java), https://github.com/robtacconelli/BBFlow. Its thesis is in `reference/BBFlow_documentation.pdf`. Tolquane is a clean-room rewrite; do not copy Java code.
- License Apache-2.0. Python >= 3.11. Pure Python, no required dependencies; optional extras only.
- Always work inside the project virtualenv: `uv venv .venv --python 3.13`, then `uv pip install --python .venv/bin/python -e ".[dev]"`. Run tools as `.venv/bin/<tool>`.
- Extra interpreters for local matrix runs live in `.venv311/` and `.venv314t/` (gitignored), created the same way with `--python 3.11` / `--python 3.14t`.
- On this machine the root filesystem is full. uv's cache is set to `/mnt/1T/home/st4ck/.uv/cache` in `~/.config/uv/uv.toml`, and `~/.local/share/uv/python` is a symlink to `/mnt/1T/home/st4ck/.uv/python`, so interpreters land on the 1T disk too. Never point downloads or caches at `/` or `~`.
- Before committing run: `.venv/bin/ruff check .`, `.venv/bin/ruff format --check .`, `.venv/bin/mypy`, `.venv/bin/pytest`.
- Commits: plain messages, no `Co-Authored-By` and no session trailers (owner's request).
- API keys never go into the repository, fixtures or docs. Live builder tests run only with `TOLQUANE_LIVE=1` and keys in the environment; the default suite replays `tests/fixtures/ai/*.json`. Record a new fixture with `tolquane build ... --record file.json`.
- The builder's system prompt is assembled from `src/tolquane/ai/resources/` (the API card, the style guide, two example flows); `tests/test_ai.py` keeps those copies identical to `docs/` and `examples/`. Edit the originals and copy.
- The processes runtime (`src/tolquane/processes.py`) spawns children; tests that use it define workers at module level so plain pickle finds them, and cloudpickle (a dev dependency) covers closures. Never fork.
- Layout: `src/tolquane/` package, `tests/` (with `tests/liveness/` for the section 6 rules), `docs/` (`api-card.md` is the one-page API, `style.md` the house style for flows), `examples/` (flows in the house style; the AI builder reads them), `benchmarks/`, `reference/`.
- Run the tests on every local interpreter before a commit that touches the core: `.venv/bin/pytest`, `.venv311/bin/pytest`, `.venv314t/bin/pytest`.
