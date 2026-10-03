"""Transactional note state and append-only event history."""

from __future__ import annotations

import json
import sqlite3
import string
import unicodedata
from dataclasses import dataclass, field
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
    remind_at: str | None = None
    reminder_due_at: str | None = None  # Delivered reminder's due time, derived from history.
    archived_at: str | None = None  # Completion/deletion time, independent of later tag edits.
    agent_notes: dict[str, str] = field(default_factory=dict)
    agent_event_id: int = 0

    @property
    def markdown(self) -> str:
        """Task text plus separately stored, user-defined agent fields."""
        if not self.agent_notes:
            return self.text
        fields = []
        for label, value in self.agent_notes.items():
            # Labels are literal; only values are Markdown.
            label = "".join("\\" + char if char in string.punctuation else char for char in label)
            fields.append(f"{label}: {value}")
        return self.text + "\n\n# Agent\n" + "\n\n".join(fields)


def note_from_row(row: sqlite3.Row) -> Note:
    values = dict(row)
    values["agent_notes"] = json.loads(values["agent_notes"])
    return Note(**values)


def agent_label(value: str) -> str:
    if not isinstance(value, str):
        raise NoteError("Agent field labels must be strings.")
    label = validate_tag(value)
    if label is None:
        raise NoteError("Agent field labels cannot be empty.")
    return label


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


MIGRATION_4 = (
    """CREATE TABLE notes_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
            state IN ('active', 'in_progress', 'done', 'removed', 'scheduled')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tag TEXT,
        remind_at TEXT,
        CHECK ((state = 'scheduled') = (remind_at IS NOT NULL))
    )""",
    """CREATE TABLE events_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES notes_v4(id),
        action TEXT NOT NULL CHECK (
            action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import',
                       'edit', 'tag', 'schedule', 'remind')
        ),
        previous_state TEXT,
        state TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        text TEXT NOT NULL,
        previous_text TEXT,
        tag TEXT,
        previous_tag TEXT,
        remind_at TEXT,
        previous_remind_at TEXT
    )""",
    "INSERT INTO notes_v4 SELECT *, NULL FROM notes",
    "INSERT INTO events_v4 SELECT *, NULL, NULL FROM events",
    "UPDATE sqlite_sequence SET seq = MAX(seq, "
    "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'notes'), 0)) "
    "WHERE name = 'notes_v4'",
    "UPDATE sqlite_sequence SET seq = MAX(seq, "
    "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) "
    "WHERE name = 'events_v4'",
    "DROP TABLE events",
    "DROP TABLE notes",
    "ALTER TABLE notes_v4 RENAME TO notes",
    "ALTER TABLE events_v4 RENAME TO events",
    "CREATE INDEX scheduled_times ON notes(remind_at) WHERE state = 'scheduled'",
)

MIGRATION_5 = (
    "CREATE TABLE tags (name TEXT PRIMARY KEY NOT NULL)",
    "INSERT OR IGNORE INTO tags(name) SELECT DISTINCT tag FROM notes WHERE tag IS NOT NULL",
)


