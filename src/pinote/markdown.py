"""Small, explicit Markdown import/export, not a general Markdown parser."""

from __future__ import annotations

import re

from pinote.store import Note

BULLET = re.compile(r"^\s*[-*+]\s+(?:\[([ xX~])\]\s*)?(.*)$")
HEADING = re.compile(r"^\s*#{1,6}\s+")


def parse(text: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    # splitlines() also splits U+2028/U+2029 inside otherwise valid note text.
    for line in text.replace("\r\n", "\n").split("\n"):
        # Continuations may themselves be blank or look like Markdown headings.
        if line.startswith("    ") and entries:
            previous, state = entries[-1]
            entries[-1] = (previous + "\n" + line[4:], state)
            continue
        if not line.strip() or HEADING.match(line):
            continue
        match = BULLET.match(line)
        if match:
            checked, body = match.groups()
            state = {"x": "done", "X": "done", "~": "in_progress"}.get(checked, "active")
            entries.append((body, state))
        else:
            entries.append((line.strip(), "active"))
    return entries


def export(notes: list[Note]) -> str:
    lines = ["# Reminders", ""]
    for note in notes:
        if note.state in {"removed", "scheduled"}:
            continue
        mark = {"done": "x", "in_progress": "~"}.get(note.state, " ")
        parts = note.text.split("\n")
        lines.append(f"- [{mark}] {parts[0]}")
        lines.extend("    " + line for line in parts[1:])
    return "\n".join(lines) + "\n"
