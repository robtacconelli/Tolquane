"""Sentinel objects shared across the package."""

from __future__ import annotations

from typing import Final


class _Sentinel:
    __slots__ = ("_name",)

    def __init__(self, name: str) -> None:
        self._name = name

    def __repr__(self) -> str:
        return f"tolquane.{self._name}"

    def __reduce__(self) -> str:
        # Pickle as a reference to the module-level name so the sentinel stays a
        # singleton across processes and network channels.
        return self._name


SKIP: Final = _Sentinel("SKIP")
"""Return ``SKIP`` from a node to send nothing for the current item.

``None`` is an ordinary value in Tolquane and travels downstream like any other; ``SKIP``
is the only way for a function node to drop an item.
"""

EOS: Final = _Sentinel("EOS")
"""End of stream marker that travels through a channel after its last item."""

END: Final = _Sentinel("END")
"""Internal marker: a tagged item produced all of its outputs."""
