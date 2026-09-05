"""Tolquane: parallel programming with composable building blocks.

Nodes speak on channels. Pipelines, farms and all-to-all blocks compose them, and the
same graph runs on threads, processes or across a network. The design lives in
``DESIGN.md`` at the repository root.

This release is a placeholder that reserves the name; the public API described in the
design is not implemented yet.
"""

from __future__ import annotations

from typing import Final

__version__ = "0.0.1"


class _Skip:
    """Type of the :data:`SKIP` sentinel. Do not instantiate; use ``SKIP``."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "tolquane.SKIP"

    def __reduce__(self) -> str:
        # Pickle as a reference to the module-level name so that the sentinel stays a
        # singleton across processes and network channels.
        return "SKIP"


SKIP: Final = _Skip()
"""Return ``SKIP`` from a node to send nothing for the current item.

``None`` is an ordinary value in Tolquane and travels downstream like any other; ``SKIP``
is the only way for a function node to drop an item.
"""

__all__ = ["SKIP", "__version__"]
