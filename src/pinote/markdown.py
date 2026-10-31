"""Small, explicit Markdown import/export, not a general Markdown parser."""

from __future__ import annotations

import re

from pinote.store import Note

BULLET = re.compile(r"^([ \t]*)[-*+][ \t]+(?:\[([ xX~])\][ \t]*)?(.*)$")


def parse(text: str) -> list[tuple[str, str, str | None]]:
    entries: list[tuple[str, str, str | None]] = []
    parent: str | None = None
    tag: str | None = None
    child_indent: int | None = None
    continuation_indent: int | None = None
    # splitlines() also splits U+2028/U+2029 inside otherwise valid note text.
    for line in text.replace("\r\n", "\n").split("\n"):
        # Checkbox notes retain the literal multiline format used by export.
        if continuation_indent is not None and line.startswith(" " * continuation_indent):
            previous, state, saved_tag = entries[-1]
            entries[-1] = (previous + "\n" + line[continuation_indent:], state, saved_tag)
            continue
        match = BULLET.match(line)
        if not match:
            continue
        indent, checked, body = match.groups()
        width = len(indent.expandtabs(4))
        state = {"x": "done", "X": "done", "~": "in_progress"}.get(checked, "active")
        if width == 0:
            entries.append((body, state, None))
            parent = body if checked is None else None
            tag = None
            child_indent = None
        elif parent is not None or tag is not None:
            if tag is None:
                tag, parent = parent, None
                child_indent = width
                entries.pop()  # The parent names a tag, not a note.
            elif width != child_indent:
                continue  # Only one child-list level is supported.
            entries.append((body, state, tag))
        else:
            continue  # Ignore orphaned indented bullets.
        continuation_indent = width + 4 if checked is not None else None
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
