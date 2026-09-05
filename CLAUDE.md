# Tolquane: notes for Claude Code sessions

- Name: **Tolquane** in prose, `tolquane` in code, package names and URLs. Decision record in `docs/decisions/0001-naming.md`.
- The design contract is `DESIGN.md`. Section 6 (liveness rules) and section 10 (decisions) are settled; do not reopen them without the owner.
- Predecessor: BBFlow (Java), https://github.com/robtacconelli/BBFlow. Its thesis is in `reference/BBFlow_documentation.pdf`. Tolquane is a clean-room rewrite; do not copy Java code.
- License Apache-2.0. Python >= 3.11. Pure Python, no required dependencies; optional extras only.
- Always work inside the project virtualenv: `uv venv .venv --python 3.13`, then `uv pip install --python .venv/bin/python -e ".[dev]"`. Run tools as `.venv/bin/<tool>`.
- Extra interpreters for local matrix runs live in `.venv311/` and `.venv314t/` (gitignored), created the same way with `--python 3.11` / `--python 3.14t`.
- On this machine the root filesystem is full. uv's cache is set to `/mnt/1T/home/st4ck/.uv/cache` in `~/.config/uv/uv.toml`, and `~/.local/share/uv/python` is a symlink to `/mnt/1T/home/st4ck/.uv/python`, so interpreters land on the 1T disk too. Never point downloads or caches at `/` or `~`.
- Before committing run: `.venv/bin/ruff check .`, `.venv/bin/ruff format --check .`, `.venv/bin/mypy`, `.venv/bin/pytest`.
- Commits: plain messages, no `Co-Authored-By` and no session trailers (owner's request).
- Layout: `src/tolquane/` package, `tests/`, `docs/`, `reference/`.
