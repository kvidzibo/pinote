"""Scheduled notes must remain durable, revision-safe and fire only once."""

import sqlite3
import time
from datetime import UTC, datetime, timedelta

import pytest

from pinote import markdown
from pinote.gui.model import ReminderModel
from pinote.paths import Paths, display_lock
from pinote.reminders import parse_reminder_time
from pinote.store import MIGRATION_3, SCHEMA, NoteError, Store


def test_reminder_lifecycle_survives_v3_upgrade_restart_and_stale_actions(tmp_path, monkeypatch):
    paths = Paths(tmp_path / "data", tmp_path / "state")
    paths.data.mkdir()
    # A genuine v3 database, including old history/imports and sequence high-water marks.
    with sqlite3.connect(paths.database) as db:
        for statement in (*SCHEMA, *MIGRATION_3):
            db.execute(statement)
        db.execute("PRAGMA user_version = 3")
        db.execute(
            "INSERT INTO notes VALUES (7, 'Call\nDetails 🐦', 'in_progress', 'old', 'old', 'Work')"
        )
        db.execute(
            "INSERT INTO events VALUES "
            "(9, 7, 'add', NULL, 'active', 'old', 'Call', NULL, NULL, NULL)"
        )
        db.execute("INSERT INTO imports VALUES ('/old.md', 'old', 1)")
        db.execute("UPDATE sqlite_sequence SET seq = 40 WHERE name = 'notes'")
        db.execute("UPDATE sqlite_sequence SET seq = 80 WHERE name = 'events'")
    clock = datetime(2030, 1, 1, tzinfo=UTC)
    monkeypatch.setattr("pinote.store.timestamp", lambda: clock.isoformat(timespec="microseconds"))
    model = ReminderModel(paths)
    original = model.notes()[0]
    due = clock + timedelta(hours=1)
    assert model.schedule(original, due)
    scheduled = model.reminders()[0]
    assert scheduled.id == original.id and scheduled.text == original.text
    assert scheduled.tag == "Work" and scheduled.created_at == "old"
    assert scheduled.state == "scheduled"
    assert scheduled.remind_at == due.isoformat(timespec="microseconds")
    assert model.notes() == [] and model.archive() == []
    with Store(paths.database) as store:
        assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 4
        assert store.connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert store.connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert store.import_notes("/old.md", [("duplicate", "active")]) is None
        assert store.history(7)[0]["text"] == "Call"
        assert store.history(7)[-1]["id"] == 81
        assert "Call" not in markdown.export(store.notes(all_states=True))
        assert not store.schedule(7, due)  # Same time does not duplicate history.
        for action in ("start", "reset", "done"):
            with pytest.raises(NoteError, match="restore it first"):
                store.transition(7, action)
    with display_lock(paths):
        assert model.notes() == []  # Non-due polls must not take the mutation lock.
        with pytest.raises(BlockingIOError):
            model.release(scheduled)
    clock += timedelta(minutes=1)
    later = due + timedelta(hours=1)
    assert model.schedule(scheduled, later)
    assert not model.release(scheduled)  # Cannot cancel a reminder rescheduled elsewhere.
    with pytest.raises(NoteError, match="changed elsewhere"):
        model.schedule(scheduled, later + timedelta(hours=1))
    with pytest.raises(NoteError, match="future"):
        model.schedule(model.reminders()[0], clock)
    clock = later - timedelta(microseconds=1)
    assert model.notes() == []
    clock = later
    with display_lock(paths):
        with pytest.raises(BlockingIOError):
            model.notes()
    # If history cannot commit, promotion must roll back as well.
    with Store(paths.database) as store:
        store.connection.execute(
            "CREATE TRIGGER fail_remind BEFORE INSERT ON events WHEN NEW.action = 'remind' "
            "BEGIN SELECT RAISE(ABORT, 'blocked'); END"
        )
        with pytest.raises(sqlite3.IntegrityError, match="blocked"):
            store.activate_due()
        assert store.notes() == [] and len(store.scheduled_notes()) == 1
        store.connection.execute("DROP TRIGGER fail_remind")
    # Reopening the model promotes an overdue reminder, even without its list open.
    model = ReminderModel(paths)
    active = model.notes()[0]
    assert active.id == 7 and active.state == "active" and active.remind_at is None
    assert active.tag == "Work" and model.reminders() == []
    assert model.notes() == [active]
    with Store(paths.database) as store:
        events = store.history(7)
        assert [e["action"] for e in events] == ["add", "schedule", "schedule", "remind"]
        assert events[-1]["previous_remind_at"] == later.isoformat(timespec="microseconds")
        assert events[-1]["remind_at"] is None
        assert store.add("Next ID") == 41
    clock += timedelta(seconds=1)
    assert model.schedule(active, clock + timedelta(hours=1))
    assert model.release(model.reminders()[0])
    assert model.notes()[0].remind_at is None
    clock += timedelta(seconds=1)
    assert model.schedule(model.notes()[0], clock + timedelta(hours=1))
    with Store(paths.database) as store:
        assert store.transition(7, "rm")
        assert store.scheduled_notes() == []
        assert store.archived_notes()[0].remind_at is None


def test_local_reminder_times_reject_dst_gaps_and_ambiguity(monkeypatch):
    with monkeypatch.context() as env:
        env.setenv("TZ", "Europe/Prague")
        time.tzset()
        try:
            assert parse_reminder_time("2030-01-01 14:30") == datetime(
                2030, 1, 1, 13, 30, tzinfo=UTC
            )
            assert parse_reminder_time("2030-10-27 02:30+02:00") == datetime(
                2030, 10, 27, 0, 30, tzinfo=UTC
            )
            for value in ("2030-03-31 02:30", "2030-10-27 02:30"):
                with pytest.raises(NoteError, match="daylight saving"):
                    parse_reminder_time(value)
            for value in ("2030-01-01", "tomorrow", "2030-02-30 12:00", "2030-01-01 24:30"):
                with pytest.raises(NoteError, match="date and time"):
                    parse_reminder_time(value)
        finally:
            env.undo()
            time.tzset()
