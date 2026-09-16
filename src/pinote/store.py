"""Transactional note state and append-only event history."""

from __future__ import annotations

import sqlite3
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pinote.paths import private_directory, private_file


class NoteError(ValueError):
    """A user-facing validation or state transition error."""


def timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def validate_text(text: str) -> str:
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise NoteError("Note text cannot be empty.")
    if len(text) > 4096:
        raise NoteError("Note text cannot exceed 4096 characters.")
    if any(unicodedata.category(c) in {"Cc", "Cs"} and c not in "\n\t" for c in text):
        raise NoteError("Note text contains unsupported control characters.")
    return text


@dataclass(frozen=True)
class Note:
    id: int
    text: str
    state: str
    created_at: str
    updated_at: str


SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'done', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    action TEXT NOT NULL CHECK (action IN ('add', 'done', 'rm', 'restore', 'import')),
    previous_state TEXT,
    state TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
    source TEXT PRIMARY KEY,
    imported_at TEXT NOT NULL,
    note_count INTEGER NOT NULL
);
PRAGMA user_version = 1;
COMMIT;
"""


class Store:
    def __init__(self, path: Path, *, timeout: float = 10):
        private_directory(path.parent)
        private_file(path)
        self.connection = sqlite3.connect(path, timeout=timeout)
        self.connection.row_factory = sqlite3.Row
        try:
            self.connection.execute("PRAGMA foreign_keys = ON")
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise NoteError(f"Unsupported database version {version}; update pinote.")
            if version == 0:
                self.connection.executescript(SCHEMA)
        except BaseException:
            self.connection.close()
            raise

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *args: object) -> None:
        self.connection.close()

    def _insert(self, text: str, state: str, action: str, when: str) -> int:
        cursor = self.connection.execute(
            "INSERT INTO notes(text, state, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (text, state, when, when),
        )
        note_id = cursor.lastrowid
        assert note_id is not None
        self.connection.execute(
            "INSERT INTO events(note_id, action, previous_state, state, occurred_at) "
            "VALUES (?, ?, NULL, ?, ?)",
            (note_id, action, state, when),
        )
        return note_id

    def add(self, text: str) -> int:
        text = validate_text(text)
        with self.connection:
            return self._insert(text, "active", "add", timestamp())

    def transition(self, note_id: int, action: str) -> bool:
        target = {"done": "done", "rm": "removed", "restore": "active"}[action]
        with self.connection:
            # Read and write under the same lock, even for non-CLI callers.
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute(
                "SELECT state FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
            if row is None:
                raise NoteError(f"No note with ID {note_id}.")
            previous = row["state"]
            if previous == target:
                return False
            if action == "done" and previous == "removed":
                raise NoteError(f"Note {note_id} is removed; restore it first.")
            when = timestamp()
            self.connection.execute(
                "UPDATE notes SET state = ?, updated_at = ? WHERE id = ?", (target, when, note_id)
            )
            self.connection.execute(
                "INSERT INTO events(note_id, action, previous_state, state, occurred_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (note_id, action, previous, target, when),
            )
        return True

    def notes(self, *, all_states: bool = False) -> list[Note]:
        query = "SELECT * FROM notes"
        if not all_states:
            query += " WHERE state = 'active'"
        return [Note(**dict(row)) for row in self.connection.execute(query + " ORDER BY id")]

    def history(self, note_id: int | None = None) -> list[sqlite3.Row]:
        if (
            note_id is not None
            and not self.connection.execute(
                "SELECT 1 FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
        ):
            raise NoteError(f"No note with ID {note_id}.")
        query = "SELECT events.*, notes.text FROM events JOIN notes ON notes.id = events.note_id"
        params: tuple[int, ...] = ()
        if note_id is not None:
            query += " WHERE note_id = ?"
            params = (note_id,)
        return list(self.connection.execute(query + " ORDER BY events.id", params))

    def import_notes(self, source: str, entries: list[tuple[str, str]]) -> int | None:
        """Import a canonical source path once; None means already imported."""
        clean = [(validate_text(text), state) for text, state in entries]
        if any(state not in {"active", "done"} for _, state in clean):
            raise NoteError("Imported notes must be active or done.")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if self.connection.execute(
                "SELECT 1 FROM imports WHERE source = ?", (source,)
            ).fetchone():
                return None
            if not clean:
                return 0
            when = timestamp()
            for text, state in clean:
                self._insert(text, state, "import", when)
            self.connection.execute(
                "INSERT INTO imports(source, imported_at, note_count) VALUES (?, ?, ?)",
                (source, when, len(clean)),
            )
        return len(clean)
