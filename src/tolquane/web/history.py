"""The history of a flow: git, through ``subprocess``, and nothing else.

Tolquane Web does not keep versions of its own. A workspace that is a git repository
already has them, and the editor's History tab is a small window onto that repository:
the commits that touched one flow, what the file looked like at each of them, the diff
against the file as it is now, and a restore that writes an old version back into the
working tree.

Five rules shape everything here:

* **Only what a reader needs.** ``rev-parse``, ``status``, ``log``, ``show``, ``diff``,
  ``add``, ``commit`` and, on demand, ``init``. Never ``push``, ``reset`` or
  ``checkout``: this module must not be able to lose work that is not its own.
* **A commit is the flow's own files.** The ``.py`` and, when it exists, its
  ``.layout.json`` sidecar -- never ``-a``, so a save through the web page cannot sweep
  up whatever else the user was in the middle of.
* **Somebody's name is on it.** The commit is made with ``--author "<user>
  <user@tolquane.local>"`` and the same identity as committer, so a workspace without a
  configured ``user.email`` still commits, and the row says who asked for it.
* **A restore is not a commit.** It writes the file back and stops; the user saves, and
  that is when history moves.
* **No git is not an error.** Every call answers, and :func:`status` says why the tab is
  empty: git is not installed, or this directory is not in a repository.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .supervisor import child_env

log = logging.getLogger(__name__)

TIMEOUT = 15.0
"""Seconds any one git command gets. A repository this is too little for is enormous."""

LOG_LIMIT = 50
"""Commits the history tab asks for by default."""

SEP = "\x1f"
"""What the log format puts between fields: a byte no commit message contains."""

FORMAT = SEP.join(("%H", "%h", "%an", "%aI", "%s"))

GITIGNORE = """# Tolquane Web
.tolquane-web/
__pycache__/
"""

EMAIL_DOMAIN = "tolquane.local"
"""The domain the commit author gets. It is not a mailbox, and it is not meant to be."""

NO_GIT = "git is not on PATH; install git to keep a history of this workspace"

NOT_A_REPO = (
    "the workspace is not in a git repository; an administrator can make one from the "
    "History tab, or run 'git init' in it"
)


class HistoryError(Exception):
    """Git said no, and the message is git's own."""


@dataclass(frozen=True)
class Status:
    """Whether this workspace has a history at all, and how much of it is unsaved."""

    available: bool
    reason: str | None
    repo: bool
    root: str | None
    dirty: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "reason": self.reason,
            "repo": self.repo,
            "root": self.root,
            "dirty": self.dirty,
        }


@dataclass(frozen=True)
class Entry:
    """One commit that touched a flow."""

    rev: str
    short: str
    author: str
    date: str
    message: str
    head: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "rev": self.rev,
            "short": self.short,
            "author": self.author,
            "date": self.date,
            "message": self.message,
            "head": self.head,
        }


@dataclass(frozen=True)
class Made:
    """A commit that was written: what the response carries back."""

    rev: str
    short: str

    def to_dict(self) -> dict[str, Any]:
        return {"rev": self.rev, "short": self.short}


# --------------------------------------------------------------------------- running git


@dataclass(frozen=True)
class GitResult:
    code: int
    out: str
    err: str

    @property
    def ok(self) -> bool:
        return self.code == 0

    @property
    def message(self) -> str:
        for line in reversed((self.err.strip() or self.out.strip()).splitlines()):
            if line.strip():
                return line.strip()
        return f"git exited with code {self.code}"


def git_path() -> str | None:
    """Where git is, or ``None``. Looked up on every call: it may be installed later."""
    return shutil.which("git")


