"""Read-only, GTK-free GUI preferences."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from pinote.paths import xdg_path


class ConfigError(ValueError):
    """The GUI configuration cannot be read or has an invalid value."""


@dataclass(frozen=True)
class GuiConfig:
    max_visible_notes: int = 10

    @classmethod
    def load(cls, path: Path | None = None) -> GuiConfig:
        if path is None:
            path = xdg_path("XDG_CONFIG_HOME", ".config") / "pinote" / "config.toml"
        try:
            with path.open("rb") as source:
                document = tomllib.load(source)
        except FileNotFoundError:
            return cls()
        except (OSError, ValueError) as exc:
            raise ConfigError(f"Cannot read GUI config {path}: {exc}") from exc
        section = document.get("gui", {})
        if not isinstance(section, dict):
            raise ConfigError(f"Invalid GUI config {path}: [gui] must be a table.")
        limit = section.get("max_visible_notes", cls.max_visible_notes)
        if type(limit) is not int or limit < 1:
            raise ConfigError(
                f"Invalid GUI config {path}: gui.max_visible_notes must be a positive integer."
            )
        return cls(max_visible_notes=limit)
