from __future__ import annotations

import subprocess

import pytest

from pinote import notify
from pinote.store import Note


def notes(text="hello", count=1):
    return [Note(i, text, "active", "now", "now") for i in range(1, count + 1)]


def test_render_escapes_markup_and_preserves_layout():
    body = notify.render(notes("<b>O'Brien & friends</b>\nnext"))
    assert "1. &lt;b&gt;O'Brien &amp; friends&lt;/b&gt; next" in body
    assert "\u2028" in body
    assert "<b>O'Brien" not in body


def test_render_limits_preview_but_reports_remaining():
    body = notify.render(notes("a" * 200, count=12))
    assert "a" * 179 + "…" in body
    assert "a" * 180 not in body
    assert "10." in body and "11." not in body
    assert "2 more" in body
    assert "No active reminders" in notify.render([])


def test_subprocess_uses_args_timeout_and_one_persistent_tag(monkeypatch):
    captured = {}

    def run(args, **kwargs):
        captured.update(args=args, kwargs=kwargs)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(notify.subprocess, "run", run)
    notify.show(notes("$(touch /tmp/never); --help"))
    assert captured["args"][0] == "dunstify"
    assert "--expire-time=0" in captured["args"]
    assert "--stack-tag=pinote-reminders" in captured["args"]
    assert captured["args"][-3] == "--"
    assert not captured["kwargs"].get("shell")
    assert captured["kwargs"]["timeout"] == 5


@pytest.mark.parametrize(
    "error, message",
    [
        (FileNotFoundError(), "not installed"),
        (PermissionError("denied"), "Cannot run"),
        (subprocess.TimeoutExpired("dunstify", 5), "5 seconds"),
    ],
)
def test_notifier_errors_are_actionable(monkeypatch, error, message):
    def run(*args, **kwargs):
        raise error

    monkeypatch.setattr(notify.subprocess, "run", run)
    with pytest.raises(notify.NotificationError, match=message):
        notify.show([])


def test_nonzero_return(monkeypatch):
    monkeypatch.setattr(
        notify.subprocess,
        "run",
        lambda *a, **kw: subprocess.CompletedProcess(a, 1, "", "no session bus"),
    )
    with pytest.raises(notify.NotificationError, match="no session bus"):
        notify.show([])
