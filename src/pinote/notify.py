"""One persistent Dunst notification; no shell interpolation or background worker."""

from __future__ import annotations

import html
import subprocess

from pinote.store import Note

STACK_TAG = "pinote-reminders"


class NotificationError(RuntimeError):
    pass


def render(notes: list[Note]) -> str:
    lines = []
    for note in notes[:10]:
        text = " ".join(note.text.split())
        if len(text) > 180:
            text = text[:179] + "…"
        progress = "[in progress] " if note.state == "in_progress" else ""
        lines.append(f"{note.id}. {progress}{html.escape(text, quote=False)}")
    if len(notes) > 10:
        lines.append(f"… {len(notes) - 10} more; run note for the full list.")
    if not notes:
        lines.append("No active reminders.")
    lines.append('<span size="small">note · note done ID · note rm ID</span>')
    # Dunst may be configured with ignore_newline=true; U+2028 preserves layout.
    return "\u2028".join(lines)


def show(notes: list[Note]) -> None:
    try:
        result = subprocess.run(
            [
                "dunstify",
                # Short flags and the hint also work with distro Dunst 1.9.
                "-a",
                "pinote",
                "-u",
                "normal",
                "-t",
                "0",
                "-h",
                f"string:x-dunst-stack-tag:{STACK_TAG}",
                "--",
                "Reminders",
                # dunstify decodes C escapes before sending the body. Escape
                # backslashes so octal text cannot bypass our markup escaping.
                render(notes).replace("\\", "\\\\"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except FileNotFoundError as exc:
        raise NotificationError(
            "dunstify is not installed; install Dunst to show reminders."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise NotificationError("Dunst did not respond within 5 seconds.") from exc
    except OSError as exc:
        raise NotificationError(f"Cannot run dunstify: {exc}") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise NotificationError(f"Dunst could not show reminders: {detail or result.returncode}")
