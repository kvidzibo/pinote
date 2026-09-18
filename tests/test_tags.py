"""Editing/tagging must preserve revisions, snapshots, and legacy databases."""

import sqlite3

import pytest
from test_progress import LEGACY_SCHEMA

from pinote.gui.model import ReminderModel
from pinote.paths import Paths, display_lock
from pinote.store import NoteError, Store


@pytest.mark.parametrize("version", [1, 2])
def test_legacy_upgrade_allows_edits_and_tags_without_losing_history(tmp_path, version):
    path = tmp_path / "notes.db"
    schema = LEGACY_SCHEMA
    if version == 2:
        schema = schema.replace("'active', 'done'", "'active', 'in_progress', 'done'")
        schema = schema.replace("'add', 'done'", "'add', 'start', 'reset', 'done'")
        schema = schema.replace("user_version = 1", "user_version = 2")
    with sqlite3.connect(path) as db:
        db.executescript(schema)
        db.execute("INSERT INTO notes VALUES (7, 'Original', 'active', 'created', 'updated')")
        db.execute("INSERT INTO events VALUES (9, 7, 'add', NULL, 'active', 'created')")
        db.execute("INSERT INTO imports VALUES ('/old.md', 'created', 1)")
        db.execute("UPDATE sqlite_sequence SET seq = 40 WHERE name = 'notes'")
        db.execute("UPDATE sqlite_sequence SET seq = 80 WHERE name = 'events'")
    with Store(path) as store:
        assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 4
        original = store.notes()[0]
        assert original.tag is None
        assert store.edit(7, "Edited\nDetails", expected_updated_at=original.updated_at)
        edited = store.notes()[0]
        assert store.set_tag(7, "Work", expected_updated_at=edited.updated_at)
        assert store.notes()[0].created_at == "created"
        assert [(e["id"], e["text"], e["tag"]) for e in store.history()] == [
            (9, "Original", None),
            (81, "Edited\nDetails", None),
            (82, "Edited\nDetails", "Work"),
        ]
        assert store.add("Next") == 41
        assert store.import_notes("/old.md", [("Duplicate", "active")]) is None
        assert store.connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert store.connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_edit_tag_lifecycle_uses_lock_revision_and_atomic_snapshots(tmp_path, monkeypatch):
    model = ReminderModel(Paths(tmp_path / "data", tmp_path / "state"))
    note_id = model.add("Original", tag="Work")
    model.transition(note_id, "start")
    original = model.notes()[0]
    with display_lock(model.paths), pytest.raises(BlockingIOError):
        model.edit(original, "Blocked")
    with display_lock(model.paths), pytest.raises(BlockingIOError):
        model.set_tag(original, "Blocked")
    assert model.edit(original, "  <b>Edited 🐦</b>\nDetails  ")
    edited = model.notes()[0]
    assert edited.state == "in_progress" and edited.created_at == original.created_at
    assert not model.edit(edited, edited.text)
    assert model.set_tag(edited, "  Cafe\u0301  ")
    tagged = model.notes()[0]
    assert tagged.tag == "Café" and model.tags() == ["Café"]
    assert not model.set_tag(tagged, "Café")
    for change in (lambda: model.edit(original, "Overwrite"), lambda: model.set_tag(edited, None)):
        with pytest.raises(NoteError, match="changed"):
            change()
    with Store(model.paths.database) as store:
        store.connection.execute(
            "CREATE TRIGGER fail_edit BEFORE INSERT ON events "
            "BEGIN SELECT RAISE(ABORT, 'failed event'); END"
        )
        with pytest.raises(sqlite3.IntegrityError):
            model.set_tag(tagged, None)
        assert store.notes() == [tagged]
        store.connection.execute("DROP TRIGGER fail_edit")
    model.transition(note_id, "done")
    archived = model.archive()[0]
    for change in (lambda: model.edit(archived, "Archived"), lambda: model.set_tag(archived, None)):
        with pytest.raises(NoteError, match="changed"):
            change()
    assert model.tags() == ["Café"]  # Archived tags can be reused.
    assert model.restore(archived)
    restored = model.notes()[0]
    assert restored.tag == "Café"

    def failed_read(*_args, **_kwargs):
        raise AssertionError("A committed save must not read another snapshot")

    with monkeypatch.context() as patch:
        patch.setattr(Store, "notes", failed_read)
        assert model.set_tag(restored, "  ")
    with Store(model.paths.database) as store:
        events = store.history()
        assert [e["action"] for e in events] == [
            "add",
            "start",
            "edit",
            "tag",
            "done",
            "restore",
            "tag",
        ]
        assert (events[0]["text"], events[0]["tag"]) == ("Original", "Work")
        assert (events[2]["previous_text"], events[2]["text"]) == ("Original", edited.text)
        assert (events[3]["previous_tag"], events[3]["tag"]) == ("Work", "Café")
        assert events[-1]["tag"] is None and store.tags() == []


def test_cli_history_shows_saved_text_and_tag_changes(cli):
    cli("--no-notify", "Original")
    with Store(cli.database) as store:
        note = store.notes()[0]
        store.edit(note.id, "Edited\nDetails", expected_updated_at=note.updated_at)
        note = store.notes()[0]
        store.set_tag(note.id, "Work", expected_updated_at=note.updated_at)
    history = cli("history", "1").stdout.splitlines()
    assert history[0].endswith("new -> active  Original")
    assert "'Original' -> 'Edited\\nDetails'" in history[1]
    assert "tag Untagged -> 'Work'" in history[2]


@pytest.mark.parametrize(
    "tag", ["x" * 65, "two\nlines", "tab\tname", "bad\x00", "bad\ud800", "end\n"]
)
def test_invalid_tags_never_save_or_truncate(tmp_path, tag):
    with Store(tmp_path / "notes.db") as store:
        with pytest.raises(NoteError):
            store.add("Task", tag=tag)
        assert store.notes() == [] and store.history() == []
