from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from pinote.cli import arguments, main
from pinote.paths import Paths, display_lock, xdg_path


def test_full_cli_lifecycle(cli):
    assert "Added note 1" in cli("--no-notify", "check backups").stdout
    cli("--no-notify", "another")
    assert cli().stdout == "1. check backups\n2. another\n"
    cli("done", "1", "--no-notify")
    assert cli().stdout == "2. another\n"
    cli("rm", "2", "--no-notify")
    assert "No active notes" in cli().stdout
    cli("restore", "1", "--no-notify")
    assert cli().stdout == "1. check backups\n"
    history = cli("history", "1").stdout
    assert "add" in history and "done" in history and "restore" in history
    assert "another" not in history
    assert "2. [removed] another" in cli("list", "--all").stdout


def test_scheduled_reminder_cli_lists_history_restore_and_due_delivery(cli):
    cli.env["TZ"] = "UTC"
    cli("--no-notify", "Call\nDetails 🐦")
    result = cli("schedule", "1", "2099-04-10 12:30", "--no-notify")
    assert "scheduled for 2099-04-10 12:30:00 UTC" in result.stdout
    assert cli().stdout == "No active notes.\n"
    paths = Paths(cli.database.parent, Path(cli.env["XDG_STATE_HOME"]) / "pinote")
    with display_lock(paths):
        assert "1. 2099-04-10 12:30:00 UTC Call\n    Details 🐦" in cli("reminders").stdout
    assert "[scheduled]" in cli("list", "--all").stdout
    assert "Call" not in cli("export", "--all").stdout
    assert "already scheduled" in cli("schedule", "1", "2099-04-10 12:30Z", "--no-notify").stdout
    history = cli("history", "1").stdout
    assert "schedule  active -> scheduled" in history
    assert "reminder none -> 2099-04-10 12:30:00 UTC" in history
    assert len(history.splitlines()) == 2
    for value in ("yesterday", "2000-01-01 12:00"):
        assert cli("schedule", "1", value, "--no-notify", check=False).returncode == 1
    assert "2099-04-10 12:30" in cli("reminders").stdout
    cli("restore", "1", "--no-notify")
    assert cli().stdout == "1. Call\n    Details 🐦\n"
    assert cli("reminders").stdout == "No scheduled reminders.\n"
    # Scheduling still commits before a failing Dunst refresh.
    assert (
        "Notes saved, but desktop refresh failed" in cli("schedule", "1", "2099-04-11 12:30").stdout
    )
    with sqlite3.connect(cli.database) as db:
        db.execute("UPDATE notes SET remind_at = '2000-01-01T12:00:00.000000+00:00' WHERE id = 1")
    assert cli().stdout == "1. Call\n    Details 🐦\n"
    assert cli("reminders").stdout == "No scheduled reminders.\n"
    with sqlite3.connect(cli.database) as db:
        assert db.execute("SELECT action FROM events WHERE note_id = 1").fetchall() == [
            ("add",),
            ("schedule",),
            ("restore",),
            ("schedule",),
            ("remind",),
        ]
        assert db.execute("SELECT state, remind_at FROM notes").fetchone() == ("active", None)


@pytest.mark.parametrize(
    "argv",
    [
        ("done", "0"),
        ("rm", "-1"),
        ("restore", "bad"),
        ("done",),
        ("history", "9" * 30),
        ("add",),
        ("show", "unexpected"),
    ],
)
def test_argument_errors(cli, argv):
    result = cli(*argv, check=False)
    assert result.returncode == 2
    assert not cli.database.exists()


def test_help_and_version_have_no_side_effects(cli):
    assert "durable history" in cli("--help").stdout
    assert "pinote 0.1.0" in cli("--version").stdout
    assert not cli.database.exists()
    assert not cli.log.exists()


def test_error_messages_are_logged_to_file_and_stdout(cli):
    result = cli("done", "42", "--no-notify", check=False)
    assert result.returncode == 1
    assert "No note with ID 42" in result.stdout
    assert "No note with ID 42" in cli.log.read_text()
    assert not result.stderr


def test_notification_failure_does_not_lose_save(cli):
    result = cli("saved despite desktop failure")
    assert "Added note 1" in result.stdout
    assert "Notes saved, but desktop refresh failed" in result.stdout
    assert "test: desktop unavailable" in cli.log.read_text()
    assert "1. saved despite desktop failure" in cli().stdout
    assert cli("show", check=False).returncode == 1
    assert cli("--no-notify", "show", check=False).returncode == 1


