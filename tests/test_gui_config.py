from pathlib import Path

import pytest

from pinote.gui.config import ConfigError, GuiConfig


def test_missing_config_uses_defaults_without_creating_files(tmp_path):
    path = tmp_path / "pinote/config.toml"
    assert GuiConfig.load(path).max_visible_notes == 10
    assert not path.parent.exists()


@pytest.mark.parametrize("contents", ["", "[gui]\n", "[other]\nvalue = 42\n"])
def test_missing_setting_uses_default(tmp_path, contents):
    path = tmp_path / "config.toml"
    path.write_text(contents)
    assert GuiConfig.load(path) == GuiConfig()


@pytest.mark.parametrize("limit", [1, 3, 25])
def test_reads_visible_note_limit_from_xdg_config(tmp_path, monkeypatch, limit):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    path = tmp_path / "pinote/config.toml"
    path.parent.mkdir()
    path.write_text(f"[gui]\nmax_visible_notes = {limit}\n")
    assert GuiConfig.load().max_visible_notes == limit


@pytest.mark.parametrize("xdg", ["", "relative/config"])
def test_ignores_relative_xdg_config(tmp_path, monkeypatch, xdg):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", xdg)
    path = tmp_path / ".config/pinote/config.toml"
    path.parent.mkdir(parents=True)
    path.write_text("[gui]\nmax_visible_notes = 2\n")
    assert GuiConfig.load().max_visible_notes == 2


@pytest.mark.parametrize("value", ["0", "-1", "true", "1.5", '"3"', "[]", "{}"])
def test_rejects_invalid_limits(tmp_path, value):
    path = tmp_path / "config.toml"
    path.write_text(f"[gui]\nmax_visible_notes = {value}\n")
    with pytest.raises(ConfigError, match="max_visible_notes must be a positive integer") as error:
        GuiConfig.load(path)
    assert str(path) in str(error.value)


@pytest.mark.parametrize("contents", ["[gui", "gui = 3", "gui = []"])
def test_rejects_invalid_document(tmp_path, contents):
    path = tmp_path / "config.toml"
    path.write_text(contents)
    with pytest.raises(ConfigError, match=str(path)):
        GuiConfig.load(path)


def test_unreadable_config_is_not_treated_as_missing(tmp_path, monkeypatch):
    def denied(*_args, **_kwargs):
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "open", denied)
    with pytest.raises(ConfigError, match="denied"):
        GuiConfig.load(tmp_path / "config.toml")
