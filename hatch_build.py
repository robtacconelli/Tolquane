"""Build hook that puts the Tolquane Web frontend into the wheel and the sdist.

The frontend is a Node project (``web/``) whose output belongs to the Python package
(``src/tolquane/web/static``); ``pyproject.toml`` lists that directory as a build
artifact, so whatever is there when this hook finishes ends up in the distribution.

Node is a build-time tool only, which leaves three cases:

* the assets are already in place -- a checkout where someone ran ``npm run build``, or
  a wheel built from an sdist that carries them: use them, run nothing;
* they are missing and ``npm`` is on PATH: build them;
* they are missing and there is no usable Node project: ship the library without the
  GUI rather than failing. ``pip install tolquane`` must work on a machine that has
  never heard of Node.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

WEB_DIR = "web"
STATIC_DIR = Path("src") / "tolquane" / "web" / "static"


class TolquaneWebBuildHook(BuildHookInterface):  # type: ignore[type-arg]
    """Run ``npm ci && npm run build`` when the built assets are missing."""

    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if self.target_name not in ("wheel", "sdist"):
            return

        root = Path(self.root)
        if (root / STATIC_DIR / "index.html").exists():
            self.app.display_info(f"tolquane web: using the frontend already in {STATIC_DIR}")
            return

        web = root / WEB_DIR
        if not (web / "package.json").exists():
            self.app.display_waiting("tolquane web: no web/ project, building without the GUI")
            return

        npm = shutil.which("npm")
        if npm is None:
            self.app.display_waiting("tolquane web: no npm on PATH, building without the GUI")
            return

        try:
            subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=web, check=True)
            subprocess.run([npm, "run", "build"], cwd=web, check=True)
        except subprocess.CalledProcessError as error:
            # A broken frontend build must not make the library unbuildable.
            self.app.display_waiting(
                f"tolquane web: npm build failed ({error}), building without the GUI"
            )
            return

        self.app.display_info("tolquane web: built the frontend with npm")
