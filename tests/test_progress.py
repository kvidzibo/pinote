"""Progress state, atomic v1 upgrades, and compatibility across frontends."""

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from pinote import markdown, notify
from pinote.gui.model import ReminderModel
from pinote.paths import Paths
from pinote.store import NoteError, Store

LEGACY_SCHEMA = """
CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'done', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    action TEXT NOT NULL CHECK (action IN ('add', 'done', 'rm', 'restore', 'import')),
    previous_state TEXT,
    state TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);
CREATE TABLE imports (
    source TEXT PRIMARY KEY, imported_at TEXT NOT NULL, note_count INTEGER NOT NULL
);
PRAGMA user_version = 1;
"""


@pytest.fixture
def legacy(tmp_path):
    path = tmp_path / "notes.db"
    with sqlite3.connect(path) as db:
        db.executescript(LEGACY_SCHEMA)
        for note_id, state in ((1, "active"), (2, "done"), (3, "removed")):
            db.execute(
                "INSERT INTO notes VALUES (?, ?, ?, 'created', 'updated')",
                (note_id, f"Legacy {note_id}", state),
            )
            db.execute(
                "INSERT INTO events VALUES (?, ?, 'import', NULL, ?, 'created')",
                (note_id, note_id, state),
            )
        db.execute("INSERT INTO imports VALUES ('/original.md', 'created', 3)")
        # Preserve AUTOINCREMENT high-water marks, not just surviving row IDs.
        db.execute("UPDATE sqlite_sequence SET seq = 40 WHERE name = 'notes'")
        db.execute("UPDATE sqlite_sequence SET seq = 80 WHERE name = 'events'")
    return path


def test_progress_persists_and_transitions_preserve_history(tmp_path):
    path = tmp_path / "notes.db"
    with Store(path) as store:
        note_id = store.add("Keep working")
        assert store.transition(note_id, "start")
        assert not store.transition(note_id, "start")
        assert store.notes()[0].state == "in_progress"
    with Store(path) as store:
        assert store.notes()[0].state == "in_progress"
        assert store.transition(note_id, "reset")
        assert not store.transition(note_id, "reset")
        assert store.notes()[0].state == "active"
        assert store.transition(note_id, "start")
        assert store.transition(note_id, "done")
        assert not store.notes()
        assert store.transition(note_id, "restore")
        assert store.notes()[0].state == "active"
        assert [e["action"] for e in store.history()] == [
            "add",
            "start",
            "reset",
            "start",
            "done",
            "restore",
        ]
        assert [e["previous_state"] for e in store.history()] == [
            None,
            "active",
            "in_progress",
            "active",
            "in_progress",
            "done",
        ]


@pytest.mark.parametrize("action", ["start", "reset"])
@pytest.mark.parametrize("closed_state", ["done", "rm"])
def test_progress_cannot_restore_finished_or_removed_notes(tmp_path, action, closed_state):
    with Store(tmp_path / "notes.db") as store:
        note_id = store.add("Finished")
        store.transition(note_id, closed_state)
        with pytest.raises(NoteError, match="restore it first"):
            store.transition(note_id, action)
        assert len(store.history()) == 2


def test_progress_and_history_roll_back_together(tmp_path):
    with Store(tmp_path / "notes.db") as store:
        note_id = store.add("Atomic progress")
        store.connection.execute(
            "CREATE TRIGGER fail_event BEFORE INSERT ON events "
            "BEGIN SELECT RAISE(ABORT, 'failed event'); END"
        )
        with pytest.raises(sqlite3.IntegrityError):
            store.transition(note_id, "start")
        assert store.notes()[0].state == "active"
        assert len(store.history()) == 1


