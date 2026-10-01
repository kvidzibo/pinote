"""Saved tag filter, using the same private atomic snapshots as input drafts."""

from __future__ import annotations

import json
from pathlib import Path

from pinote.gui.draft import DraftCache
from pinote.store import validate_tag


class FilterCache:
    def __init__(self, path: Path):
        self._cache = DraftCache(path)

    def load(self) -> frozenset[str] | None:
        text = self._cache.load()
        if not text:
            return frozenset({""})  # First launch defaults to Untagged.
        value = json.loads(text)
        if value is None:
            return None  # All tasks.
        if isinstance(value, str):
            value = [value]  # Restore single-tag filters saved by older versions.
        if not isinstance(value, list) or any(not isinstance(tag, str) for tag in value):
            raise ValueError("Saved tag filter must be a list of tag names or null.")
        return frozenset(validate_tag(tag) or "" for tag in value)

    def update(self, tags: frozenset[str] | None) -> None:
        self._cache.update(
            json.dumps(sorted(tags) if tags is not None else None, ensure_ascii=True)
        )

    def save(self) -> None:
        self._cache.save()
