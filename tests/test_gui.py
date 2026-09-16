"""Real Dunst tests, deliberately isolated from the user's desktop."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time

import pytest

pytestmark = pytest.mark.gui


def bus_has_daemon(env):
    result = subprocess.run(
        [
            "dbus-send",
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.NameHasOwner",
            "string:org.freedesktop.Notifications",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=True,
        timeout=5,
    )
    return "boolean true" in result.stdout


@pytest.fixture
def desktop(request, tmp_path):
    if not request.config.getoption("--run-gui"):
        pytest.skip("use xvfb-run -a dbus-run-session -- uv run pytest -m gui --run-gui")
    for app in ("dunst", "dunstify", "dunstctl", "dbus-send"):
        assert shutil.which(app), f"GUI tests require {app}"
    env = dict(os.environ)
    assert env.get("DISPLAY"), "GUI tests require xvfb-run"
    address = env.get("DBUS_SESSION_BUS_ADDRESS", "")
    assert address and "/run/user/" not in address, "Use a private dbus-run-session"
    # This probe does not auto-activate a notification daemon.
    assert not bus_has_daemon(env), "Refusing to test against an existing desktop daemon"
    env.update(
        XDG_DATA_HOME=str(tmp_path / "data"),
        XDG_STATE_HOME=str(tmp_path / "state"),
    )
    env.pop("WAYLAND_DISPLAY", None)
    config = tmp_path / "dunstrc"
    config.write_text(
        "[global]\norigin=top-right\nwidth=500\nheight=600\n"
        "markup=full\nignore_newline=true\nhistory_length=50\n"
        "idle_threshold=0\n[urgency_normal]\ntimeout=1\n"
    )
    log = tmp_path / "dunst.log"
    with log.open("w") as output:
        process = subprocess.Popen(
            ["dunst", "-config", str(config)],
            env=env,
            stdout=output,
            stderr=output,
        )
        try:
            deadline = time.monotonic() + 5
            while not bus_has_daemon(env):
                assert process.poll() is None, log.read_text()
                assert time.monotonic() < deadline, log.read_text()
                time.sleep(0.05)
            yield env
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def ctl(env, *args):
    return subprocess.run(
        ["dunstctl", *args],
        env=env,
        text=True,
        capture_output=True,
        check=True,
        timeout=5,
    ).stdout.strip()


def run_note(env, *args):
    result = subprocess.run(
        [sys.executable, "-m", "pinote", *args],
        env=env,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WARNING" not in result.stdout and "ERROR" not in result.stdout
    return result.stdout


def close_and_read(env):
    # Dunst history contains dismissed notifications, not currently displayed
    # ones; close ours before inspecting its delivered body and expiry.
    ctl(env, "close")
    assert ctl(env, "count", "displayed") == "0"
    return json.loads(ctl(env, "history"))["data"][0][0]


def test_persistent_replace_dismiss_reopen_complete_restore(desktop):
    env = desktop
    run_note(env, "check backups <&>")
    assert ctl(env, "count", "displayed") == "1"
    time.sleep(1.2)  # survives the daemon's configured one-second default timeout
    assert ctl(env, "count", "displayed") == "1"
    run_note(env, "second reminder")
    assert ctl(env, "count", "displayed") == "1"  # replacement, not duplication
    latest = close_and_read(env)
    assert latest["timeout"]["data"] == 0
    assert latest["stack_tag"]["data"] == "pinote-reminders"
    assert "1. check backups &lt;&amp;&gt;" in latest["body"]["data"]
    assert "\u20282. second reminder" in latest["body"]["data"]
    assert "1. check backups <&>" in run_note(env)
    assert ctl(env, "count", "displayed") == "0"  # terminal listing does not reopen
    run_note(env, "show")
    assert ctl(env, "count", "displayed") == "1"
    close_and_read(env)
    run_note(env, "third reminder")  # adding reopens a dismissed display
    assert ctl(env, "count", "displayed") == "1"
    run_note(env, "done", "1")
    assert ctl(env, "count", "displayed") == "1"
    body = close_and_read(env)["body"]["data"]
    assert "backups" not in body and "2. second reminder" in body
    run_note(env, "rm", "2")
    run_note(env, "done", "3")
    assert "No active reminders" in close_and_read(env)["body"]["data"]
    run_note(env, "restore", "1")
    assert ctl(env, "count", "displayed") == "1"
    assert "1. check backups" in close_and_read(env)["body"]["data"]
    assert "restore" in run_note(env, "history", "1")
