from __future__ import annotations

import os
import sqlite3

import pytest

from pinote.store import NoteError, Store, validate_text


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "data/notes.db") as result:
        yield result


def test_lifecycle_preserves_ids_and_history(store):
    one = store.add("first")
    two = store.add("second")
    assert (one, two) == (1, 2)
    assert store.transition(one, "done")
    assert [n.id for n in store.notes()] == [2]
    assert store.transition(two, "rm")
    assert store.notes() == []
    assert store.add("third") == 3
    assert store.transition(two, "restore")
    assert [n.id for n in store.notes()] == [2, 3]
    events = store.history(two)
    assert [e["action"] for e in events] == ["add", "rm", "restore"]
    assert [e["previous_state"] for e in events] == [None, "active", "removed"]
    assert all(e["occurred_at"].endswith("+00:00") for e in events)
    assert [n.state for n in store.notes(all_states=True)] == ["done", "active", "active"]


def test_noop_does_not_append_history(store):
    note_id = store.add("stay")
    assert not store.transition(note_id, "restore")
    assert store.transition(note_id, "done")
    assert not store.transition(note_id, "done")
    assert len(store.history()) == 2
    assert store.transition(note_id, "rm")
    assert not store.transition(note_id, "rm")
    with pytest.raises(NoteError, match="restore it first"):
        store.transition(note_id, "done")
    assert len(store.history()) == 3


def test_missing_id(store):
    for action in ("done", "rm", "restore"):
        with pytest.raises(NoteError, match="No note with ID 42"):
            store.transition(42, action)
    with pytest.raises(NoteError, match="No note"):
        store.history(42)
    assert store.history() == []


@pytest.mark.parametrize("text", ["", "   ", "x" * 4097, "a\x00b", "a\x1b[31mb", "a\ud800b"])
def test_bad_text_has_no_side_effects(store, text):
    with pytest.raises(NoteError):
        store.add(text)
    assert store.notes() == []
    assert store.history() == []


def test_parameterized_sql_and_unicode(store):
    text = "O'Brien'); DROP TABLE notes; -- <&> 🐦\nsecond\tline"
    note_id = store.add(text)
    assert store.notes()[0].text == text
    assert store.history(note_id)[0]["text"] == text
    assert validate_text("  windows\r\nline  ") == "windows\nline"


def test_transaction_rolls_back_both_state_and_history(store):
    note_id = store.add("atomic")
    store.connection.execute(
        "CREATE TRIGGER fail_event BEFORE INSERT ON events "
        "BEGIN SELECT RAISE(ABORT, 'failed event'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="failed event"):
        store.transition(note_id, "done")
    assert store.notes()[0].state == "active"
    with pytest.raises(sqlite3.IntegrityError):
        store.add("also atomic")
    assert len(store.notes()) == len(store.history()) == 1


def test_import_is_atomic_idempotent_and_keeps_done(store):
    source = "/original/REMINDER.md"
    entries = [("active", "active"), ("finished", "done")]
    assert store.import_notes(source, entries) == 2
    assert store.import_notes(source, [("new contents", "active")]) is None
    assert len(store.notes(all_states=True)) == 2
    assert [e["action"] for e in store.history()] == ["import", "import"]
    assert [e["state"] for e in store.history()] == ["active", "done"]
    with pytest.raises(NoteError):
        store.import_notes("/another", [("valid", "active"), ("", "active")])
    assert len(store.notes(all_states=True)) == 2
    assert store.import_notes("/empty", []) == 0
    assert store.import_notes("/empty", [("now has content", "active")]) == 1


def test_import_rollback_on_event_failure(store):
    store.connection.execute(
        "CREATE TRIGGER fail_second BEFORE INSERT ON events "
        "WHEN NEW.note_id = 2 BEGIN SELECT RAISE(ABORT, 'failed event'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        store.import_notes("/source", [("one", "active"), ("two", "done")])
    assert not store.notes(all_states=True)
    assert not store.history()
    assert not store.connection.execute("SELECT * FROM imports").fetchall()


def test_persistence_and_newer_schema_rejected(tmp_path):
    path = tmp_path / "notes.db"
    with Store(path) as store:
        store.add("persistent")
    with Store(path) as store:
        assert store.notes()[0].text == "persistent"
        store.connection.execute("PRAGMA user_version = 99")
    with pytest.raises(NoteError, match="Unsupported database version 99"):
        Store(path)
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 99
        assert db.execute("SELECT text FROM notes").fetchone()[0] == "persistent"


def test_new_database_is_private(tmp_path):
    previous = os.umask(0)
    try:
        path = tmp_path / "private/notes.db"
        with Store(path):
            pass
        assert path.stat().st_mode & 0o777 == 0o600
        assert path.parent.stat().st_mode & 0o777 == 0o700
    finally:
        os.umask(previous)
