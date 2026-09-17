"""GTK-free data boundary: short-lived connections, existing locks and history."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from datetime import datetime

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
            if store.has_due():
                with display_lock(self.paths, blocking=False):
                    store.activate_due()
            return store.notes()

    def reminders(self) -> list[Note]:
        with Store(self.paths.database, timeout=0.1) as store:
            return store.scheduled_notes()

    def schedule(self, note: Note, when: datetime) -> bool:
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                return store.schedule(note.id, when, expected_updated_at=note.updated_at)

    def release(self, note: Note) -> bool:
        if note.state != "scheduled":
            raise NoteError("Only scheduled reminders can be moved back early.")
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                return store.transition(
                    note.id,
                    "restore",
                    expected_states={"scheduled"},
                    expected_updated_at=note.updated_at,
                )

    def tags(self) -> list[str]:
        with Store(self.paths.database, timeout=0.1) as store:
            return store.tags()

    def add(self, text: str, *, tag: str | None = None) -> int:
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                # Report the committed ID before any separate list refresh. A
                # failed read must not make a saved add look retryable.
                return store.add(text, tag=tag)

    def edit(self, note: Note, text: str) -> bool:
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                return store.edit(note.id, text, expected_updated_at=note.updated_at)

    def set_tag(self, note: Note, tag: str | None) -> bool:
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                return store.set_tag(note.id, tag, expected_updated_at=note.updated_at)

    def transition(self, note_id: int, action: str) -> TransitionResult:
        expected_states = {
            "start": {"active"},
            "reset": {"in_progress"},
            "done": {"in_progress"},
            "rm": {"active", "in_progress"},
        }
        if action not in expected_states:
            raise NoteError("The checklist only supports Start, Reset, Done, and Remove.")
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                # A stale click must not complete a reset task, restart a done
                # task, or archive a task already completed by another frontend.
                changed = store.transition(note_id, action, expected_states=expected_states[action])
                # A stale no-op must refresh the UI without a success animation.
                return TransitionResult(store.notes(), changed)

    def archive(self) -> list[Note]:
        with Store(self.paths.database, timeout=0.1) as store:
            return store.archived_notes()

    def restore(self, note: Note) -> bool:
        if note.state not in {"done", "removed"}:
            raise NoteError("Only completed or removed tasks can be restored from the archive.")
        with display_lock(self.paths, blocking=False):
            with Store(self.paths.database, timeout=0.1) as store:
                # Compare the displayed revision inside the write transaction.
                # A stale restore must not reset a newly restarted/re-archived task.
                # Refresh separately so read failures cannot disguise a saved restore.
                return store.transition(
                    note.id,
                    "restore",
                    expected_states={note.state},
                    expected_updated_at=note.updated_at,
                )


def application_id(paths: Paths) -> str:
    # Single instance per database, not per machine: separate XDG profiles can
    # coexist. Never put note text or a private path into the D-Bus name.
    digest = hashlib.sha256(os.fsencode(paths.database.resolve())).hexdigest()[:32]
    return f"io.github.kvidzibo.pinote.g{digest}"
