"""Small, explicit Markdown import/export, not a general Markdown parser."""

from __future__ import annotations

import re

from pinote.store import Note

BULLET = re.compile(r"^\s*[-*+]\s+(?:\[([ xX])\]\s*)?(.*)$")
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
            entries.append((body, "done" if checked in {"x", "X"} else "active"))
        else:
            entries.append((line.strip(), "active"))
    return entries


def export(notes: list[Note]) -> str:
    lines = ["# Reminders", ""]
    for note in notes:
        if note.state == "removed":
            continue
        mark = "x" if note.state == "done" else " "
        parts = note.text.split("\n")
        lines.append(f"- [{mark}] {parts[0]}")
        lines.extend("    " + line for line in parts[1:])
    return "\n".join(lines) + "\n"
