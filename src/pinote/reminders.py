"""Reminder times: local input, explicit offsets when daylight saving is ambiguous."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from pinote.store import NoteError

DATE_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?"
)


def parse_reminder_time(value: str) -> datetime:
    value = value.strip()
    try:
        if not DATE_TIME.fullmatch(value):
            raise ValueError
        when = datetime.fromisoformat(value)
        if when.tzinfo is not None:
            return when.astimezone(UTC)
        # A wall-clock time may occur twice, or not at all, at a DST change.
        # Reject either case instead of silently scheduling the wrong instant.
        candidates = set()
        for fold in (0, 1):
            candidate = when.replace(fold=fold).astimezone(UTC)
            if candidate.astimezone().replace(tzinfo=None) == when:
                candidates.add(candidate)
        if len(candidates) != 1:
            raise NoteError(
                "This local time is ambiguous or skipped by daylight saving. "
                "Choose another time, or supply an explicit UTC offset."
            )
        return candidates.pop()
    except NoteError:
        raise
    except (ValueError, OverflowError) as exc:
        raise NoteError("Use a date and time like 2026-09-18 14:30 (local time).") from exc


def local_reminder_time(value: str) -> str:
    return datetime.fromisoformat(value).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
