"""Entry-point and import isolation: these tests intentionally need no GTK."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from pinote import gui


def test_cli_and_gui_package_do_not_import_gtk(cli):
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import pinote.cli, pinote.gui, sys; "
            "assert 'gi' not in sys.modules; assert 'pinote.gui.app' not in sys.modules",
        ],
        env=cli.env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not cli.database.exists()
    assert not cli.log.exists()


@pytest.mark.parametrize("args", [("--help",), ("--version",), ("--unknown",)])
def test_gui_arguments_work_without_gtk_or_side_effects(cli, args):
    entry = Path(sys.executable).parent / "pinote-gui"
    result = subprocess.run(
        [str(entry), *args], env=cli.env, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == (2 if args == ("--unknown",) else 0)
    if args == ("--version",):
        assert result.stdout == "pinote-gui 0.1.0\n"
    assert not cli.database.exists()
    assert not cli.log.exists()


def test_missing_gtk_is_actionable_and_logged(cli):
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            'import sys; sys.modules["gi"] = None; '
            "from pinote.gui import main; raise SystemExit(main([]))",
        ],
        env=cli.env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 1
    assert "GTK 3 Python bindings are unavailable" in result.stdout
    assert "--system-site-packages" in result.stdout
    assert "GTK 3 Python bindings are unavailable" in cli.log.read_text()
    assert not result.stderr
    assert not cli.database.exists()


def test_frontend_failure_and_callback_exceptions_are_logged(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    old_hook = sys.excepthook

    def frontend(_paths):
        try:
            raise ValueError("test-callback-failure")
        except ValueError:
            sys.excepthook(*sys.exc_info())
        raise RuntimeError("test-startup-failure")

    monkeypatch.setattr(gui, "_load_frontend", lambda: frontend)
    assert gui.main([]) == 1
    assert sys.excepthook is old_hook
    output = capsys.readouterr().out
    log = (tmp_path / "state/pinote/app.log").read_text()
    for message in ("test-callback-failure", "test-startup-failure"):
        assert message in output
        assert message in log
