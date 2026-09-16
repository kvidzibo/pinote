from __future__ import annotations

import os
import subprocess
import sys

import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--run-gui",
        action="store_true",
        help="enable Dunst tests; only under xvfb-run + a private dbus-run-session",
    )


@pytest.fixture
def cli(tmp_path):
    env = dict(os.environ)
    env.update(
        XDG_DATA_HOME=str(tmp_path / "data"),
        XDG_STATE_HOME=str(tmp_path / "state"),
    )
    # Unit/CLI tests must never contact the user's desktop, even if a test
    # accidentally forgets --no-notify.
    env.pop("DISPLAY", None)
    env.pop("WAYLAND_DISPLAY", None)
    env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/nonexistent-pinote-test-bus"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake = fake_bin / "dunstify"
    fake.write_text("#!/bin/sh\necho 'test: desktop unavailable' >&2\nexit 1\n")
    fake.chmod(0o700)
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")

    def run(*args, check=True):
        result = subprocess.run(
            [sys.executable, "-m", "pinote", *args],
            env=env,
            text=True,
            capture_output=True,
            timeout=20,
        )
        if check:
            assert result.returncode == 0, result.stdout + result.stderr
        return result

    run.env = env
    run.database = tmp_path / "data/pinote/notes.db"
    run.log = tmp_path / "state/pinote/app.log"
    return run
