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


def validate_tag(tag: str | None) -> str | None:
    if tag is None:
        return None
    if any(unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in tag):
        raise NoteError("Tag names must be a single line without control characters.")
    tag = unicodedata.normalize("NFC", tag.strip())
    if len(tag) > 64:
        raise NoteError("Tag names cannot exceed 64 characters.")
    return tag or None


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
    tag: str | None = None


# Table names below are fixed internal identifiers, never user input.
NOTES_TABLE = """CREATE TABLE {name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'in_progress', 'done', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)"""
EVENTS_TABLE = """CREATE TABLE {name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES {notes}(id),
    action TEXT NOT NULL CHECK (
        action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import')
    ),
    previous_state TEXT,
    state TEXT NOT NULL,
    occurred_at TEXT NOT NULL
)"""
EVENTS_TABLE_V3 = """CREATE TABLE events_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    action TEXT NOT NULL CHECK (
        action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import', 'edit', 'tag')
    ),
    previous_state TEXT,
    state TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    text TEXT NOT NULL,
    previous_text TEXT,
    tag TEXT,
    previous_tag TEXT
)"""
# Start with the v2 base schema, then apply the same v3 migration on every path.
SCHEMA = (
    NOTES_TABLE.format(name="notes"),
    EVENTS_TABLE.format(name="events", notes="notes"),
    "CREATE TABLE imports (source TEXT PRIMARY KEY, imported_at TEXT NOT NULL, "
    "note_count INTEGER NOT NULL)",
)
MIGRATION_2 = (
    NOTES_TABLE.format(name="notes_v2"),
    EVENTS_TABLE.format(name="events_v2", notes="notes_v2"),
    "INSERT INTO notes_v2 SELECT * FROM notes",
    "INSERT INTO events_v2 SELECT * FROM events",
    "UPDATE sqlite_sequence SET seq = MAX(seq, "
    "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'notes'), 0)) "
    "WHERE name = 'notes_v2'",
    "UPDATE sqlite_sequence SET seq = MAX(seq, "
    "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) "
    "WHERE name = 'events_v2'",
    "DROP TABLE events",
    "DROP TABLE notes",
    "ALTER TABLE notes_v2 RENAME TO notes",
    "ALTER TABLE events_v2 RENAME TO events",
)
MIGRATION_3 = (
    "ALTER TABLE notes ADD COLUMN tag TEXT",
    EVENTS_TABLE_V3,
    # Rebuild the action CHECK as well as adding snapshots. Before v3, note text
    # was immutable, so it is also the correct text for every legacy event.
    "INSERT INTO events_v3(id, note_id, action, previous_state, state, occurred_at, text) "
    "SELECT e.id, e.note_id, e.action, e.previous_state, e.state, e.occurred_at, n.text "
    "FROM events e JOIN notes n ON n.id = e.note_id",
    "UPDATE sqlite_sequence SET seq = MAX(seq, "
    "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) "
    "WHERE name = 'events_v3'",
    "DROP TABLE events",
    "ALTER TABLE events_v3 RENAME TO events",
)


