"""Optional GTK frontend. Importing this package does not load GTK."""

from __future__ import annotations

import argparse
import sqlite3
import sys

from pinote import __version__
from pinote.logging_setup import LOGGER, configure_logging
from pinote.paths import Paths
from pinote.store import NoteError


class GuiUnavailable(RuntimeError):
    """The optional frontend cannot run in this environment."""


def _load_frontend():
    try:
        from pinote.gui.app import run
    except (ImportError, ValueError) as exc:
        raise GuiUnavailable(
            "GTK 3 Python bindings are unavailable. On Debian, install python3-gi and "
            "gir1.2-gtk-3.0, then use a Debian-Python virtualenv with "
            "--system-site-packages (see README). The note CLI needs no GTK. "
            f"Details: {exc}"
        ) from exc
    return run


def _log_uncaught(exc_type, exc_value, traceback) -> None:
    # PyGObject forwards unhandled signal/timer exceptions to sys.excepthook.
    LOGGER.error(
        "Unexpected GUI failure. Check saved notes with note.",
        exc_info=(exc_type, exc_value, traceback),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pinote-gui",
        description="Optional GTK checklist using the same notes and history as note.",
    )
    parser.add_argument("--version", action="version", version=f"pinote-gui {__version__}")
    parser.parse_args(argv)
    paths = Paths.discover()
    previous_hook = sys.excepthook
    try:
        configure_logging(paths)
        frontend = _load_frontend()
        sys.excepthook = _log_uncaught
        return frontend(paths)
    except (GuiUnavailable, NoteError, OSError, sqlite3.Error) as exc:
        LOGGER.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        LOGGER.warning("Interrupted. Run note to check the saved state.")
        return 130
    except Exception:
        LOGGER.exception("Unexpected GUI failure. Run note to check the saved state.")
        return 1
    finally:
        sys.excepthook = previous_hook
