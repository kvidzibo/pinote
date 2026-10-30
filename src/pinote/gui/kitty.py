"""Launch Pi without passing task text to a shell or transferring credentials."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from pinote.store import Note, NoteError


def _remote(kitty: str, address: str, *args: str) -> str:
    try:
        return subprocess.run(
            [kitty, "@", "--to", address, *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError) as exc:
        raise NoteError(
            "Kitty remote control failed; check its configuration before retrying."
        ) from exc


def _address(kitty: str) -> str | None:
    if address := os.environ.get("KITTY_LISTEN_ON"):
        _remote(kitty, address, "ls")
        return address  # An explicit address must never fall through to another instance.
    display = os.environ.get("DISPLAY", "").removesuffix(".0")
    if not display:
        return None
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            if (process / "comm").read_text().strip() != "kitty":
                continue
            environment = (process / "environ").read_bytes().split(b"\0")
            if not any(
                f"DISPLAY={value}".encode() in environment for value in (display, display + ".0")
            ):
                continue
            address = f"unix:@mykitty-{process.name}"
            _remote(kitty, address, "ls")
            return address
        except (OSError, NoteError):
            continue
    return None


def start_in_kitty(directory: str, note: Note) -> None:
    folder = Path(directory).resolve(strict=True)
    if not folder.is_dir():
        raise NoteError("Choose an existing directory.")
    kitty, pi = shutil.which("kitty"), shutil.which("pi")
    if not kitty or not pi:
        raise NoteError("Start in Kitty requires kitty and pi on PATH.")
    title = folder.name or str(folder)
    launch = json.dumps({"task_id": note.id, "updated_at": note.updated_at}, separators=(",", ":"))
    address = _address(kitty)
    if address:
        window = _remote(
            kitty,
            address,
            "launch",
            "--type=tab",
            f"--cwd={folder}",
            f"--env=PINOTE_LAUNCH_TASK={launch}",
            pi,
        )
        # Set separately: Kitty treats the launch title "current" specially.
        _remote(kitty, address, "set-tab-title", f"--match=window_id:{window}", "--", title)
        _remote(kitty, address, "focus-window", f"--match=id:{window}")
        return
    process = subprocess.Popen(
        [
            kitty,
            "--session=none",
            "--listen-on=unix:@mykitty-{kitty_pid}",
            "--override=allow_remote_control=socket-only",
            f"--directory={folder}",
            f"--title={title}",
            "/usr/bin/env",
            f"PINOTE_LAUNCH_TASK={launch}",
            pi,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    address = f"unix:@mykitty-{process.pid}"
    deadline = time.monotonic() + 5
    while process.poll() is None and time.monotonic() < deadline:
        try:
            _remote(kitty, address, "set-tab-title", "--", title)
            return
        except NoteError:
            time.sleep(0.1)
    raise NoteError("Kitty did not become ready. Check the new window before retrying.")
