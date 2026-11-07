"""Focused JSON bridge contract tests; never contact a desktop or live data."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

import pytest

from pinote import __version__
from pinote import electron_bridge as bridge
from pinote.paths import Paths, display_lock
from pinote.store import Store


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    for variable, suffix in (
        ("HOME", "home"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_RUNTIME_DIR", "runtime"),
    ):
        monkeypatch.setenv(variable, str(tmp_path / suffix))
    for variable in ("DISPLAY", "WAYLAND_DISPLAY", "KITTY_LISTEN_ON", "I3SOCK"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent-bridge-test")
    return Paths.discover()


def request(op, **params):
    return {"protocol": 1, "operation": op, "params": params}


def call(op, **params):
    response = bridge.respond(request(op, **params))
    assert response["ok"], response
    return response["result"]


def target(paths, note_id):
    with Store(paths.database) as store:
        note = store.get(note_id)
    return {"id": note.id, "revision": note.updated_at}


def process(data, *args):
    return subprocess.run(
        [sys.executable, "-m", "pinote.electron_bridge", *args],
        input=data,
        capture_output=True,
        timeout=10,
    )


def test_handshake_no_side_effects_or_gi(isolated, tmp_path):
    before = set(tmp_path.rglob("*"))
    result = process(json.dumps(request("handshake")).encode())
    assert result.returncode == 0
    assert not result.stderr
    assert json.loads(result.stdout) == {
        "protocol": 1,
        "ok": True,
        "result": {
            "version": __version__,
            "protocol": 1,
            "database": str(isolated.database.resolve()),
        },
    }
    for flag in ("--help", "--version"):
        assert process(b"", flag).returncode == 0
    assert set(tmp_path.rglob("*")) == before
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from pinote.electron_bridge import respond; "
            "respond({'protocol':1,'operation':'handshake','params':{}}); "
            "assert 'gi' not in sys.modules",
        ],
        capture_output=True,
        timeout=10,
    )
    assert probe.returncode == 0, probe.stderr


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"{}{}",
        b"\xff",
        b'{"protocol":1,"protocol":1}',
        b'{"x":NaN}',
        b'{"x":Infinity}',
        b'{"x":1e999}',
        b"[" * 1100 + b"]" * 1100,
        b"[" * 18 + b"]" * 18,
        b" " * (bridge.MAX_REQUEST + 1),
    ],
    ids=[
        "empty",
        "trailing",
        "utf8",
        "duplicate",
        "nan",
        "infinity",
        "overflow",
        "recursive",
        "deep",
        "oversize",
    ],
)
def test_bad_json(isolated, data):
    result = process(data)
    assert result.returncode == 0
    assert json.loads(result.stdout)["error"]["code"] == "invalid"
    assert not isolated.data.exists()


@pytest.mark.parametrize(
    "value",
    [
        {},
        request("handshake", extra=True),
        {**request("handshake"), "protocol": True},
        request("get", id=1),
        request("snapshot", view="all"),
        request("add", text=1, tag=None),
        request("add", text="a", tag=False),
        request("edit", id=True, revision="x", text="a"),
        request("edit", id=2**53, revision="x", text="a"),
        request("edit", id=1, revision="", text="a"),
        request("edit", id=1, revision="x", text="\ud800"),
        request("create_tag", name="a", folder=None, id=1),
        request("transition", id=1, revision="x", state="done", action="start"),
        request("completions", ids=[False]),
        request("completions", ids=[1] * 1001),
    ],
)
def test_validation_exact_primitives(isolated, value):
    assert bridge.respond(value)["error"]["code"] == "invalid"
    assert not isolated.data.exists()


def test_subprocess_unicode_framing_and_private_logging(isolated):
    data = json.dumps(
        request("add", text="你好 🌱\nsecond line", tag="é"), ensure_ascii=False
    ).encode()
    result = process(data)
    assert result.returncode == 0
    assert len(result.stdout.splitlines()) == 1
    note_id = json.loads(result.stdout)["result"]["id"]
    snapshot = json.loads(process(json.dumps(request("snapshot", view="active")).encode()).stdout)
    assert snapshot["result"]["notes"][0]["text"] == "你好 🌱\nsecond line"
    result = process(
        json.dumps(request("edit", id=note_id, revision="stale", text="SECRET")).encode()
    )
    assert json.loads(result.stdout)["error"]["code"] == "conflict"
    assert b"SECRET" not in result.stderr
    assert "SECRET" not in isolated.log.read_text()
    assert isolated.log.stat().st_mode & 0o777 == 0o600


def test_workflow_all_routes(isolated, tmp_path):
    folder = str(tmp_path)
    assert call("create_tag", name=" Work ", folder=folder)["tag"] == "Work"
    assert call("snapshot", view="active")["tags"][0]["available"] is True
    note_id = call("add", text="task", tag="work")["id"]
    assert call("edit", **target(isolated, note_id), text="task edited")["changed"]
    assert not call("edit", **target(isolated, note_id), text="task edited")["changed"]
    assert call("tag", **target(isolated, note_id), tag=None)["changed"]
    assert call("create_tag", **target(isolated, note_id), name="WORK", folder=folder) == {
        "changed": True,
        "id": note_id,
        "tag": "Work",
    }
    assert call("rename_tag", name="Work", newName="Project")["changed"]
    assert call("tag_folder", name="Project", folder=None)["changed"]
    assert call("snapshot", view="active")["tags"][0]["available"] is False
    assert call("delete_tag", name="Project")["changed"]
    for action, state in (("start", "active"), ("reset", "in_progress"), ("done", "active")):
        assert call("transition", **target(isolated, note_id), action=action, state=state)[
            "changed"
        ]
    assert call("completions", ids=[note_id, 9999]) == [note_id]
    archive = call("snapshot", view="archive")["notes"]
    assert archive[0]["archived_at"]
    assert call("transition", **target(isolated, note_id), action="restore", state="done")[
        "changed"
    ]
    assert call("transition", **target(isolated, note_id), action="rm", state="active")["changed"]
    assert call("transition", **target(isolated, note_id), action="restore", state="removed")[
        "changed"
    ]
    when = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    assert call("schedule", **target(isolated, note_id), when=when)["changed"]
    assert call("snapshot", view="active")["notes"] == []
    assert call("snapshot", view="scheduled")["notes"][0]["remind_at"]
    assert call("transition", **target(isolated, note_id), action="restore", state="scheduled")[
        "changed"
    ]
    assert call("completions", ids=[note_id]) == []


def test_snapshot_full_metadata_config_order_and_due(isolated, monkeypatch):
    config = isolated.data.parent.parent / "config/pinote/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        '[gui]\nmax_visible_notes=4\nmarkdown_preview=false\nkitty_start_prompt="go"\n'
    )
    with Store(isolated.database) as store:
        store.create_tag("Unused")
        first = store.add("older", tag="Z")
        store.add("newer", tag="A")
        note = store.get(first)
        store.update_agent(first, {"status": "ready"}, [], expected_updated_at=note.updated_at)
        store.schedule(first, datetime.now(UTC) + timedelta(days=1))
    # Move the Store's clock only; activation retains its existing lock and history semantics.
    import pinote.store

    future = (datetime.now(UTC) + timedelta(days=2)).isoformat(timespec="microseconds")
    monkeypatch.setattr(pinote.store, "timestamp", lambda: future)
    with display_lock(isolated):
        response = bridge.respond(request("snapshot", view="active"))
        assert response["error"]["code"] == "busy"
    snapshot = call("snapshot", view="active")
    assert snapshot["config"] == {
        "maxVisibleNotes": 4,
        "markdownPreview": False,
        "kittyStartPrompt": "go",
    }
    assert [t["name"] for t in snapshot["tags"]] == ["Unused", "Z", "A"]
    with Store(isolated.database) as store:
        assert snapshot["notes"] == [asdict(n) for n in store.notes()]
        assert [e["action"] for e in store.history(first)].count("remind") == 1
    assert snapshot["notes"][0]["agent_notes"] == {"status": "ready"}
    assert snapshot["notes"][0]["agent_event_id"] > 0
    assert snapshot["notes"][0]["reminder_due_at"]
    call("snapshot", view="active")


def test_stale_writes_no_history_or_tag_creation(isolated):
    note_id = call("add", text="task", tag=None)["id"]
    old = target(isolated, note_id)
    call("edit", **old, text="new")
    mutations = [
        request("edit", **old, text="bad"),
        request("tag", **old, tag="bad"),
        request("schedule", **old, when="2099-01-01T00:00:00Z"),
        request("transition", **old, state="active", action="done"),
        request("create_tag", **old, name="bad", folder=None),
    ]
    with Store(isolated.database) as store:
        before = [tuple(e) for e in store.history()]
    for mutation in mutations:
        assert bridge.respond(mutation)["error"]["code"] == "conflict"
    with Store(isolated.database) as store:
        assert [tuple(e) for e in store.history()] == before
        assert store.tags() == []
    # A correct revision but stale state also fails inside the Store transaction.
    assert (
        bridge.respond(
            request("transition", **target(isolated, note_id), state="in_progress", action="done")
        )["error"]["code"]
        == "conflict"
    )


def test_busy_display_and_database(isolated):
    call("add", text="task", tag=None)
    with display_lock(isolated):
        assert bridge.respond(request("add", text="blocked", tag=None))["error"]["code"] == "busy"
    with Store(isolated.database) as store:
        store.connection.execute("BEGIN IMMEDIATE")
        assert bridge.respond(request("add", text="blocked", tag=None))["error"]["code"] == "busy"
    assert len(call("snapshot", view="active")["notes"]) == 1


def test_no_postcommit_read(isolated, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("read failed")

    monkeypatch.setattr(Store, "get", fail)
    monkeypatch.setattr(Store, "notes", fail)
    note_id = call("add", text="task", tag=None)["id"]
    with Store(isolated.database) as store:
        revision = store.connection.execute("SELECT updated_at FROM notes").fetchone()[0]
    assert (
        call("create_tag", id=note_id, revision=revision, name="Tag", folder=None)["tag"] == "Tag"
    )
    with Store(isolated.database) as store:
        revision = store.connection.execute("SELECT updated_at FROM notes").fetchone()[0]
    assert call("transition", id=note_id, revision=revision, action="start", state="active")[
        "changed"
    ]
    assert bridge.respond(request("snapshot", view="active"))["error"]["code"] == "internal"
    with Store(isolated.database) as store:
        assert store.connection.execute("SELECT state, tag FROM notes").fetchone()[:] == (
            "in_progress",
            "Tag",
        )


def test_kitty_revision_title_prompt_and_unknown(isolated, tmp_path, monkeypatch):
    note_id = call("add", text="x" * 40 + "\nnext", tag="Tag")["id"]
    launches = []
    monkeypatch.setattr(bridge, "start_in_kitty", lambda *args: launches.append(args))
    assert call("kitty", **target(isolated, note_id), directory=str(tmp_path))["changed"]
    assert launches[0][2:] == ("[Tag] " + "x" * 30, "is task clear?")
    assert (
        bridge.respond(request("kitty", id=note_id, revision="old", directory=str(tmp_path)))[
            "error"
        ]["code"]
        == "conflict"
    )
    assert len(launches) == 1

    def partial(*args):
        raise OSError("secret")

    monkeypatch.setattr(bridge, "start_in_kitty", partial)
    response = bridge.respond(
        request("kitty", **target(isolated, note_id), directory=str(tmp_path))
    )
    assert response["error"]["code"] == "unknown"
    assert "Check the tab" in response["error"]["message"]
    assert "secret" not in str(response)


def test_dst_delegated_and_bad_config(isolated, monkeypatch):
    note_id = call("add", text="task", tag=None)["id"]
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    try:
        result = bridge.respond(
            request("schedule", **target(isolated, note_id), when="2099-03-08 02:30")
        )
        assert result["error"]["code"] == "invalid"
        assert "daylight saving" in result["error"]["message"]
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()
    config = isolated.data.parent.parent / "config/pinote/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("[gui]\nkitty_start_prompt=42\n")
    assert bridge.respond(request("snapshot", view="active"))["error"]["code"] == "invalid"
