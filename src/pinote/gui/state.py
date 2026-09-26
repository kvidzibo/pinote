"""Saved tag filter, using the same private atomic snapshots as input drafts."""

from __future__ import annotations

import json
from pathlib import Path

from pinote.gui.draft import DraftCache
from pinote.store import validate_tag


class FilterCache:
    def __init__(self, path: Path):
        self._cache = DraftCache(path)

    def load(self) -> str | None:
        text = self._cache.load()
        if not text:
            return ""  # First launch defaults to Untagged.
        value = json.loads(text)
        if value is not None and not isinstance(value, str):
            raise ValueError("Saved tag filter must be a tag name or null.")
        if value is not None:
            return validate_tag(value) or ""
        return None  # All tasks.

    def update(self, tag: str | None) -> None:
        self._cache.update(json.dumps(tag, ensure_ascii=True))

    def save(self) -> None:
        self._cache.save()