class Store:
    def __init__(self, path: Path, *, timeout: float = 10):
        private_directory(path.parent)
        private_file(path)
        self.connection = sqlite3.connect(path, timeout=timeout)
        self.connection.row_factory = sqlite3.Row
        try:
            self.connection.execute("PRAGMA foreign_keys = ON")
            self._initialize()
        except BaseException:
            self.connection.close()
            raise

    def _initialize(self) -> None:
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version == 3:
            return  # Ordinary reads must not take a write lock.
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            # Another process may have upgraded while this connection waited.
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 3:
                return
            if version not in (0, 1, 2):
                raise NoteError(f"Unsupported database version {version}; update pinote.")
            if version == 0:
                for statement in SCHEMA:
                    self.connection.execute(statement)
            elif version == 1:
                for statement in MIGRATION_2:
                    self.connection.execute(statement)
            for statement in MIGRATION_3:
                self.connection.execute(statement)
            self.connection.execute("PRAGMA user_version = 3")

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *args: object) -> None:
        self.connection.close()

    def _insert(self, text: str, state: str, action: str, when: str, tag: str | None = None) -> int:
        cursor = self.connection.execute(
            "INSERT INTO notes(text, state, created_at, updated_at, tag) VALUES (?, ?, ?, ?, ?)",
            (text, state, when, when, tag),
        )
        note_id = cursor.lastrowid
        assert note_id is not None
        self.connection.execute(
            "INSERT INTO events(note_id, action, previous_state, state, occurred_at, text, tag) "
            "VALUES (?, ?, NULL, ?, ?, ?, ?)",
            (note_id, action, state, when, text, tag),
        )
        return note_id

    def add(self, text: str, *, tag: str | None = None) -> int:
        text = validate_text(text)
        tag = validate_tag(tag)
        with self.connection:
            return self._insert(text, "active", "add", timestamp(), tag)

    def tags(self) -> list[str]:
        rows = self.connection.execute("SELECT DISTINCT tag FROM notes WHERE tag IS NOT NULL")
        return sorted((r[0] for r in rows), key=lambda x: (x.casefold(), x))

    def edit(self, note_id: int, text: str, *, expected_updated_at: str) -> bool:
        return self._update(note_id, "edit", validate_text(text), expected_updated_at)

    def set_tag(self, note_id: int, tag: str | None, *, expected_updated_at: str) -> bool:
        return self._update(note_id, "tag", validate_tag(tag), expected_updated_at)

    def _update(self, note_id: int, action: str, value: str | None, expected: str) -> bool:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if (
                row is None
                or row["state"] not in {"active", "in_progress"}
                or row["updated_at"] != expected
            ):
                raise NoteError(
                    "This task changed elsewhere. Close and reopen the editor or tag menu, "
                    "then try again."
                )
            new_text = value if action == "edit" else row["text"]
            new_tag = value if action == "tag" else row["tag"]
            if new_text == row["text"] and new_tag == row["tag"]:
                return False
            when = timestamp()
            self.connection.execute(
                "UPDATE notes SET text = ?, tag = ?, updated_at = ? WHERE id = ?",
                (new_text, new_tag, when, note_id),
            )
            self.connection.execute(
                "INSERT INTO events(note_id, action, previous_state, state, occurred_at, "
                "text, previous_text, tag, previous_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    note_id,
                    action,
                    row["state"],
                    row["state"],
                    when,
                    new_text,
                    row["text"],
                    new_tag,
                    row["tag"],
                ),
            )
        return True

    def _change_state(self, note_id: int, action: str, previous: str, target: str) -> None:
        """Append a transition inside the caller's write transaction."""
        when = timestamp()
        row = self.connection.execute(
            "SELECT text, tag FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        self.connection.execute(
            "UPDATE notes SET state = ?, updated_at = ? WHERE id = ?", (target, when, note_id)
        )
        self.connection.execute(
            "INSERT INTO events(note_id, action, previous_state, state, occurred_at, text, tag) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (note_id, action, previous, target, when, row["text"], row["tag"]),
        )

    def transition(
        self,
        note_id: int,
        action: str,
        *,
        expected_states: set[str] | None = None,
        expected_updated_at: str | None = None,
    ) -> bool:
        target = {
            "start": "in_progress",
            "reset": "active",
            "done": "done",
            "rm": "removed",
            "restore": "active",
        }[action]
        with self.connection:
            # Read and write under the same lock, even for non-CLI callers.
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute(
                "SELECT state, updated_at FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
            # GUI actions carry the state they were drawn for. Check it under
            # the same transaction as the write, not in a preceding snapshot.
            if expected_states is not None and (row is None or row["state"] not in expected_states):
                return False
            if row is None:
                raise NoteError(f"No note with ID {note_id}.")
            if expected_updated_at is not None and row["updated_at"] != expected_updated_at:
                return False  # The archive row was restored/changed since it was drawn.
            previous = row["state"]
            if previous == target:
                return False
            if action in {"start", "reset"} and previous in {"done", "removed"}:
                raise NoteError(f"Note {note_id} is {previous}; restore it first.")
            if action == "done" and previous == "removed":
                raise NoteError(f"Note {note_id} is removed; restore it first.")
            self._change_state(note_id, action, previous, target)
        return True

    def archived_notes(self) -> list[Note]:
        return [
            Note(**dict(row))
            for row in self.connection.execute(
                "SELECT * FROM notes WHERE state IN ('done', 'removed') "
                "ORDER BY updated_at DESC, id DESC"
            )
        ]

    def notes(self, *, all_states: bool = False) -> list[Note]:
        query = "SELECT * FROM notes"
        if not all_states:
            query += " WHERE state IN ('active', 'in_progress')"
        return [Note(**dict(row)) for row in self.connection.execute(query + " ORDER BY id")]

    def history(self, note_id: int | None = None) -> list[sqlite3.Row]:
        if (
            note_id is not None
            and not self.connection.execute(
                "SELECT 1 FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
        ):
            raise NoteError(f"No note with ID {note_id}.")
        query = "SELECT * FROM events"
        params: tuple[int, ...] = ()
        if note_id is not None:
            query += " WHERE note_id = ?"
            params = (note_id,)
        return list(self.connection.execute(query + " ORDER BY id", params))

    def import_notes(self, source: str, entries: list[tuple[str, str]]) -> int | None:
        """Import a canonical source path once; None means already imported."""
        clean = [(validate_text(text), state) for text, state in entries]
        if any(state not in {"active", "in_progress", "done"} for _, state in clean):
            raise NoteError("Imported notes must be active, in progress, or done.")
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
