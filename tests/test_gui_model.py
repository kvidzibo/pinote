"""The optional frontend's data boundary is testable without GTK."""

from __future__ import annotations

import sqlite3

import pytest

from pinote.gui.model import ReminderModel, application_id
from pinote.paths import Paths, display_lock
from pinote.store import NoteError, Store


@pytest.fixture
def model(tmp_path):
    return ReminderModel(Paths(tmp_path / "data", tmp_path / "state"))


def test_add_returns_saved_id_and_uses_existing_validation_and_history(model):
    text = '  <b>Literal & "quoted"</b> 🐦 $(not-a-command) \\n  '
    first = model.add(text)
    second = model.add("Another task")
    assert (first, second) == (1, 2)
    with Store(model.paths.database) as store:
        assert [note.text for note in store.notes()] == [text.strip(), "Another task"]
        assert [event["action"] for event in store.history()] == ["add", "add"]


@pytest.mark.parametrize("text", ["  ", "x" * 4097, "bad\x07text"])
def test_invalid_add_creates_no_notes_or_events(model, text):
    with pytest.raises(NoteError):
        model.add(text)
    with Store(model.paths.database) as store:
        assert store.notes() == [] and store.history() == []


def test_add_respects_display_lock_and_busy_database(model):
    with display_lock(model.paths):
        with pytest.raises(BlockingIOError):
            model.add("Must not save while locked")
    with Store(model.paths.database) as store:
        store.connection.execute("BEGIN EXCLUSIVE")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            model.add("Must not save while busy")
        store.connection.rollback()
        assert store.notes() == [] and store.history() == []
    assert model.add("Retry once") == 1


def test_add_does_not_read_a_snapshot_after_committing(model, monkeypatch):
    def broken_snapshot(*_args, **_kwargs):
        raise sqlite3.OperationalError("refresh failed after save")

    with monkeypatch.context() as patch:
        patch.setattr(Store, "notes", broken_snapshot)
        assert model.add("Saved even if the next refresh fails") == 1
    with Store(model.paths.database) as store:
        assert store.notes()[0].text == "Saved even if the next refresh fails"
        assert [event["action"] for event in store.history()] == ["add"]


def test_full_text_transitions_and_history_use_existing_store(model):
    text = '<b>Literal & text</b> " \\ $(not-a-command)\n' + "long 🐦 " * 200 + "end"
    with Store(model.paths.database) as store:
        first = store.add(text)
        second = store.add("archive me")
    assert model.notes()[0].text == text
    completed = model.transition(first, "done")
    assert completed.changed
    assert [note.id for note in completed.notes] == [second]
    removed = model.transition(second, "rm")
    assert removed.changed and removed.notes == []
    with Store(model.paths.database) as store:
        assert [note.state for note in store.notes(all_states=True)] == ["done", "removed"]
        assert [event["action"] for event in store.history(first)] == ["add", "done"]
        store.transition(second, "restore")
    assert [note.id for note in model.notes()] == [second]


def test_stale_buttons_never_archive_completed_or_removed_notes(model):
    with Store(model.paths.database) as store:
        note_id = store.add("changed from CLI")
        store.transition(note_id, "done")
    for stale_id, action in ((note_id, "rm"), (note_id, "done"), (note_id + 100, "done")):
        result = model.transition(stale_id, action)
        assert result.notes == [] and not result.changed
    with Store(model.paths.database) as store:
        assert store.notes(all_states=True)[0].state == "done"
        assert len(store.history(note_id)) == 2
        store.transition(note_id, "rm")
    result = model.transition(note_id, "done")
    assert result.notes == [] and not result.changed
    with Store(model.paths.database) as store:
        assert len(store.history(note_id)) == 3


def test_gui_mutations_respect_cli_display_lock_without_waiting(model):
    with Store(model.paths.database) as store:
        note_id = store.add("locked")
    with display_lock(model.paths):
        with pytest.raises(BlockingIOError):
            model.transition(note_id, "done")
        assert model.notes()[0].id == note_id  # reading doesn't need the display lock
    result = model.transition(note_id, "done")
    assert result.changed and result.notes == []


def test_busy_database_can_be_retried(model):
    with Store(model.paths.database) as store:
        store.add("still safe")
        store.connection.execute("BEGIN EXCLUSIVE")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            model.notes()
        store.connection.rollback()
    assert model.notes()[0].text == "still safe"


@pytest.mark.parametrize("action", ["restore", "add"])
def test_gui_cannot_restore_or_add_through_a_row(model, action):
    with pytest.raises(NoteError, match="only supports Done and Remove"):
        model.transition(1, action)
    assert not model.paths.database.exists()


def test_application_identity_is_per_canonical_database(model, tmp_path):
    model.paths.data.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(model.paths.data, target_is_directory=True)
    assert application_id(model.paths) == application_id(Paths(alias, tmp_path / "other-state"))
    assert application_id(model.paths) != application_id(
        Paths(tmp_path / "other", model.paths.state)
    )
    assert str(model.paths.data) not in application_id(model.paths)
