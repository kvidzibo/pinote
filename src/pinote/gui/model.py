"""GTK-free data boundary: short-lived connections, existing locks and history."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from pinote.paths import Paths, display_lock
from pinote.store import Note, NoteError, Store


@dataclass(frozen=True)
class TransitionResult:
    notes: list[Note]
    changed: bool


class ReminderModel:
    def __init__(self, paths: Paths):
        self.paths = paths

    def notes(self) -> list[Note]:
        with Store(self.paths.database, timeout=0.1) as store:
            return store.notes()

    def add(self, text: str) -> int:
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                # Report the committed ID before any separate list refresh. A
                # failed read must not make a saved add look retryable.
                return store.add(text)

    def transition(self, note_id: int, action: str) -> TransitionResult:
        if action not in {"done", "rm"}:
            raise NoteError("The checklist only supports Done and Remove.")
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                # A CLI mutation may have made this row stale since the last poll.
                # Do not archive an already-completed note from an obsolete row.
                changed = False
                if any(note.id == note_id for note in store.notes()):
                    changed = store.transition(note_id, action)
                # A stale no-op must refresh the UI without a success animation.
                return TransitionResult(store.notes(), changed)


def application_id(paths: Paths) -> str:
    # Single instance per database, not per machine: separate XDG profiles can
    # coexist. Never put note text or a private path into the D-Bus name.
    digest = hashlib.sha256(os.fsencode(paths.database.resolve())).hexdigest()[:32]
    return f"io.github.kvidzibo.pinote.g{digest}"
