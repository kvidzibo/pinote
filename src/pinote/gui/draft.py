"""Private draft snapshots; disk operations run on the GUI's single worker."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from threading import Lock

from pinote.paths import private_directory


class DraftCache:
    def __init__(self, path: Path):
        self.path = path
        self._lock = Lock()
        self._current = self._saved = (0, "")

    def load(self) -> str:
        """Load before connecting the editor's change handler."""
        try:
            text = self.path.read_bytes().decode("utf-8")
        except FileNotFoundError:
            text = ""
        self._current = self._saved = (0, text)
        return text

    def update(self, text: str) -> int:
        with self._lock:
            revision = self._current[0] + 1
            self._current = (revision, text)
            return revision

    def submitted(self, revision: int) -> None:
        with self._lock:
            # Editing back to the same text still creates a new draft. Never
            # clear it just because its contents match the submitted task.
            if self._current[0] == revision:
                self._current = (revision, "")

    def save(self) -> None:
        with self._lock:
            snapshot = self._current
            if snapshot == self._saved:
                return
        text = snapshot[1]
        if text:
            private_directory(self.path.parent)
            fd, temporary = tempfile.mkstemp(prefix=".gui-draft-", dir=self.path.parent)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(text.encode("utf-8"))
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        else:
            self.path.unlink(missing_ok=True)
        with self._lock:
            # Edits made during I/O remain different from this saved snapshot.
            self._saved = snapshot