def test_v1_upgrade_preserves_all_data_ids_and_import_markers(legacy):
    with sqlite3.connect(legacy) as db:
        before = {
            table: db.execute(f"SELECT * FROM {table}").fetchall()
            for table in ("notes", "events", "imports")
        }
    with Store(legacy) as store:
        assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 4
        columns = {
            "notes": "id, text, state, created_at, updated_at",
            "events": "id, note_id, action, previous_state, state, occurred_at",
            "imports": "source, imported_at, note_count",
        }
        for table, rows in before.items():
            actual = [
                tuple(row)
                for row in store.connection.execute(f"SELECT {columns[table]} FROM {table}")
            ]
            assert actual == rows
        assert store.connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert store.connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert store.import_notes("/original.md", [("Duplicate", "active")]) is None
        assert store.transition(1, "start")
        assert store.history(1)[-1]["id"] == 81
        assert store.add("Next ID") == 41
    with Store(legacy) as store:
        assert store.notes()[0].state == "in_progress"
        assert store.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_empty_v1_upgrade_keeps_deleted_id_high_water_marks(legacy):
    with sqlite3.connect(legacy) as db:
        db.execute("DELETE FROM events")
        db.execute("DELETE FROM notes")
    with Store(legacy) as store:
        assert store.add("Do not reuse a deleted ID") == 41
        assert store.history()[0]["id"] == 81


def test_concurrent_v1_openers_upgrade_once_without_losing_changes(legacy):
    def add(index):
        with Store(legacy) as store:
            return store.add(f"Concurrent {index}")

    with ThreadPoolExecutor(max_workers=6) as pool:
        ids = list(pool.map(add, range(12)))
    assert sorted(ids) == list(range(41, 53))
    with Store(legacy) as store:
        assert len(store.notes(all_states=True)) == len(store.history()) == 15
        assert store.connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_failed_v1_migration_rolls_back(legacy, monkeypatch):
    connect = sqlite3.connect

    def fail_alter(*args, **kwargs):
        db = connect(*args, **kwargs)
        db.set_authorizer(
            lambda operation, *_: (
                sqlite3.SQLITE_DENY
                if operation == sqlite3.SQLITE_ALTER_TABLE
                else sqlite3.SQLITE_OK
            )
        )
        return db

    monkeypatch.setattr(sqlite3, "connect", fail_alter)
    with pytest.raises(sqlite3.DatabaseError):
        Store(legacy)
    with connect(legacy) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM notes").fetchone()[0] == 3
        assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 3
        assert db.execute("SELECT seq FROM sqlite_sequence WHERE name='notes'").fetchone()[0] == 40
        assert not db.execute("SELECT name FROM sqlite_master WHERE name LIKE '%_v2'").fetchall()


def test_gui_stale_progress_actions_never_complete_or_restore_wrong_state(tmp_path):
    model = ReminderModel(Paths(tmp_path / "data", tmp_path / "state"))
    note_id = model.add("State-aware click")
    assert not model.transition(note_id, "done").changed
    assert not model.transition(note_id, "reset").changed
    assert model.transition(note_id, "start").changed
    assert not model.transition(note_id, "start").changed
    assert model.transition(note_id, "reset").changed
    assert not model.transition(note_id, "done").changed
    assert model.transition(note_id, "start").changed
    assert model.transition(note_id, "done").changed
    for action in ("start", "reset", "done", "rm"):
        assert not model.transition(note_id, action).changed
        assert not model.transition(note_id + 100, action).changed
    with Store(model.paths.database) as store:
        assert [e["action"] for e in store.history()] == ["add", "start", "reset", "start", "done"]


def test_cli_lists_completes_and_restores_progress(cli):
    cli("--no-notify", "From the GUI")
    with Store(cli.database) as store:
        store.transition(1, "start")
    assert "1. [in progress] From the GUI" in cli().stdout
    assert "in_progress" in cli("history", "1").stdout
    assert cli("export").stdout == "# Reminders\n\n- [~] From the GUI\n"
    cli("restore", "1", "--no-notify")
    assert cli().stdout == "1. From the GUI\n"
    with Store(cli.database) as store:
        store.transition(1, "start")
    cli("done", "1", "--no-notify")
    assert "No active notes" in cli().stdout


def test_progress_markdown_round_trip_and_notification(tmp_path):
    with Store(tmp_path / "notes.db") as store:
        store.import_notes("/source", [("A 🐦 <task>\nNext line", "in_progress")])
        notes = store.notes()
        assert markdown.parse(markdown.export(notes)) == [(notes[0].text, "in_progress")]
        body = notify.render(notes)
        assert "[in progress]" in body and "&lt;task&gt;" in body
