"""``tolquane launch``: start every group of a deploy file with one command.

Each group becomes ``python -m tolquane run flow.py --deploy deploy.toml --group NAME``,
run here when the group's host is this machine and over ``ssh`` otherwise, the way
FastFlow's ``dff_run`` does it. The flow, the deploy file and Tolquane must be present
on every host at the same paths (or set ``workdir`` and ``python`` in the deploy file).
Output lines are prefixed with the group name; Ctrl-C stops every group; the exit code
is the first non-zero one.
"""

from __future__ import annotations

import shlex
import socket
import subprocess
import sys
import threading
from pathlib import Path

from .net import Deployment, Group, load_deployment

__all__ = ["commands", "launch"]

_LOCAL = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _is_local(host: str) -> bool:
    if host in _LOCAL:
        return True
    names = {socket.gethostname(), socket.getfqdn()}
    if host in names:
        return True
    try:
        return socket.gethostbyname(host) in {
            "127.0.0.1",
            socket.gethostbyname(socket.gethostname()),
        }
    except OSError:
        return False


def commands(
    deployment: Deployment,
    deploy_path: str,
    flow: str,
    *,
    runtime: str = "threads",
    batch: int = 32,
    stats: bool = False,
    optimize: bool = False,
) -> list[tuple[Group, list[str], bool]]:
    """The command per group as ``(group, argv, local)``."""
    out: list[tuple[Group, list[str], bool]] = []
    for group in deployment.groups.values():
        target = group.ssh or group.host
        local = group.ssh is None and _is_local(target)
        python = group.python or deployment.python or (sys.executable if local else "python3")
        workdir = group.workdir or deployment.workdir
        argv = [
            python,
            "-m",
            "tolquane",
            "run",
            flow,
            "--deploy",
            deploy_path,
            "--group",
            group.name,
            "--runtime",
            runtime,
            "--batch",
            str(batch),
        ]
        if stats:
            argv.append("--stats")
        if optimize:
            argv.append("--optimize")
        if local:
            if workdir:
                argv = ["sh", "-c", f"cd {shlex.quote(workdir)} && exec {shlex.join(argv)}"]
            out.append((group, argv, True))
        else:
            remote = shlex.join(argv)
            if workdir:
                remote = f"cd {shlex.quote(workdir)} && exec {remote}"
            out.append((group, ["ssh", "-T", "-o", "BatchMode=yes", target, remote], False))
    return out


def launch(
    deploy_path: str,
    flow: str,
    *,
    runtime: str = "threads",
    batch: int = 32,
    stats: bool = False,
    show: list[str] | None = None,
    dry_run: bool = False,
    optimize: bool = False,
) -> int:
    deployment = load_deployment(deploy_path)
    flow_path = str(Path(flow))
    plan = commands(
        deployment,
        str(Path(deploy_path)),
        flow_path,
        runtime=runtime,
        batch=batch,
        stats=stats,
        optimize=optimize,
    )
    if show is not None:
        unknown = set(show) - set(deployment.groups)
        if unknown:
            raise SystemExit(f"--show names unknown group(s): {sorted(unknown)}")
    if dry_run:
        for group, argv, local in plan:
            where = "here" if local else "over ssh"
            print(f"[{group.name}] {where}: {shlex.join(argv)}")
        return 0
    procs: list[tuple[Group, subprocess.Popen[bytes]]] = []
    readers: list[threading.Thread] = []
    for group, argv, _local in plan:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        procs.append((group, proc))
        visible = show is None or group.name in show
        t = threading.Thread(target=_pump, args=(group.name, proc, visible), daemon=True)
        t.start()
        readers.append(t)
    codes: dict[str, int] = {}
    try:
        for group, proc in procs:
            codes[group.name] = proc.wait()
            if codes[group.name] != 0:
                for other, p in procs:
                    if other is not group and p.poll() is None:
                        p.terminate()
    except KeyboardInterrupt:
        for _group, proc in procs:
            if proc.poll() is None:
                proc.terminate()
        for _group, proc in procs:
            proc.wait()
        print("interrupted: every group stopped", file=sys.stderr)
        return 130
    for t in readers:
        t.join(timeout=5)
    failed = [name for name, code in codes.items() if code != 0]
    if failed:
        print(f"group(s) failed: {', '.join(failed)}", file=sys.stderr)
        return next(code for name, code in codes.items() if code != 0)
    return 0


def _pump(name: str, proc: subprocess.Popen[bytes], visible: bool) -> None:
    assert proc.stdout is not None
    for raw in proc.stdout:
        if visible:
            line = raw.decode(errors="replace").rstrip("\n")
            print(f"[{name}] {line}", flush=True)