def git(workspace: Path, *args: str, timeout: float = TIMEOUT) -> GitResult:
    """Run one git command in the workspace. A missing git is a :class:`HistoryError`."""
    exe = git_path()
    if exe is None:
        raise HistoryError(NO_GIT)
    try:
        done = subprocess.run(
            [exe, *args],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=child_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise HistoryError(
            f"git {args[0] if args else ''} did not answer within {timeout:g}s"
        ) from exc
    except OSError as exc:  # pragma: no cover - git was there a moment ago
        raise HistoryError(f"could not run git: {exc}") from exc
    return GitResult(done.returncode, done.stdout, done.stderr)


def checked(workspace: Path, *args: str, timeout: float = TIMEOUT) -> str:
    """The output of a git command that has to work, or :class:`HistoryError` with why."""
    result = git(workspace, *args, timeout=timeout)
    if not result.ok:
        raise HistoryError(result.message)
    return result.out


# --------------------------------------------------------------------------- reading


def status(workspace: Path) -> Status:
    """Is there a history here? The one call the frontend makes before it shows the tab."""
    if git_path() is None:
        return Status(False, NO_GIT, False, None, 0)
    found = git(workspace, "rev-parse", "--show-toplevel")
    if not found.ok:
        return Status(False, NOT_A_REPO, False, None, 0)
    root = found.out.strip()
    dirty = git(workspace, "status", "--porcelain")
    lines = [line for line in dirty.out.splitlines() if line.strip()] if dirty.ok else []
    return Status(True, None, True, root, len(lines))


def require(workspace: Path) -> Status:
    """The status, or :class:`HistoryError` saying why there is no history to read."""
    found = status(workspace)
    if not found.available:
        raise HistoryError(found.reason or NOT_A_REPO)
    return found


def has_commits(workspace: Path) -> bool:
    """Does this repository have a HEAD yet? A fresh ``git init`` does not."""
    return git(workspace, "rev-parse", "--verify", "HEAD").ok


def entries(workspace: Path, path: str, limit: int = LOG_LIMIT) -> tuple[list[Entry], bool]:
    """The commits that touched this flow, newest first, and whether it has changed since.

    ``--follow`` is what makes a renamed flow keep its past. A repository with no commits
    at all, and a file that has never been committed, both answer with no entries and
    ``uncommitted`` true when the file is there: there is nothing to compare it with.
    """
    require(workspace)
    if not has_commits(workspace):
        return [], (workspace / path).is_file()
    head = git(workspace, "rev-parse", "HEAD").out.strip()
    text = checked(
        workspace,
        "log",
        "--follow",
        f"--max-count={max(1, limit)}",
        f"--format={FORMAT}",
        "--",
        path,
    )
    found = []
    for line in text.splitlines():
        fields = line.split(SEP)
        if len(fields) != 5:  # pragma: no cover - the format is ours
            continue
        rev, short, author, date, message = fields
        found.append(Entry(rev, short, author, date, message, head=rev == head))
    return found, is_dirty(workspace, path)


def is_dirty(workspace: Path, path: str) -> bool:
    """Does the file on disk differ from the last commit of it?"""
    result = git(workspace, "status", "--porcelain", "--", path)
    return bool(result.ok and result.out.strip())


def show(workspace: Path, rev: str, path: str) -> str:
    """The flow as it was at ``rev``."""
    require(workspace)
    return checked(workspace, "show", f"{check_rev(rev)}:./{path}")


def diff(workspace: Path, rev: str, path: str) -> str:
    """A unified diff of that revision against the file as it is now."""
    require(workspace)
    result = git(workspace, "diff", check_rev(rev), "--", path)
    if not result.ok:
        raise HistoryError(result.message)
    return result.out


REV = re.compile(r"^[A-Za-z0-9_.\-/^~@{}]{1,200}$")
"""What a revision may look like. Enough for a hash, a tag, ``HEAD~2`` and a branch, and
not enough for an option or a second argument smuggled in as one."""


def check_rev(rev: str) -> str:
    """The revision, or ``ValueError``: nothing that starts with ``-`` reaches git."""
    text = (rev or "").strip()
    if not text or text.startswith("-") or not REV.match(text):
        raise ValueError(f"{rev!r} is not a revision")
    return text


# --------------------------------------------------------------------------- writing


def init(workspace: Path) -> Status:
    """``git init`` in the workspace, with a ``.gitignore`` that leaves our own files out."""
    if git_path() is None:
        raise HistoryError(NO_GIT)
    already = status(workspace)
    if already.repo:
        raise HistoryError(f"{workspace} is already in a git repository ({already.root})")
    checked(workspace, "init")
    ignore = workspace / ".gitignore"
    existing = ignore.read_text(encoding="utf-8") if ignore.is_file() else ""
    missing = [
        line for line in GITIGNORE.splitlines() if line and line not in existing.splitlines()
    ]
    if missing:
        joined = existing + ("\n" if existing and not existing.endswith("\n") else "")
        ignore.write_text(joined + "\n".join(missing) + "\n", encoding="utf-8")
    return status(workspace)


def commit(workspace: Path, paths: list[str], message: str, author: str) -> Made | None:
    """Commit these files, and nothing else. ``None`` when there was nothing to commit."""
    require(workspace)
    here = [path for path in paths if (workspace / path).exists()]
    if not here:
        return None
    pending = git(workspace, "status", "--porcelain", "--", *here)
    if pending.ok and not pending.out.strip():
        return None  # the save changed nothing: not a failure, and not a commit either
    text = (message or "").strip() or f"Edit {paths[0]}"
    name = author_name(author)
    identity = [
        "-c",
        f"user.name={name}",
        "-c",
        f"user.email={name}@{EMAIL_DOMAIN}",
    ]
    add = git(workspace, "add", "--", *here)
    if not add.ok:
        raise HistoryError(add.message)
    made = git(
        workspace,
        *identity,
        "commit",
        "--author",
        f"{name} <{name}@{EMAIL_DOMAIN}>",
        "-m",
        text,
        "--",
        *here,
    )
    if not made.ok:
        if "nothing to commit" in (made.out + made.err).lower():  # pragma: no cover
            return None  # a race with another writer; the caller is told nothing happened
        raise HistoryError(made.message)
    rev = checked(workspace, "rev-parse", "HEAD").strip()
    short = git(workspace, "rev-parse", "--short", "HEAD").out.strip()
    return Made(rev, short or rev[:7])


def author_name(name: str) -> str:
    """A name git will accept: no angle brackets, no line breaks, never empty."""
    cleaned = re.sub(r"[<>\n\r]", " ", str(name or "")).strip()
    return cleaned[:64] or "tolquane"


def restore(workspace: Path, rev: str, paths: list[str]) -> list[str]:
    """Write these files back as they were at ``rev``, and say which of them existed.

    ``git show`` and a write, never ``git checkout``: the index is left exactly as the
    user had it, and a file that was not in that commit is not touched at all.
    """
    require(workspace)
    revision = check_rev(rev)
    restored = []
    for path in paths:
        result = git(workspace, "show", f"{revision}:./{path}")
        if not result.ok:
            continue  # the sidecar did not exist yet at that revision, or the flow did not
        target = workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(result.out, encoding="utf-8")
        restored.append(path)
    if not restored:
        raise HistoryError(f"{paths[0]} is not in revision {rev}")
    return restored


__all__ = [
    "GITIGNORE",
    "NOT_A_REPO",
    "NO_GIT",
    "Entry",
    "HistoryError",
    "Made",
    "Status",
    "author_name",
    "check_rev",
    "commit",
    "diff",
    "entries",
    "git",
    "git_path",
    "init",
    "is_dirty",
    "restore",
    "show",
    "status",
]
