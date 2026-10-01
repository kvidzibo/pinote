"""Durable handoff fields and project selection through the public CLI."""

import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from pinote.store import MIGRATION_3, MIGRATION_4, MIGRATION_5, SCHEMA, NoteError, Store


def test_agent_handoff_upgrade_restart_and_revision_safe_updates(cli, tmp_path):
    cli.database.parent.mkdir(parents=True)
    # Genuine v5 data, so migration must rebuild the events action CHECK too.
    with sqlite3.connect(cli.database) as db:
        for statement in (*SCHEMA, *MIGRATION_3, *MIGRATION_4, *MIGRATION_5):
            db.execute(statement)
        db.execute("PRAGMA user_version = 5")
        db.execute(
            "INSERT INTO notes(id,text,state,created_at,updated_at,tag) "
            "VALUES (7,'Original task','active','created','old','Work')"
        )
        db.execute("INSERT INTO tags VALUES ('Work')")
        db.execute(
            "INSERT INTO events(id,note_id,action,state,occurred_at,text) "
            "VALUES (9,7,'add','active','created','Original task')"
        )
        db.execute("UPDATE sqlite_sequence SET seq=80 WHERE name='events'")
    cwd = str(tmp_path)

    def agent(*args, **kwargs):
        result = cli("agent", *args, **kwargs)
        return json.loads(result.stdout) if result.returncode == 0 else result

    assert agent("selected", "--cwd", cwd) is None
    task = agent("select", "7", "--cwd", cwd)
    assert task["state"] == "in_progress" and task["agent_notes"] == {}
    assert agent("select", "7", "--cwd", cwd) == task  # no duplicate start event
    assert agent("selected", "--cwd", str(tmp_path / "other")) is None
    link = "[Fix task selection #42](https://github.com/org/repo/pull/42)"
    patch = {
        "PR": link,
        "CWD": "`/another/machine`",
        "Next": "Review\nthen merge 日本語",
        "Code": "    keep indentation\n    and trailing spaces  ",
    }
    saved = agent(
        "update", "7", "--expected-updated-at", task["updated_at"], "--set-json", json.dumps(patch)
    )
    assert saved["text"] == "Original task" and saved["agent_notes"] == patch
    assert "# Agent\n" in saved["markdown"] and f"PR: {link}" in saved["markdown"]
    assert agent("get", "7") == saved
    # Every CLI call is a new process; selection and fields survive restart.
    assert agent("selected", "--cwd", cwd) == saved
    assert "# Agent" in cli().stdout and "Original task" in cli().stdout
    assert "agent" in cli("history", "7").stdout
    stale = agent("done", "7", "--expected-updated-at", task["updated_at"], check=False)
    assert stale.returncode == 1 and "changed elsewhere" in stale.stdout
    assert agent("selected", "--cwd", cwd) == saved

    # Two independent processes cannot clobber a revision, even on different fields.
    def update(label):
        return agent(
            "update",
            "7",
            "--expected-updated-at",
            saved["updated_at"],
            "--set-json",
            json.dumps({label: "saved"}),
            check=False,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(update, ("Jira", "Branch")))
    assert sum(isinstance(result, dict) for result in results) == 1
    current = agent("get", "7")
    assert current["agent_notes"]["PR"] == link
    assert ("Jira" in current["agent_notes"]) != ("Branch" in current["agent_notes"])
    current = agent(
        "update", "7", "--expected-updated-at", current["updated_at"], "--remove", "CWD"
    )
    assert "CWD" not in current["agent_notes"] and current["agent_notes"]["PR"] == link
    assert agent("update", "7", "--expected-updated-at", current["updated_at"]) == current
    for invalid in ("[]", '{"Bad":3}', '{"Bad":"\\u001b[31m"}', '{" ":"value"}'):
        assert (
            agent(
                "update",
                "7",
                "--expected-updated-at",
                current["updated_at"],
                "--set-json",
                invalid,
                check=False,
            ).returncode
            == 1
        )
    assert agent("get", "7") == current
    with Store(cli.database) as store:
        assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 6
        assert store.history(7)[0]["id"] == 9 and store.history(7)[1]["id"] == 81
        assert json.loads(store.history(7)[2]["previous_agent_notes"]) == {}
        assert json.loads(store.history(7)[2]["agent_notes"]) == patch
        assert store.connection.execute("PRAGMA foreign_key_check").fetchall() == []
        # A failed history write must roll back the data as well.
        store.connection.execute(
            "CREATE TRIGGER fail_agent BEFORE INSERT ON events "
            "BEGIN SELECT RAISE(ABORT, 'failed event'); END"
        )
        with pytest.raises(sqlite3.IntegrityError):
            store.update_agent(
                7, {"Next": "must not save"}, [], expected_updated_at=current["updated_at"]
            )
        assert store.get(7).agent_notes == current["agent_notes"]
        store.connection.execute("DROP TRIGGER fail_agent")
        with pytest.raises(NoteError):
            store.update_agent(
                7, {"PR": "conflict"}, ["PR"], expected_updated_at=current["updated_at"]
            )
    done = agent("done", "7", "--expected-updated-at", current["updated_at"])
    assert done["state"] == "done" and done["agent_notes"] == current["agent_notes"]
    assert agent("selected", "--cwd", cwd) is None
    assert agent("select", "7", "--cwd", cwd, check=False).returncode == 1
    cli("restore", "7", "--no-notify")
    assert agent("selected", "--cwd", cwd) is None  # no surprise reselection after restore
    with Store(cli.database) as store:
        assert store.get(7).text == "Original task"
        assert json.loads(store.history(7)[-1]["agent_notes"]) == current["agent_notes"]
        assert store.selected(Path(cwd)) is None


