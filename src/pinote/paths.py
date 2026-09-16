"""Private, XDG-aware storage and process-wide display serialization."""

from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


def xdg_path(variable: str, fallback: str) -> Path:
    value = os.environ.get(variable, "")
    # The XDG specification says to ignore relative paths.
    return Path(value) if value and Path(value).is_absolute() else Path.home() / fallback


@dataclass(frozen=True)
class Paths:
    data: Path
    state: Path

    @classmethod
    def discover(cls) -> Paths:
        return cls(
            xdg_path("XDG_DATA_HOME", ".local/share") / "pinote",
            xdg_path("XDG_STATE_HOME", ".local/state") / "pinote",
        )

    @property
    def database(self) -> Path:
        return self.data / "notes.db"

    @property
    def log(self) -> Path:
        return self.state / "app.log"


def private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)


def private_file(path: Path) -> None:
    """Create privately without truncating or changing an existing file."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    os.close(fd)


@contextmanager
def display_lock(paths: Paths, *, blocking: bool = True) -> Iterator[None]:
    """Serialize mutations + rendering; GUI callers can fail fast when busy."""
    private_directory(paths.data)
    lock_path = paths.data / "display.lock"
    private_file(lock_path)
    with lock_path.open("a") as lock:
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(lock, flags)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