MIGRATION_6 = (
    "ALTER TABLE notes ADD COLUMN agent_notes TEXT NOT NULL DEFAULT '{}'",
    """CREATE TABLE events_v6 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES notes(id),
        action TEXT NOT NULL CHECK (
            action IN ('add', 'start', 'reset', 'done', 'rm', 'restore', 'import',
                       'edit', 'tag', 'schedule', 'remind', 'agent')
        ),
        previous_state TEXT,
        state TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        text TEXT NOT NULL,
        previous_text TEXT,
        tag TEXT,
        previous_tag TEXT,
        remind_at TEXT,
        previous_remind_at TEXT,
        agent_notes TEXT NOT NULL DEFAULT '{}',
        previous_agent_notes TEXT NOT NULL DEFAULT '{}'
    )""",
    "INSERT INTO events_v6 SELECT *, '{}', '{}' FROM events",
    "UPDATE sqlite_sequence SET seq = MAX(seq, "
    "COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)) "
    "WHERE name = 'events_v6'",
    "DROP TABLE events",
    "ALTER TABLE events_v6 RENAME TO events",
    "CREATE TABLE agent_selections (cwd TEXT PRIMARY KEY, "
    "note_id INTEGER NOT NULL REFERENCES notes(id))",
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
        if version == 6:
            return  # Ordinary reads must not take a write lock.
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            # Another process may have upgraded while this connection waited.
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 6:
                return
            if version not in (0, 1, 2, 3, 4, 5):
                raise NoteError(f"Unsupported database version {version}; update pinote.")
            if version == 0:
                for statement in SCHEMA:
                    self.connection.execute(statement)
            elif version == 1:
                for statement in MIGRATION_2:
                    self.connection.execute(statement)
            if version < 3:
                for statement in MIGRATION_3:
                    self.connection.execute(statement)
            if version < 4:
                for statement in MIGRATION_4:
                    self.connection.execute(statement)
            if version < 5:
                for statement in MIGRATION_5:
                    self.connection.execute(statement)
            for statement in MIGRATION_6:
                self.connection.execute(statement)
            self.connection.execute("PRAGMA user_version = 6")

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
            if tag is not None:
                self.connection.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
            return self._insert(text, "active", "add", timestamp(), tag)

    def add_note(self, text: str, *, tag: str | None = None, cwd: Path | None = None) -> Note:
        """Add a note and, when cwd is set, start and select it in one transaction."""
        text = validate_text(text)
        tag = validate_tag(tag)
        if cwd is not None and not cwd.is_absolute():
            raise NoteError("--cwd must be an absolute project directory.")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if tag is not None:
                self.connection.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
            note_id = self._insert(text, "active", "add", timestamp(), tag)
            if cwd is not None:
                self._change_state(note_id, "start", "active", "in_progress")
                self.connection.execute(
                    "INSERT INTO agent_selections(cwd, note_id) VALUES (?, ?) "
                    "ON CONFLICT(cwd) DO UPDATE SET note_id = excluded.note_id",
                    (str(cwd.resolve()), note_id),
                )
            return self.get(note_id)

    def tags(self) -> list[str]:
        rows = self.connection.execute("SELECT name FROM tags")
        return sorted((r[0] for r in rows), key=lambda x: (x.casefold(), x))

    def create_tag(self, name: str) -> str:
        tag = validate_tag(name)
        if tag is None:
            raise NoteError("Tag name cannot be empty.")
        with self.connection:
            self.connection.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
        return tag

    def rename_tag(self, old: str, new: str) -> bool:
        old_tag, new_tag = validate_tag(old), validate_tag(new)
        if old_tag is None or new_tag is None:
            raise NoteError("Tag name cannot be empty.")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if not self.connection.execute(
                "SELECT 1 FROM tags WHERE name=?", (old_tag,)
            ).fetchone():
                raise NoteError("This tag no longer exists. Reopen Tags and try again.")
            if old_tag == new_tag:
                return False
            if self.connection.execute("SELECT 1 FROM tags WHERE name=?", (new_tag,)).fetchone():
                raise NoteError("A tag with that name already exists. Choose another name.")
            self.connection.execute("INSERT INTO tags(name) VALUES (?)", (new_tag,))
            self._retag_all(old_tag, new_tag)
            self.connection.execute("DELETE FROM tags WHERE name=?", (old_tag,))
        return True

    def delete_tag(self, name: str) -> bool:
        tag = validate_tag(name)
        if tag is None:
            raise NoteError("Tag name cannot be empty.")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if not self.connection.execute("SELECT 1 FROM tags WHERE name=?", (tag,)).fetchone():
                raise NoteError("This tag no longer exists. Reopen Tags and try again.")
            self._retag_all(tag, None)
            self.connection.execute("DELETE FROM tags WHERE name=?", (tag,))
        return True

    def _retag_all(self, old: str, new: str | None) -> None:
        rows = self.connection.execute("SELECT * FROM notes WHERE tag=?", (old,)).fetchall()
        for row in rows:
            when = timestamp()
            self.connection.execute(
                "UPDATE notes SET tag=?, updated_at=? WHERE id=?", (new, when, row["id"])
            )
            self.connection.execute(
                "INSERT INTO events(note_id, action, previous_state, state, occurred_at, text, "
                "previous_text, tag, previous_tag, remind_at, previous_remind_at, "
                "agent_notes, previous_agent_notes) "
                "VALUES (?, 'tag', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["id"],
                    row["state"],
                    row["state"],
                    when,
                    row["text"],
                    row["text"],
                    new,
                    old,
                    row["remind_at"],
                    row["remind_at"],
                    row["agent_notes"],
                    row["agent_notes"],
                ),
            )

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
            if action == "tag" and new_tag is not None:
                self.connection.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (new_tag,))
            if new_text == row["text"] and new_tag == row["tag"]:
                return False
            when = timestamp()
            self.connection.execute(
                "UPDATE notes SET text = ?, tag = ?, updated_at = ? WHERE id = ?",
                (new_text, new_tag, when, note_id),
            )
            self.connection.execute(
                "INSERT INTO events(note_id, action, previous_state, state, occurred_at, "
                "text, previous_text, tag, previous_tag, agent_notes, previous_agent_notes) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    row["agent_notes"],
                    row["agent_notes"],
                ),
            )
        return True

    def _change_state(
        self, note_id: int, action: str, previous: str, target: str, *, remind_at: str | None = None
    ) -> None:
        """Append a transition inside the caller's write transaction."""
        when = timestamp()
        row = self.connection.execute(
            "SELECT text, tag, remind_at, agent_notes FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        self.connection.execute(
            "UPDATE notes SET state = ?, updated_at = ?, remind_at = ? WHERE id = ?",
            (target, when, remind_at, note_id),
        )
        self.connection.execute(
            "INSERT INTO events(note_id, action, previous_state, state, occurred_at, text, tag, "
            "remind_at, previous_remind_at, agent_notes, previous_agent_notes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                note_id,
                action,
                previous,
                target,
                when,
                row["text"],
                row["tag"],
                remind_at,
                row["remind_at"],
                row["agent_notes"],
                row["agent_notes"],
            ),
        )
        if target not in {"active", "in_progress"}:
            self.connection.execute("DELETE FROM agent_selections WHERE note_id = ?", (note_id,))

    def schedule(
        self, note_id: int, when: datetime, *, expected_updated_at: str | None = None
    ) -> bool:
        if when.tzinfo is None or when.utcoffset() is None:
            raise NoteError("Reminder time must include a timezone.")
        due = when.astimezone(UTC).isoformat(timespec="microseconds")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if due <= timestamp():
                raise NoteError("Choose a reminder time in the future.")
            row = self.connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if row is None:
                raise NoteError(f"No note with ID {note_id}.")
            if expected_updated_at is not None and row["updated_at"] != expected_updated_at:
                raise NoteError("This task changed elsewhere. Close and reopen Set reminder.")
            if row["state"] not in {"active", "in_progress", "scheduled"}:
                raise NoteError(f"Note {note_id} is {row['state']}; restore it first.")
            if row["remind_at"] == due:
                return False
            self._change_state(note_id, "schedule", row["state"], "scheduled", remind_at=due)
        return True

    def scheduled_notes(self) -> list[Note]:
        return [
            note_from_row(row)
            for row in self.connection.execute(
                "SELECT * FROM notes WHERE state = 'scheduled' ORDER BY remind_at, id"
            )
        ]

    def has_due(self) -> bool:
        return (
            self.connection.execute(
                "SELECT 1 FROM notes WHERE state = 'scheduled' AND remind_at <= ? LIMIT 1",
                (timestamp(),),
            ).fetchone()
            is not None
        )

    def activate_due(self) -> int:
        # Ordinary polls stay read-only; recheck under the write transaction so
        # concurrent frontends cannot fire twice or undo a reschedule/removal.
        if not self.has_due():
            return 0
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            rows = self.connection.execute(
                "SELECT id FROM notes WHERE state = 'scheduled' AND remind_at <= ? "
                "ORDER BY remind_at, id",
                (timestamp(),),
            ).fetchall()
            for row in rows:
                self._change_state(row["id"], "remind", "scheduled", "active")
        return len(rows)

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
            if action in {"start", "reset"} and previous in {"done", "removed", "scheduled"}:
                raise NoteError(f"Note {note_id} is {previous}; restore it first.")
            if action == "done" and previous in {"removed", "scheduled"}:
                raise NoteError(f"Note {note_id} is {previous}; restore it first.")
            self._change_state(note_id, action, previous, target)
        return True

    def archived_notes(self) -> list[Note]:
        return [
            note_from_row(row)
            for row in self.connection.execute(
                "WITH archived_events AS ("
                " SELECT note_id, MAX(id) AS event_id FROM events"
                " WHERE action IN ('done', 'rm', 'import') AND state IN ('done', 'removed')"
                " GROUP BY note_id"
                ") SELECT notes.*, COALESCE(events.occurred_at, notes.updated_at) AS archived_at"
                " FROM notes LEFT JOIN archived_events ON archived_events.note_id = notes.id"
                " LEFT JOIN events ON events.id = archived_events.event_id"
                " WHERE notes.state IN ('done', 'removed')"
                " ORDER BY archived_at DESC, notes.id DESC"
            )
        ]

    def notes(self, *, all_states: bool = False) -> list[Note]:
        # Keep a delivered reminder marked through progress/edits, but not after
        # archiving or scheduling it again. History also covers existing reminders
        # and restarts without a schema upgrade. Group once, not once per note.
        query = """
            WITH latest_reminder_event AS (
                SELECT note_id, MAX(id) AS event_id FROM events
                WHERE action IN ('schedule', 'remind', 'done', 'rm')
                GROUP BY note_id
            )
            , latest_agent_event AS (
                SELECT note_id, MAX(id) AS agent_event_id FROM events
                WHERE action = 'agent' GROUP BY note_id
            )
            SELECT notes.*, COALESCE(agent_events.agent_event_id, 0) AS agent_event_id,
                CASE WHEN events.action = 'remind'
                    THEN events.previous_remind_at END AS reminder_due_at
            FROM notes
            LEFT JOIN latest_agent_event AS agent_events ON agent_events.note_id = notes.id
            LEFT JOIN latest_reminder_event ON latest_reminder_event.note_id = notes.id
            LEFT JOIN events ON events.id = latest_reminder_event.event_id
        """
        if not all_states:
            query += " WHERE notes.state IN ('active', 'in_progress')"
        return [note_from_row(row) for row in self.connection.execute(query + " ORDER BY notes.id")]

    def get(self, note_id: int) -> Note:
        row = self.connection.execute(
            "SELECT notes.*, COALESCE((SELECT MAX(id) FROM events "
            "WHERE note_id = notes.id AND action = 'agent'), 0) AS agent_event_id "
            "FROM notes WHERE id = ?",
            (note_id,),
        ).fetchone()
        if row is None:
            raise NoteError(f"No note with ID {note_id}.")
        return note_from_row(row)

    def selected(self, cwd: Path) -> Note | None:
        row = self.connection.execute(
            "SELECT notes.* FROM agent_selections JOIN notes ON notes.id = note_id "
            "WHERE cwd = ? AND state IN ('active', 'in_progress')",
            (str(cwd.resolve()),),
        ).fetchone()
        return note_from_row(row) if row else None

    def select(self, note_id: int, cwd: Path) -> Note:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            note = self.get(note_id)
            if note.state not in {"active", "in_progress"}:
                raise NoteError(f"Note {note_id} is {note.state}; restore it first.")
            if note.state == "active":
                self._change_state(note_id, "start", note.state, "in_progress")
            self.connection.execute(
                "INSERT INTO agent_selections(cwd, note_id) VALUES (?, ?) "
                "ON CONFLICT(cwd) DO UPDATE SET note_id = excluded.note_id",
                (str(cwd.resolve()), note_id),
            )
            return self.get(note_id)

    def update_agent(
        self,
        note_id: int,
        fields: dict[str, str],
        remove: list[str],
        *,
        expected_updated_at: str,
    ) -> Note:
        if not isinstance(fields, dict):
            raise NoteError("Agent fields must be a JSON object of label: Markdown string pairs.")
        patch = {}
        for key, value in fields.items():
            label = agent_label(key)
            if label in patch:
                raise NoteError("Agent field labels must be unique after normalization.")
            if not isinstance(value, str):
                raise NoteError("Agent field values must be Markdown strings.")
            validate_text(value)  # Validate without stripping Markdown-significant indentation.
            value = value.replace("\r\n", "\n")
            if len(value) > 4096:
                raise NoteError("Agent field values cannot exceed 4096 characters.")
            patch[label] = value
        deleted = {agent_label(label) for label in remove}
        if deleted.intersection(patch):
            raise NoteError("Cannot set and remove the same agent field in one update.")
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            note = self.get(note_id)
            if (
                note.state not in {"active", "in_progress"}
                or note.updated_at != expected_updated_at
            ):
                raise NoteError("This task changed elsewhere. Read it again before updating.")
            updated = {key: value for key, value in note.agent_notes.items() if key not in deleted}
            updated.update(patch)
            encoded = json.dumps(updated, ensure_ascii=False, sort_keys=True)
            if len(updated) > 64 or len(encoded.encode("utf-8")) > 32768:
                raise NoteError("Agent notes cannot exceed 64 fields or 32 KiB of JSON.")
            if updated == note.agent_notes:
                return note
            previous = json.dumps(note.agent_notes, ensure_ascii=False, sort_keys=True)
            when = timestamp()
            self.connection.execute(
                "UPDATE notes SET agent_notes = ?, updated_at = ? WHERE id = ?",
                (encoded, when, note_id),
            )
            self.connection.execute(
                "INSERT INTO events(note_id, action, previous_state, state, occurred_at, "
                "text, previous_text, tag, previous_tag, agent_notes, previous_agent_notes) "
                "VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    note_id,
                    note.state,
                    note.state,
                    when,
                    note.text,
                    note.text,
                    note.tag,
                    note.tag,
                    encoded,
                    previous,
                ),
            )
            return self.get(note_id)

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