def test_agent_add_and_tag_without_desktop_refresh(cli, tmp_path):
    calls = tmp_path / "dunst-calls"
    fake = Path(cli.env["PATH"].split(os.pathsep)[0]) / "dunstify"
    fake.write_text(f"#!/bin/sh\necho called >> {calls}\nexit 1\n")
    fake.chmod(0o700)
    project = tmp_path / "project"
    project.mkdir()

    def agent(*args, check=True):
        result = cli("agent", *args, check=check)
        return json.loads(result.stdout) if result.returncode == 0 else result

    assert agent("tags") == []
    created = agent("add", "--text", "Check backups", "--tag", "  Cafe\u0301  ")
    assert created["text"] == "Check backups" and created["state"] == "active"
    assert created["tag"] == "Café" and agent("selected", "--cwd", str(project)) is None
    selected = agent("add", "--text", "Follow up", "--tag", "pinote", "--cwd", str(project))
    assert selected["state"] == "in_progress" and selected["tag"] == "pinote"
    assert agent("selected", "--cwd", str(project))["id"] == selected["id"]
    assert agent("selected", "--cwd", str(tmp_path / "other")) is None
    stale = agent(
        "tag",
        str(selected["id"]),
        "--expected-updated-at",
        "stale",
        "--tag",
        "Work",
        check=False,
    )
    assert stale.returncode == 1 and "changed elsewhere" in stale.stdout
    assert agent("get", str(selected["id"]))["tag"] == "pinote"
    cleared = agent(
        "tag", str(created["id"]), "--expected-updated-at", created["updated_at"], "--clear"
    )
    assert cleared["tag"] is None and cleared["text"] == "Check backups"
    retagged = agent(
        "tag", str(created["id"]), "--expected-updated-at", cleared["updated_at"], "--tag", "Café"
    )
    assert retagged["tag"] == "Café" and agent("tags") == ["Café", "pinote"]
    invalid = agent("add", "--text", "nope", "--tag", "bad\nname", check=False)
    assert invalid.returncode == 1 and "nope" not in cli("list", "--json").stdout
    empty = agent("add", "--text", "nope", "--tag", "  ", check=False)
    assert empty.returncode == 1 and "empty" in empty.stdout
    relative = agent("add", "--text", "nope", "--cwd", "relative", check=False)
    assert relative.returncode == 1 and "absolute" in relative.stdout
    assert agent("tags") == ["Café", "pinote"]
    assert not calls.exists()
    history = cli("history", str(selected["id"])).stdout
    assert "add" in history and "start" in history