def test_invalid_notifier_output_still_reports_a_saved_note(cli):
    fake = Path(cli.env["PATH"].split(os.pathsep)[0]) / "dunstify"
    fake.write_text("#!/bin/sh\nprintf '\\377' >&2\nexit 1\n")
    result = cli("saved despite invalid notifier output", check=False)
    assert result.returncode == 0
    assert "Notes saved, but desktop refresh failed" in result.stdout
    assert "saved despite invalid notifier output" in cli().stdout


def test_quotes_multiline_and_command_names(cli):
    text = "quotes ' \" <&> 🐦\nsecond line"
    cli("--no-notify", text)
    cli("add", "done", "--no-notify")
    cli("--no-notify", "add", "--", "--literal")
    assert "second line" in cli().stdout
    assert "2. done" in cli().stdout
    assert "3. --literal" in cli().stdout
    with sqlite3.connect(cli.database) as db:
        assert db.execute("SELECT text FROM notes WHERE id=1").fetchone()[0] == text


def test_import_and_export(cli, tmp_path):
    source = tmp_path / "REMINDER.md"
    original = "# Reminders\n\n- existing\n- [x] finished\n"
    source.write_text(original)
    assert "Imported 2 notes" in cli("import", str(source), "--no-notify").stdout
    assert source.read_text() == original
    alias = tmp_path / "alias.md"
    alias.symlink_to(source)
    assert "already imported" in cli("import", str(alias), "--no-notify").stdout
    assert cli("export").stdout == "# Reminders\n\n- [ ] existing\n"
    assert cli("export", "--all").stdout == "# Reminders\n\n- [ ] existing\n- [x] finished\n"
    assert "import" in cli("history").stdout
    assert cli("import", str(tmp_path / "missing"), check=False).returncode == 1


def test_invalid_text_does_not_save(cli):
    for text in ("", "  ", "a\x1bb", "x" * 4097):
        assert cli("--no-notify", text, check=False).returncode == 1
    assert "No active notes" in cli().stdout


def test_concurrent_cli_adds_are_unique_and_atomic(cli):
    def add(index):
        return cli("--no-notify", f"parallel {index}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(add, range(16)))
    with sqlite3.connect(cli.database) as db:
        rows = db.execute("SELECT id, text FROM notes").fetchall()
        assert len(rows) == len({row[0] for row in rows}) == 16
        assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 16
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_display_updates_are_serialized(cli, tmp_path):
    # A slow notifier records the body after sleeping. Without a lock a slow
    # older process could replace the newest display with stale content.
    fake = Path(cli.env["PATH"].split(os.pathsep)[0]) / "dunstify"
    capture = tmp_path / "renders"
    fake.write_text('#!/bin/sh\nsleep 0.1\nprintf \'%s\\n\' "$*" >> "$CAPTURE"\n')
    cli.env["CAPTURE"] = str(capture)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda index: cli(f"concurrent-{index}"), range(4)))
    renders = capture.read_text().rstrip("\n").split("\n")
    assert len(renders) == 4
    assert all(f"concurrent-{i}" in renders[-1] for i in range(4))


def test_xdg_defaults_and_relative_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", "relative-not-allowed")
    assert Paths.discover().data == tmp_path / ".local/share/pinote"
    assert Paths.discover().state == tmp_path / ".local/state/pinote"
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "override"))
    assert xdg_path("XDG_DATA_HOME", ".local/share") == tmp_path / "override"


def test_global_and_local_no_notify():
    for argv in (["--no-notify", "hello"], ["add", "--no-notify", "hello"]):
        parsed = arguments(argv)
        assert parsed.command == "add" and parsed.no_notify
    assert arguments([]).command == "list"


def test_uncaught_exception_is_logged(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))

    def fail(*args):
        raise RuntimeError("unexpected-test-failure")

    monkeypatch.setattr("pinote.cli.execute", fail)
    assert main([]) == 1
    assert "unexpected-test-failure" in capsys.readouterr().out
    assert "unexpected-test-failure" in (tmp_path / "state/pinote/app.log").read_text()


def test_installed_console_entrypoint(cli):
    entry = Path(sys.executable).parent / "note"
    result = subprocess.run(
        [str(entry), "--version"],
        env=cli.env,
        text=True,
        capture_output=True,
        check=True,
    )
    assert result.stdout == "pinote 0.1.0\n"
