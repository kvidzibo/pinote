"""Real GTK tests. Never import GTK until Xvfb/private-bus isolation is checked."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import textwrap
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from pinote.logging_setup import configure_logging
from pinote.paths import Paths, display_lock
from pinote.store import Store

pytestmark = [pytest.mark.gui, pytest.mark.gtk]


def wait_until(glib, condition, *, timeout=5):
    context = glib.MainContext.default()
    deadline = time.monotonic() + timeout
    while True:
        while context.pending():
            context.iteration(False)
        if condition():
            return
        assert time.monotonic() < deadline, "GTK condition timed out"
        time.sleep(0.01)


def pointer_at(gtk, window, widget, x, y, *actions):
    wait_until(
        gtk.glib, lambda: widget.get_allocated_width() > 1 and widget.get_allocated_height() > 1
    )
    x, y = widget.translate_coordinates(window, x, y)
    _success, origin_x, origin_y = window.get_window().get_origin()
    subprocess.run(
        ["xdotool", "mousemove", str(origin_x + x), str(origin_y + y), *actions],
        env=gtk.env,
        check=True,
        timeout=5,
    )


def click_button(gtk, window, button):
    wait_until(gtk.glib, lambda: button.get_allocated_width() > 1)
    pointer_at(
        gtk,
        window,
        button,
        button.get_allocated_width() // 2,
        button.get_allocated_height() // 2,
        "click",
        "1",
    )


def activate_note_action(row, action):
    """Synchronous input for tests that must act before GTK processes a pending poll."""
    if action == "rm":
        from pinote.gui.app import Gdk

        event = Gdk.Event.new(Gdk.EventType.BUTTON_PRESS)
        event.button = 3
        row.done.emit("button-press-event", event)
        row.done.emit("button-press-event", event)
    else:
        row.done.clicked()


@pytest.fixture
def gtk(request, tmp_path, monkeypatch):
    if not request.config.getoption("--run-gui"):
        pytest.skip("use xvfb-run -a dbus-run-session with --run-gui in the GTK environment")
    assert os.environ.get("DISPLAY"), "GTK tests require xvfb-run"
    assert "xvfb-run." in os.environ.get("XAUTHORITY", ""), "Use xvfb-run, not the real display"
    address = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    assert address and "/run/user/" not in address, "Use a private dbus-run-session"
    for kind in ("DATA", "STATE", "CONFIG", "CACHE"):
        monkeypatch.setenv(f"XDG_{kind}_HOME", str(tmp_path / kind.lower()))
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("GDK_BACKEND", "x11")
    monkeypatch.setenv("NO_AT_BRIDGE", "1")
    monkeypatch.setenv("GIO_USE_VFS", "local")
    monkeypatch.setenv("GSETTINGS_BACKEND", "memory")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    # GTK can auto-activate portal helpers. Contain those helpers as well as
    # this process; this updates ONLY the already-verified private session bus.
    subprocess.run(
        [
            "dbus-update-activation-environment",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_RUNTIME_DIR",
            "GIO_USE_VFS",
            "GSETTINGS_BACKEND",
            "NO_AT_BRIDGE",
        ],
        check=True,
        timeout=5,
    )
    # This import is deliberately inside the opt-in fixture.
    from pinote.gui.app import GLib, Gtk, ReminderApplication

    assert Gtk.init_check()[0]
    paths = Paths.discover()
    configure_logging(paths)
    applications = []
    windows = []

    def open_window(application=None):
        if application is None:
            application = ReminderApplication(paths)
            assert application.register(None)
            assert not application.get_is_remote()
            applications.append(application)
        application.activate()
        assert not application.failed
        window = application.get_windows()[0]
        windows.append(window)
        wait_until(
            GLib,
            lambda: (
                not window.pending
                and not window.geometry_source
                and window.scroll.get_allocated_height() == window.scroll.get_preferred_height()[1]
                and window.get_position()[1] + window.get_size().height == window.anchor_bottom
            ),
        )
        return window

    yield SimpleNamespace(paths=paths, glib=GLib, open=open_window, env=dict(os.environ))
    for window in windows:
        if not window.closed:
            window.destroy()
        window.worker.shutdown(wait=True)
    for application in applications:
        # register()/quit() alone does not unexport GApplication's D-Bus objects.
        # Finish the real run/shutdown lifecycle without activating another window.
        application.connect("handle-local-options", lambda *_args: 0)
        assert application.run(["pinote-gui-test"]) == 0
    wait_until(GLib, lambda: True)


@pytest.fixture
def animations(gtk):
    from pinote.gui.app import Gtk

    settings = Gtk.Settings.get_default()
    previous = settings.get_property("gtk-enable-animations")
    settings.set_property("gtk-enable-animations", True)
    yield settings
    settings.set_property("gtk-enable-animations", previous)


def test_compact_dunst_layout_and_accessible_controls(gtk):
    from pinote.gui.app import Gdk, Gtk

    with Store(gtk.paths.database) as store:
        for text in ("Check backups", "Review pull request", "Plan tomorrow"):
            store.add(text)
    window = gtk.open()
    row = window.rows[1]
    wait_until(gtk.glib, lambda: row.body.get_allocated_height() > 1)
    assert not window.get_decorated()
    assert window.get_titlebar() is None
    assert window.get_child().get_children() == [window.notice, window.scroll, window.composer]
    assert window.entry.get_parent() is window.entry_scroll
    assert window.entry_box.get_parent() is window.composer
    assert window.entry.get_accessible().get_name() == "New task"
    assert window.add_button.get_accessible().get_name() == "Add task"
    assert window.menu_button.get_accessible().get_name() == "Reminders menu"
    assert not hasattr(window, "undo_button") and not hasattr(window, "close_button")
    assert not window.menu.get_visible()
    assert window.composer.get_children() == [
        window.entry_box,
        window.add_button,
        window.menu_button,
    ]
    assert not window.get_resizable()
    assert window.get_size().width == 420
    assert window.get_size().height < 140
    assert row.get_allocated_height() <= 30
    assert isinstance(row.done, Gtk.CheckButton)
    assert not row.done.get_active()
    assert row.done.get_accessible().get_name() == "Start note 1"
    assert row.content.get_children() == [row.done, row.body, row.preview_button]
    assert not row.preview_button.get_visible()
    assert "right-click to mark for deletion" in row.done.get_accessible().get_description()
    assert row.body.get_line_wrap()
    font = row.body.get_pango_context().get_font_description()
    assert "Hack Nerd Font Mono" in font.get_family()
    assert font.get_size() == 9 * 1024
    color = row.body.get_style_context().get_color(Gtk.StateFlags.NORMAL)
    assert (color.red, color.green, color.blue) == pytest.approx((243 / 255, 245 / 255, 248 / 255))
    monitor = window.get_display().get_monitor_at_window(window.get_window()).get_workarea()
    x, y = window.get_position()
    assert x == 25
    assert y + window.get_size().height == monitor.y + monitor.height - 25
    assert window.get_type_hint() == Gdk.WindowTypeHint.DIALOG
    window.close_menu_button.activate()
    wait_until(gtk.glib, lambda: window.closed)
    with Store(gtk.paths.database) as store:
        assert len(store.notes()) == 3
        assert len(store.history()) == 3


def test_text_context_edit_tag_and_bottom_filter_with_real_menus(gtk):
    from pinote.gui.app import Gtk

    with Store(gtk.paths.database) as store:
        store.add("Original\nFull details")
        store.add("Existing work", tag="Work")
        store.add("Archived task", tag="Archived")
        store.transition(2, "start")
        store.transition(3, "done")
    window = gtk.open()
    assert window.tag_filter == "" and set(window.rows) == {1}
    window._prepare_filters()
    assert [item.get_label() for item in window.filter_menu.get_children()] == [
        "Untagged (1)",
        "All (2)",
        "#Archived (0)",
        "#Work (1)",
    ]
    window.entry.set_text("Unfinished new task")

    def select(menu, label):
        item = next(item for item in menu.get_children() if item.get_label() == label)
        # GTK ignores pointer activation during its submenu-opening grace period.
        ready = time.monotonic() + 0.6
        wait_until(gtk.glib, lambda: time.monotonic() >= ready)
        click_button(gtk, item.get_toplevel(), item)

    def context(note_id):
        # Switching filters resizes and moves the bottom-anchored window.
        wait_until(
            gtk.glib,
            lambda: (
                not window.geometry_source
                and window.scroll.get_allocated_height() == window.scroll.get_preferred_height()[1]
                and window.get_position()[1] + window.get_size().height == window.anchor_bottom
            ),
        )
        pointer_at(gtk, window, window.rows[note_id].body, 12, 8, "click", "3")
        wait_until(
            gtk.glib, lambda: window.context_menu is not None and window.context_menu.get_mapped()
        )
        assert window.rows[note_id].get_style_context().has_class("context-target")
        return window.context_menu

    def tag_menu(note_id):
        menu = context(note_id)
        tag = next(item for item in menu.get_children() if item.get_label() == "Tag")
        subprocess.run(["xdotool", "key", "End", "Right"], env=gtk.env, check=True, timeout=5)
        wait_until(gtk.glib, lambda: tag.get_submenu().get_mapped())
        assert window.rows[note_id].get_style_context().has_class("context-target")
        return tag.get_submenu()

    def filter_by(label):
        click_button(gtk, window, window.menu_button)
        wait_until(gtk.glib, lambda: window.menu.get_mapped())
        subprocess.run(["xdotool", "key", "Home", "Right"], env=gtk.env, check=True, timeout=5)
        wait_until(gtk.glib, lambda: window.filter_menu.get_mapped())
        select(window.filter_menu, label)
        wait_until(gtk.glib, lambda: not window.menu.get_mapped())

    for save in (False, True):
        menu = context(1)
        assert isinstance(menu, Gtk.Menu)
        select(menu, "Edit…")
        wait_until(gtk.glib, lambda: window.editor is not None)
        assert not window.rows[1].get_style_context().has_class("context-target")
        editor = window.editor
        buffer = editor.entry.get_buffer()
        assert buffer.get_text(*buffer.get_bounds(), True) == "Original\nFull details"
        buffer.set_text("<b>Edited 🐦</b>\n\nFull changed details")
        click_button(gtk, editor, editor.save_button if save else editor.cancel_button)
        wait_until(gtk.glib, lambda: window.editor is None and not window.pending)
        assert window.rows[1].body.get_text() == ("<b>Edited 🐦</b>" if save else "Original")
        assert not window.rows[1].body.get_use_markup()
        assert window.entry.get_text() == "Unfinished new task"
    select(tag_menu(1), "New tag…")
    wait_until(gtk.glib, lambda: window.editor is not None)
    editor = window.editor
    editor.entry.set_text("Personal 🐦")
    click_button(gtk, editor, editor.save_button)
    wait_until(gtk.glib, lambda: window.editor is None and not window.pending and not window.rows)
    assert window.empty.get_text() == "No untagged reminders."
    filter_by("#Personal 🐦 (1)")
    assert set(window.rows) == {1}
    assert [item.get_label() for item in window.filter_menu.get_children()] == [
        "Untagged (0)",
        "All (2)",
        "#Archived (0)",
        "#Personal 🐦 (1)",
        "#Work (1)",
    ]
    window.entry.emit("activate")
    wait_until(gtk.glib, lambda: not window.pending and set(window.rows) == {1, 4})
    assert window.rows[4].note.tag == "Personal 🐦"
    tags = tag_menu(1)
    assert [item.get_label() for item in tags.get_children()][:4] == [
        "Untagged (0)",
        "#Archived (0)",
        "#Personal 🐦 (2)",
        "#Work (1)",
    ]
    select(tags, "#Work (1)")
    wait_until(gtk.glib, lambda: not window.pending and set(window.rows) == {4})
    filter_by("All (3)")
    assert set(window.rows) == {1, 2, 4}
    select(tag_menu(1), "Untagged (0)")
    wait_until(gtk.glib, lambda: not window.pending and window.rows[1].note.tag is None)
    filter_by("Untagged (1)")
    assert set(window.rows) == {1}
    filter_by("All (3)")
    context(2)
    target = window.rows[2]
    assert target.get_style_context().has_class("in-progress")
    subprocess.run(["xdotool", "key", "Escape"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: window.context_menu is None)
    assert not target.get_style_context().has_class("context-target")
    assert target.get_style_context().has_class("in-progress")
    context(2)
    with Store(gtk.paths.database) as store:
        store.transition(2, "done")
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending and 2 not in window.rows)
    assert window.context_menu is None
    assert not target.get_style_context().has_class("context-target")
    window._prepare_filters()
    assert [item.get_label() for item in window.filter_menu.get_children()] == [
        "Untagged (1)",
        "All (2)",
        "#Archived (0)",
        "#Personal 🐦 (1)",
        "#Work (0)",
    ]
    application = window.get_application()
    window.close()
    wait_until(gtk.glib, lambda: window.closed)
    window.worker.shutdown(wait=True)
    window = gtk.open(application)
    assert window.tag_filter == "" and set(window.rows) == {1}
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history(1)] == [
            "add",
            "edit",
            "tag",
            "tag",
            "tag",
        ]
        assert store.history(1)[0]["text"] == "Original\nFull details"
        assert store.notes()[-1].tag == "Personal 🐦"


def test_scheduled_reminders_move_between_lists_and_catch_up_after_reopening(gtk, monkeypatch):
    clock = datetime.now(UTC)
    monkeypatch.setattr("pinote.store.timestamp", lambda: clock.isoformat(timespec="microseconds"))
    with Store(gtk.paths.database) as store:
        store.add("Call <literal> 🐦\nFull details")
    window = gtk.open()
    window.entry.set_text("Keep my draft")
    pointer_at(gtk, window, window.rows[1].body, 12, 8, "click", "3")
    wait_until(
        gtk.glib, lambda: window.context_menu is not None and window.context_menu.get_mapped()
    )
    item = next(
        item for item in window.context_menu.get_children() if item.get_label() == "Set reminder…"
    )
    ready = time.monotonic() + 0.6
    wait_until(gtk.glib, lambda: time.monotonic() >= ready)
    click_button(gtk, item.get_toplevel(), item)
    wait_until(gtk.glib, lambda: window.editor is not None)
    editor = window.editor
    assert editor.schedule_only and not editor.get_decorated()

    def set_time(editor, when):
        local = when.astimezone()
        editor.entry.select_month(local.month - 1, local.year)
        editor.entry.select_day(local.day)
        editor.hour.set_value(local.hour)
        editor.minute.set_value(local.minute)

    set_time(editor, clock - timedelta(days=1))
    click_button(gtk, editor, editor.save_button)
    wait_until(gtk.glib, lambda: not editor.saving and editor.error_text.get_visible())
    assert "future" in editor.error_text.get_text()
    due = (clock + timedelta(days=2)).replace(second=0, microsecond=0)
    set_time(editor, due)
    with display_lock(gtk.paths):
        click_button(gtk, editor, editor.save_button)
        wait_until(gtk.glib, lambda: not editor.saving and "busy" in editor.error_text.get_text())
    assert editor.entry.get_date().day == due.astimezone().day
    click_button(gtk, editor, editor.save_button)
    wait_until(gtk.glib, lambda: window.editor is None and not window.pending and not window.rows)
    assert window.entry.get_text() == "Keep my draft"
    click_button(gtk, window, window.menu_button)
    wait_until(gtk.glib, lambda: window.menu.get_mapped())
    ready = time.monotonic() + 0.6
    wait_until(gtk.glib, lambda: time.monotonic() >= ready)
    click_button(gtk, window.menu.get_toplevel(), window.reminders_button)
    wait_until(gtk.glib, lambda: window.scheduled_window is not None)
    reminders = window.scheduled_window
    wait_until(gtk.glib, lambda: not reminders.pending and 1 in reminders.rows)
    assert not reminders.get_decorated() and reminders.get_role() == "pinote-scheduled"
    row = reminders.rows[1]
    assert row.body.get_text() == "Call <literal> 🐦\nFull details"
    assert not row.body.get_use_markup()
    assert due.astimezone().strftime("%Y-%m-%d %H:%M") in row.date.get_text()
    before = row.note
    clock += timedelta(seconds=1)
    click_button(gtk, reminders, row.change)
    wait_until(gtk.glib, lambda: window.editor is not None)
    due += timedelta(days=1)
    set_time(window.editor, due)
    click_button(gtk, window.editor, window.editor.save_button)
    wait_until(
        gtk.glib,
        lambda: window.editor is None and reminders.rows[1].note.remind_at != before.remind_at,
    )
    click_button(gtk, reminders, reminders.rows[1].restore)
    wait_until(gtk.glib, lambda: not reminders.pending and not reminders.rows and 1 in window.rows)
    assert window.rows[1].note.state == "active"
    clock += timedelta(seconds=1)
    window._open_schedule(window.rows[1].note)
    set_time(window.editor, due)
    click_button(gtk, window.editor, window.editor.save_button)
    wait_until(gtk.glib, lambda: window.editor is None and not window.pending and not window.rows)
    reminders.close()
    wait_until(gtk.glib, lambda: reminders.closed)
    clock = due - timedelta(microseconds=1)
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert not window.rows
    clock = due
    # Only the main window's normal timer is running; the reminders window is closed.
    wait_until(gtk.glib, lambda: 1 in window.rows)
    assert window.rows[1].note.remind_at is None and not window.rows[1].done.get_active()
    clock += timedelta(seconds=1)
    window._open_schedule(window.rows[1].note)
    set_time(window.editor, due + timedelta(days=1))
    click_button(gtk, window.editor, window.editor.save_button)
    wait_until(gtk.glib, lambda: window.editor is None and not window.pending and not window.rows)
    application = window.get_application()
    window.close()
    wait_until(gtk.glib, lambda: window.closed)
    window.worker.shutdown(wait=True)
    clock = due + timedelta(days=2)
    window = gtk.open(application)
    assert set(window.rows) == {1} and window.rows[1].note.state == "active"
    with Store(gtk.paths.database) as store:
        assert store.scheduled_notes() == []
        assert [e["action"] for e in store.history(1)] == [
            "add",
            "schedule",
            "schedule",
            "restore",
            "schedule",
            "remind",
            "schedule",
            "remind",
        ]


@pytest.mark.parametrize("tag_only", [False, True])
def test_edit_and_new_tag_errors_keep_input_and_reject_stale_revision(gtk, tag_only):
    with Store(gtk.paths.database) as store:
        store.add("Keep original")
    window = gtk.open()
    window._open_editor(window.rows[1].note, tag_only=tag_only)
    editor = window.editor
    if tag_only:
        editor.entry.set_text("Changed tag")
    else:
        editor.entry.get_buffer().set_text("Changed text\nKeep this input")
    with display_lock(gtk.paths):
        click_button(gtk, editor, editor.save_button)
        wait_until(gtk.glib, lambda: not editor.saving and editor.error_text.get_visible())
    assert "busy" in editor.error_text.get_text()
    assert editor.save_button.get_sensitive()
    # A menu/editor may outlive its task. The stored revision, not the latest
    # polling snapshot, must decide whether this save can overwrite it.
    with Store(gtk.paths.database) as store:
        store.transition(1, "done")
    click_button(gtk, editor, editor.save_button)
    wait_until(
        gtk.glib, lambda: not editor.saving and "changed elsewhere" in editor.error_text.get_text()
    )
    if tag_only:
        assert editor.entry.get_text() == "Changed tag"
    else:
        buffer = editor.entry.get_buffer()
        assert buffer.get_text(*buffer.get_bounds(), True) == "Changed text\nKeep this input"
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add", "done"]
        assert store.archived_notes()[0].text == "Keep original"
    click_button(gtk, editor, editor.cancel_button)
    wait_until(gtk.glib, lambda: window.editor is None)


def test_committed_edit_closes_editor_even_if_list_refresh_fails(gtk, monkeypatch):
    with Store(gtk.paths.database) as store:
        store.add("Original")
    window = gtk.open()
    window._open_editor(window.rows[1].note)
    editor = window.editor
    editor.entry.get_buffer().set_text("Saved only once")

    def failed_read():
        raise sqlite3.OperationalError("refresh failed after edit")

    monkeypatch.setattr(window.model, "notes", failed_read)
    click_button(gtk, editor, editor.save_button)
    wait_until(gtk.glib, lambda: window.editor is None and not window.pending)
    assert (
        window.notice.get_visible() and "refresh failed after edit" in window.error_text.get_text()
    )
    with Store(gtk.paths.database) as store:
        assert store.notes()[0].text == "Saved only once"
        assert [event["action"] for event in store.history()] == ["add", "edit"]


def test_checkbox_starts_and_completes_with_real_clicks(gtk):
    with Store(gtk.paths.database) as store:
        store.add("Work on this task")
    window = gtk.open()
    row = window.rows[1]
    click_button(gtk, window, row.done)
    wait_until(gtk.glib, lambda: not window.pending and row.note.state == "in_progress")
    assert row.done.get_active() and row.done.get_inconsistent()
    assert row.get_style_context().has_class("in-progress")
    assert row.done.get_accessible().get_name() == "Complete note 1 (in progress)"
    assert not row.exiting
    # Text clicks must still focus the composer, not finish a progressing task.
    click_button(gtk, window, row.body)
    wait_until(gtk.glib, lambda: window.get_focus() is window.entry)
    assert row.note.state == "in_progress"
    click_button(gtk, window, row.done)
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    with Store(gtk.paths.database) as store:
        assert store.notes(all_states=True)[0].state == "done"
        assert [e["action"] for e in store.history()] == ["add", "start", "done"]


@pytest.mark.parametrize("progress", [False, True])
def test_checkbox_opposite_clicks_return_to_empty_before_marking_or_starting(gtk, progress):
    from pinote.gui.app import Gtk

    with Store(gtk.paths.database) as store:
        store.add("Delete only after confirmation")
        if progress:
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    if progress:
        assert "right-click to clear progress" in row.done.get_accessible().get_description()
        pointer_at(gtk, window, row.done, 10, 10, "click", "3")
        wait_until(gtk.glib, lambda: not window.pending and row.note.state == "active")
        assert not row.deletion_marked
        assert not row.done.get_active() and not row.done.get_inconsistent()
        assert not row.get_style_context().has_class("in-progress")
        assert not row.get_style_context().has_class("deletion-marked")
    with Store(gtk.paths.database) as store:
        saved = store.notes()[0]
        history = store.history()
        assert saved.state == "active"
        expected = ["add", "start", "reset"] if progress else ["add"]
        assert [event["action"] for event in history] == expected
    pointer_at(gtk, window, row.done, 10, 10, "click", "3")
    wait_until(gtk.glib, lambda: row.deletion_marked)
    assert not window.action_pending and not row.exiting
    assert row.done.get_active() and row.done.get_inconsistent()
    assert row.get_style_context().has_class("deletion-marked")
    assert row.done.get_accessible().get_name() == "Cancel deletion of note 1"
    assert "Right-click again to delete" in row.done.get_accessible().get_description()
    color = row.body.get_style_context().get_color(Gtk.StateFlags.NORMAL)
    assert (color.red, color.green, color.blue) == pytest.approx((240 / 255, 163 / 255, 174 / 255))
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.rows[1] is row and row.deletion_marked
    with Store(gtk.paths.database) as store:
        assert store.notes() == [saved] and store.history() == history
    click_button(gtk, window, row.done)
    wait_until(gtk.glib, lambda: not row.deletion_marked)
    assert not row.get_style_context().has_class("deletion-marked")
    assert not row.done.get_active() and not row.done.get_inconsistent()
    assert not row.get_style_context().has_class("in-progress")
    assert row.note.state == "active"
    assert row.done.get_accessible().get_name() == "Start note 1"
    with Store(gtk.paths.database) as store:
        assert store.notes() == [saved] and store.history() == history
    pointer_at(gtk, window, row.done, 10, 10, "click", "3")
    wait_until(gtk.glib, lambda: row.deletion_marked)
    pointer_at(gtk, window, row.done, 10, 10, "click", "3")
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    with Store(gtk.paths.database) as store:
        assert store.notes(all_states=True)[0].state == "removed"
        expected = [event["action"] for event in history] + ["rm"]
        assert [event["action"] for event in store.history()] == expected
        assert [note.id for note in store.archived_notes()] == [1]


def test_saved_progress_is_loaded_and_unchecked_polling_never_completes_it(gtk):
    with Store(gtk.paths.database) as store:
        store.add("Saved progress")
        store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    assert row.done.get_active() and row.done.get_inconsistent()
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.rows[1] is row and row.note.state == "in_progress"
    assert not row.exiting
    with Store(gtk.paths.database) as store:
        assert [e["action"] for e in store.history()] == ["add", "start"]


@pytest.mark.parametrize("action", ["start", "reset", "done", "rm"])
def test_failed_checkbox_action_preserves_task_and_confirmation(gtk, action):
    with Store(gtk.paths.database) as store:
        store.add("Busy progress")
        if action in {"reset", "done"}:
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    with display_lock(gtk.paths):
        if action == "reset":
            pointer_at(gtk, window, row.done, 10, 10, "click", "3")
        elif action == "rm":
            pointer_at(gtk, window, row.done, 10, 10, "click", "--repeat", "2", "3")
        else:
            click_button(gtk, window, row.done)
        wait_until(gtk.glib, lambda: not window.pending and window.notice.get_visible())
    assert row.deletion_marked == (action == "rm")
    assert row.done.get_active() == (action != "start")
    assert row.done.get_inconsistent() == (action != "start")
    assert row.get_style_context().has_class("in-progress") == (action in {"reset", "done"})
    assert row.get_style_context().has_class("deletion-marked") == (action == "rm")
    assert not row.exiting
    with Store(gtk.paths.database) as store:
        assert len(store.history()) == (2 if action in {"reset", "done"} else 1)


def test_pending_start_cannot_turn_a_second_click_into_completion(gtk, monkeypatch):
    with Store(gtk.paths.database) as store:
        store.add("Start just once")
    window = gtk.open()
    row = window.rows[1]
    started, release = threading.Event(), threading.Event()
    original = window.model.transition
    calls = []

    def slow_transition(note_id, action):
        calls.append(action)
        started.set()
        assert release.wait(timeout=5)
        return original(note_id, action)

    monkeypatch.setattr(window.model, "transition", slow_transition)
    try:
        row.done.clicked()
        assert started.wait(timeout=2)
        assert row.note.state == "active" and not row.exiting
        assert not row.done.get_sensitive()
        row.done.clicked()
        activate_note_action(row, "rm")
        assert not row.deletion_marked
        assert calls == ["start"]
    finally:
        release.set()
    wait_until(gtk.glib, lambda: not window.pending and row.note.state == "in_progress")
    assert row.done.get_active() and row.done.get_inconsistent() and not row.exiting
    with Store(gtk.paths.database) as store:
        assert [e["action"] for e in store.history()] == ["add", "start"]


@pytest.mark.parametrize("click_action", ["done", "reset"])
@pytest.mark.parametrize("external_action", ["restore", "done", "rm"])
def test_stale_progress_click_never_overrides_external_change(
    gtk, cli, click_action, external_action
):
    with Store(gtk.paths.database) as store:
        store.add("Another frontend changed this")
        store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    cli(external_action, "1", "--no-notify")
    assert row.note.state == "in_progress"
    if click_action == "reset":
        pointer_at(gtk, window, row.done, 10, 10, "click", "3")
    else:
        click_button(gtk, window, row.done)
    wait_until(gtk.glib, lambda: not window.pending)
    assert not row.exiting
    if external_action == "restore":
        assert window.rows[1].note.state == "active"
        assert not row.done.get_active() and not row.done.get_inconsistent()
    else:
        assert not window.rows
    with Store(gtk.paths.database) as store:
        assert [e["action"] for e in store.history()] == ["add", "start", external_action]


def test_no_tooltips_keep_accessible_names(gtk):
    with Store(gtk.paths.database) as store:
        store.add("No hover popup")
    window = gtk.open()
    widgets = [window]
    while widgets:
        widget = widgets.pop()
        assert not widget.get_has_tooltip()
        if hasattr(widget, "get_children"):
            widgets.extend(widget.get_children())
    assert window.rows[1].done.get_accessible().get_name() == "Start note 1"


@pytest.mark.parametrize("limit", [1, 3])
def test_configured_note_limit_grows_up_then_scrolls(gtk, limit):
    config = Path(gtk.env["XDG_CONFIG_HOME"]) / "pinote/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(f"[gui]\nmax_visible_notes = {limit}\n")
    window = gtk.open()
    monitor = window.get_display().get_monitor_at_window(window.get_window()).get_workarea()
    bottom = monitor.y + monitor.height - 25
    wait_until(gtk.glib, lambda: window.get_position()[1] + window.get_size().height == bottom)
    empty_height = window.get_size().height
    heights = []
    for count in range(1, limit + 3):
        with Store(gtk.paths.database) as store:
            store.add(f"Reminder {count}\nSecond line")
        window._poll()
        wait_until(gtk.glib, lambda count=count: len(window.rows) == count and not window.pending)
        expected_height = sum(
            row.get_preferred_height_for_width(window.list_box.get_allocated_width())[1]
            for row in window.list_box.get_children()[:limit]
        )
        wait_until(
            gtk.glib,
            lambda expected_height=expected_height: (
                window.scroll.get_allocated_height() == expected_height
                and window.get_position()[1] + window.get_size().height == bottom
            ),
        )
        heights.append(window.get_size().height)
    assert all(
        left < right for left, right in zip(heights[: limit - 1], heights[1:limit], strict=True)
    )
    assert heights[-1] == heights[-2] == heights[limit - 1]
    adjustment = window.scroll.get_vadjustment()
    wait_until(gtk.glib, lambda: adjustment.get_upper() > adjustment.get_page_size())
    with Store(gtk.paths.database) as store:
        for note in store.notes():
            store.transition(note.id, "rm")
    window._poll()
    wait_until(gtk.glib, lambda: not window.rows and window.get_size().height == empty_height)
    wait_until(gtk.glib, lambda: window.get_position()[1] + window.get_size().height == bottom)


@pytest.mark.parametrize("target", ["text", "row_gap", "panel", "empty", "composer"])
def test_non_button_click_focuses_entry_without_copying(gtk, target):
    from pinote.gui.app import Gdk, Gtk

    if target != "empty":
        with Store(gtk.paths.database) as store:
            store.add("Click here to type another task")
    window = gtk.open()
    wait_until(gtk.glib, lambda: window.scroll.get_allocated_height() > 1)
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.set_text("Leave clipboard alone", -1)
    window.menu_button.grab_focus()
    if target == "text":
        click_button(gtk, window, window.rows[1].body)
    elif target == "empty":
        click_button(gtk, window, window.empty)
    else:
        widget, x, y = {
            "row_gap": (window.rows.get(1), 29, 1),
            "panel": (window, 3, 3),
            "composer": (window.composer, window.entry_box.get_allocated_width() + 3, 8),
        }[target]
        pointer_at(gtk, window, widget, x, y, "click", "1")
    wait_until(gtk.glib, lambda: window.get_focus() is window.entry)
    assert clipboard.wait_for_text() == "Leave clipboard alone"
    with Store(gtk.paths.database) as store:
        assert all(event["action"] == "add" for event in store.history())


@pytest.mark.parametrize("first,last", [(0, 16), (16, 0), (0, 45)])
def test_drag_selection_copies_literal_unicode_on_release_then_focuses_entry(gtk, first, last):
    from pinote.gui.app import Gdk, Gtk, Pango

    # First logical lines still wrap; dragging across that wrap must copy literally.
    text = "Copy 🐦 <literal> " + "wrapped text " * 3 + "\nhidden details"
    with Store(gtk.paths.database) as store:
        store.add(text)
    window = gtk.open()
    label = window.rows[1].body
    wait_until(gtk.glib, lambda: label.get_allocated_height() > 1)
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.set_text("Unchanged during drag", -1)
    window.entry.set_text("Keep this draft")

    def move_to_index(index, *action):
        rect = label.get_layout().index_to_pos(len(text[:index].encode("utf-8")))
        layout_x, layout_y = label.get_layout_offsets()
        pointer_at(
            gtk,
            window,
            label,
            layout_x + rect.x // Pango.SCALE,
            layout_y + (rect.y + rect.height // 2) // Pango.SCALE,
            *action,
        )
        wait_until(gtk.glib, lambda: True)

    move_to_index(first, "mousedown", "1")
    move_to_index(last)
    wait_until(gtk.glib, lambda: label.get_selection_bounds()[0])
    assert window.get_focus() is not window.entry
    assert clipboard.wait_for_text() == "Unchanged during drag"
    _selected, start, end = label.get_selection_bounds()
    assert "🐦 <literal>" in text[start:end]
    move_to_index(last, "mouseup", "1")
    wait_until(gtk.glib, lambda: window.get_focus() is window.entry)
    assert clipboard.wait_for_text() == text[start:end]
    assert window.entry.get_text() == "Keep this draft"
    with Store(gtk.paths.database) as store:
        assert store.notes()[0].text == text
        assert len(store.history()) == 1


@pytest.mark.parametrize("action", ["done", "rm"])
def test_note_buttons_do_not_copy_or_redirect_focus(gtk, monkeypatch, action):
    from pinote.gui.app import Gdk, Gtk

    with Store(gtk.paths.database) as store:
        store.add("Selected text must not be copied by a button click")
        if action == "done":
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    row.body.select_region(0, -1)
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.set_text("Keep clipboard", -1)
    redirected = []
    monkeypatch.setattr(window, "_copy_and_focus", lambda label: redirected.append(label))
    if action == "rm":
        pointer_at(gtk, window, row.done, 10, 10, "click", "--repeat", "2", "3")
    else:
        click_button(gtk, window, row.done)
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    assert redirected == []
    assert clipboard.wait_for_text() == "Keep clipboard"
    with Store(gtk.paths.database) as store:
        expected = ["add", "start", "done"] if action == "done" else ["add", "rm"]
        assert [event["action"] for event in store.history()] == expected


def test_entry_selection_and_scrollbar_keep_native_behavior(gtk, monkeypatch):
    from pinote.gui.app import Gdk, Gtk

    with Store(gtk.paths.database) as store:
        for index in range(30):
            store.add(f"Reminder {index}")
    window = gtk.open()
    redirected = []
    monkeypatch.setattr(window, "_copy_and_focus", lambda label: redirected.append(label))
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.set_text("Keep clipboard", -1)
    window.entry.set_text("A draft to edit")
    pointer_at(gtk, window, window.entry, 8, 10, "mousedown", "1")
    wait_until(gtk.glib, lambda: True)
    pointer_at(gtk, window, window.entry, 55, 10, "mouseup", "1")
    wait_until(gtk.glib, lambda: bool(window.entry.get_buffer().get_selection_bounds()))
    assert clipboard.wait_for_text() == "Keep clipboard"
    assert redirected == []
    window.scroll.set_overlay_scrolling(False)
    scrollbar = window.scroll.get_vscrollbar()
    wait_until(gtk.glib, lambda: scrollbar.get_allocated_width() > 1)
    pointer_at(gtk, window, scrollbar, scrollbar.get_allocated_width() // 2, 15, "mousedown", "1")
    wait_until(gtk.glib, lambda: True)
    pointer_at(gtk, window, scrollbar, scrollbar.get_allocated_width() // 2, 80, "mouseup", "1")
    wait_until(gtk.glib, lambda: window.scroll.get_vadjustment().get_value() > 0)
    assert redirected == []
    assert clipboard.wait_for_text() == "Keep clipboard"


@pytest.mark.parametrize("concurrent_resize", [False, True])
def test_manual_move_becomes_new_bottom_anchor_for_growth(gtk, concurrent_resize):
    window = gtk.open()
    initial_height = window.get_size().height
    if concurrent_resize:
        # Reproduce a configure event coalescing a move with a size change:
        # GTK's previous configure record still has the earlier height.
        window._configured_geometry = (
            tuple(window.get_position()),
            (window.get_size().width, initial_height - 1),
        )
    window.move(160, 220)
    window.get_display().sync()
    # An already-queued idle resize can run before the move's configure-event.
    window._sync_geometry()
    wait_until(gtk.glib, lambda: tuple(window.get_position()) == (160, 220))
    bottom = 220 + initial_height
    with Store(gtk.paths.database) as store:
        for index in range(5):
            store.add(f"Reminder {index}")
    window._poll()
    wait_until(
        gtk.glib,
        lambda: (
            len(window.rows) == 5
            and window.get_size().height > initial_height
            and tuple(window.get_position()) == (160, bottom - window.get_size().height)
        ),
    )
    assert window.anchor_bottom == bottom


def test_manual_move_during_geometry_sync_is_not_undone(gtk, monkeypatch):
    window = gtk.open()
    position = window.get_position
    moved = False

    def move_after_read():
        nonlocal moved
        current = position()
        if not moved:
            moved = True
            # The X server can receive a drag after the idle callback reads
            # geometry, but before GTK dispatches its configure-event.
            window.move(160, 220)
            window.get_display().sync()
        return current

    with monkeypatch.context() as patch:
        patch.setattr(window, "get_position", move_after_read)
        window._sync_geometry()
    window.get_display().sync()
    wait_until(
        gtk.glib,
        lambda: (
            tuple(window.get_position()) == (160, 220)
            and window.anchor_x == 160
            and window.anchor_bottom == 220 + window.get_size().height
        ),
    )


def test_manual_move_before_initial_placement_ack_is_preserved(gtk, monkeypatch):
    from pinote.gui.app import ReminderWindow

    move = ReminderWindow.move
    manual_bottom = None

    def move_before_ack(window, x, y):
        nonlocal manual_bottom
        move(window, x, y)
        if window.get_mapped() and manual_bottom is None:
            # The requested placement is already visible to another X client,
            # which can move it before GTK receives the placement acknowledgement.
            window.get_display().sync()
            # Measure as an X client: GTK's cached size can still describe the
            # previous height until the configure event we are delaying arrives.
            _, _, _, height = window.get_window().get_geometry()
            manual_bottom = 220 + height
            move(window, 160, 220)
            window.get_display().sync()

    monkeypatch.setattr(ReminderWindow, "move", move_before_ack)
    window = gtk.open()
    assert manual_bottom is not None
    assert window.anchor_x == 160
    assert window.anchor_bottom == manual_bottom
    assert window.get_position()[0] == 160


def test_notice_grows_up_and_shrinks_without_moving_bottom(gtk):
    with Store(gtk.paths.database) as store:
        for index in range(35):
            store.add(f"Reminder {index}: " + "wrapped " * 80)
    window = gtk.open()
    initial_height = window.get_size().height
    initial_scroll = window.scroll.get_allocated_height()
    bottom = window.get_position()[1] + initial_height
    window._error("Busy.\nTry again.\nRun note to check saved state.", action=True)
    wait_until(
        gtk.glib,
        lambda: (
            window.notice.get_allocated_height() > 1
            and window.scroll.get_allocated_height() < initial_scroll
        ),
    )
    wait_until(gtk.glib, lambda: window.get_position()[1] + window.get_size().height == bottom)
    window.notice.hide()
    wait_until(gtk.glib, lambda: window.scroll.get_allocated_height() == initial_scroll)
    assert window.get_size().height == initial_height
    wait_until(gtk.glib, lambda: window.get_position()[1] + window.get_size().height == bottom)


def test_manual_position_survives_remap_and_activation(gtk):
    window = gtk.open()
    application = window.get_application()
    window.entry.set_text("Keep this unsaved draft")
    window.move(160, 220)
    wait_until(gtk.glib, lambda: tuple(window.get_position()) == (160, 220))
    maps = []
    window.connect("map-event", lambda *_args: maps.append(True))
    window.hide()
    wait_until(gtk.glib, lambda: not window.get_mapped())
    # A second launch dispatches this same activation to the existing instance.
    application.activate()
    # get_mapped() changes before the X11 map-event handler has run.
    wait_until(gtk.glib, lambda: bool(maps))
    assert application.get_windows() == [window]
    assert tuple(window.get_position()) == (160, 220)
    assert window.entry.get_text() == "Keep this unsaved draft"


def test_compact_window_fits_content_and_shrinks_after_removal(gtk):
    window = gtk.open()
    wait_until(gtk.glib, lambda: window.empty.get_allocated_height() > 1)
    empty_height = window.get_size().height
    assert empty_height < 100
    with Store(gtk.paths.database) as store:
        for index in range(35):
            store.add(f"Reminder {index}: " + "unbroken" * 100)
    window._poll()
    wait_until(gtk.glib, lambda: len(window.rows) == 35 and not window.pending)
    adjustment = window.scroll.get_vadjustment()
    wait_until(gtk.glib, lambda: adjustment.get_upper() > adjustment.get_page_size())
    assert window.get_size().width == 420
    monitor = window.get_display().get_monitor_at_window(window.get_window()).get_workarea()
    wait_until(gtk.glib, lambda: window.get_size().height > empty_height)
    assert window.get_size().height <= monitor.height - 50
    wait_until(
        gtk.glib,
        lambda: (
            window.get_position()[1] + window.get_size().height == monitor.y + monitor.height - 25
        ),
    )
    assert window.get_position()[1] >= monitor.y + 25
    with Store(gtk.paths.database) as store:
        for note in store.notes():
            store.transition(note.id, "rm")
    window._poll()
    wait_until(
        gtk.glib,
        lambda: not window.rows and window.get_size().height == empty_height,
    )
    assert window.empty.get_text() == "No active reminders."


def test_error_notice_keeps_task_entry_on_screen(gtk):
    window = gtk.open()
    monitor = window.get_display().get_monitor_at_window(window.get_window()).get_geometry()
    # Exercise growth near the bottom even on a tall test display.
    window.move(25, monitor.y + monitor.height - 140)
    window._error(
        "Another note command is busy. Try again.\nRun note to check saved state.", action=True
    )
    wait_until(gtk.glib, lambda: window.notice.get_allocated_height() > 1)
    wait_until(
        gtk.glib,
        lambda: window.get_position()[1] + window.get_size().height <= monitor.y + monitor.height,
    )
    assert window.entry.get_mapped()


def test_escape_closes_without_changing_notes(gtk, cli):
    cli("--no-notify", "Escape only hides the window")
    window = gtk.open()
    window.entry.set_text("Unsubmitted text must not become a task on close")
    result = subprocess.run(
        ["xdotool", "search", "--onlyvisible", "--name", "^pinote — Reminders$"],
        env=gtk.env,
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    subprocess.run(
        ["xdotool", "windowfocus", "--sync", result.stdout.strip(), "key", "Escape"],
        env=gtk.env,
        check=True,
        timeout=5,
    )
    wait_until(gtk.glib, lambda: window.closed)
    with Store(gtk.paths.database) as store:
        assert len(store.notes()) == 1
        assert len(store.history()) == 1


@pytest.mark.parametrize("desktop_rules", [False, True])
def test_i3_honors_popup_position_and_content_height(gtk, tmp_path, desktop_rules):
    if not shutil.which("i3") or not shutil.which("i3-msg"):
        pytest.skip("install i3 for window-manager placement coverage")
    # Xvfb and a private bus do not isolate i3's inherited IPC socket.
    socket = str(tmp_path / "i3.sock")
    env = {**gtk.env, "I3SOCK": socket}
    config = tmp_path / "i3.conf"
    # Reproduce desktops that override GTK's no-decoration hint. The specific
    # pinote rule must come AFTER general floating-window rules (see README).
    rules = ""
    if desktop_rules:
        rules = (
            "default_floating_border normal\n"
            "for_window [floating] border normal 0\n"
            'for_window [window_role="^pinote-"] floating enable, border none\n'
        )
    config.write_text(f"font pango:monospace 9\nipc-socket {socket}\n{rules}")
    window = None
    with (tmp_path / "i3.log").open("w") as output:
        process = subprocess.Popen(
            ["i3", "-a", "-c", str(config)], env=env, stdout=output, stderr=output
        )
        try:
            wait_until(gtk.glib, lambda: Path(socket).exists() or process.poll() is not None)
            assert process.poll() is None, (tmp_path / "i3.log").read_text()

            def tree():
                result = subprocess.run(
                    ["i3-msg", "-s", socket, "-t", "get_tree"],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=5,
                )
                return json.loads(result.stdout)

            tree()  # ensure this private WM is ready before mapping the popup
            with Store(gtk.paths.database) as store:
                for index in range(3):
                    store.add(
                        f"Reminder {index}" + ("\nPreview details\n" * 20 if index == 0 else "")
                    )
            window = gtk.open()
            monitor = window.get_display().get_monitor_at_window(window.get_window())
            geometry = monitor.get_workarea()
            screen_bottom = geometry.y + geometry.height

            def expected_position():
                return (25, screen_bottom - 25 - window.get_size().height)

            wait_until(gtk.glib, lambda: tuple(window.get_position()) == expected_position())
            assert window.get_size().width == 420
            assert window.get_size().height < 140
            nodes = [tree()]
            while nodes:
                node = nodes.pop()
                if node.get("name") == window.get_title():
                    assert node["floating"] == "auto_on"
                    assert node["border"] == "none"
                    assert node["deco_rect"]["height"] == 0
                    assert (node["rect"]["x"], node["rect"]["y"]) == expected_position()
                    break
                nodes.extend(node.get("nodes", []) + node.get("floating_nodes", []))
            else:
                pytest.fail("private i3 did not manage the popup")
            height = window.get_size().height
            click_button(gtk, window, window.rows[1].preview_button)
            wait_until(gtk.glib, lambda: window.preview is not None and window.preview.get_mapped())
            preview = window.preview
            area = preview.area
            x, y = preview.get_position()
            size = preview.get_size()
            assert area.x <= x and x + size.width <= area.x + area.width
            assert area.y <= y and y + size.height <= area.y + area.height
            assert size.height > height and window.get_size().height == height
            subprocess.run(["xdotool", "key", "Escape"], env=env, check=True, timeout=5)
            wait_until(gtk.glib, lambda: window.preview is None)
            assert not window.closed and tuple(window.get_position()) == expected_position()
            for kind in ("edit", "tag", "archive"):
                if kind == "archive":
                    window._open_archive()
                    child = window.archive_window
                else:
                    window._open_editor(window.rows[1].note, tag_only=kind == "tag")
                    child = window.editor
                assert not child.get_decorated() and child.get_titlebar() is None

                def managed_child(child=child):
                    nodes = [tree()]
                    while nodes:
                        node = nodes.pop()
                        if node.get("name") == child.get_title():
                            return node
                        nodes.extend(node.get("nodes", []) + node.get("floating_nodes", []))
                    return None

                wait_until(gtk.glib, lambda: managed_child() is not None)
                node = managed_child()
                assert node["border"] == "none", f"{kind} has an i3 titlebar"
                assert node["deco_rect"]["height"] == 0
                child.close()
                wait_until(gtk.glib, lambda child=child: child.closed)
            with Store(gtk.paths.database) as store:
                for index in range(30):
                    store.add(f"Extra reminder {index}")
            window._poll()
            adjustment = window.scroll.get_vadjustment()
            wait_until(
                gtk.glib,
                lambda: (
                    len(window.rows) == 33 and adjustment.get_upper() > adjustment.get_page_size()
                ),
            )
            assert window.get_size().height < geometry.height - 50
            wait_until(gtk.glib, lambda: tuple(window.get_position()) == expected_position())
            wait_until(
                gtk.glib,
                lambda: (
                    window.scroll.get_allocated_height()
                    == sum(
                        row.get_allocated_height()
                        for row in window.list_box.get_children()[: window.config.max_visible_notes]
                    )
                ),
            )
            with Store(gtk.paths.database) as store:
                for note in store.notes():
                    store.transition(note.id, "rm")
            window._poll()
            wait_until(gtk.glib, lambda: not window.rows and window.get_size().height < 100)
            wait_until(gtk.glib, lambda: tuple(window.get_position()) == expected_position())
            expected = expected_position()
            window.move(160, 220)
            wait_until(gtk.glib, lambda: tuple(window.get_position()) == (160, 220))

            def visible():
                result = subprocess.run(
                    ["xdotool", "search", "--onlyvisible", "--name", "^pinote — Reminders$"],
                    env=env,
                    capture_output=True,
                    timeout=5,
                )
                assert result.returncode in (0, 1), result.stderr
                return result.returncode == 0

            for workspace, viewable in (("2", False), ("1", True)):
                subprocess.run(
                    ["i3-msg", "-s", socket, f"workspace {workspace}"],
                    env=env,
                    capture_output=True,
                    check=True,
                    timeout=5,
                )
                wait_until(
                    gtk.glib,
                    lambda expected_viewable=viewable: visible() == expected_viewable,
                )
            assert tuple(window.get_position()) == (160, 220)
            window.move(*expected)
            wait_until(gtk.glib, lambda: tuple(window.get_position()) == expected)
            window._error(
                "Another note command is busy.\nRun note to check saved state.", action=True
            )
            wait_until(gtk.glib, lambda: window.notice.get_allocated_height() > 1)
            wait_until(
                gtk.glib,
                lambda: window.get_position()[1] + window.get_size().height <= screen_bottom,
            )
        finally:
            if window is not None and not window.closed:
                window.destroy()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.parametrize("submit", ["enter", "button"])
def test_add_task_from_entry_saves_literal_text_and_refreshes(gtk, cli, monkeypatch, submit):
    from pinote import notify

    notifications = []
    monkeypatch.setattr(notify, "show", lambda notes: notifications.append(notes))
    window = gtk.open()
    assert window.get_focus() is window.entry
    assert not window.add_button.get_sensitive()
    text = '<b>Literal & "quoted"</b> 🐦 $(not-a-command) \\n'
    window.entry.set_text(text)
    assert window.add_button.get_sensitive()
    if submit == "enter":
        result = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", "^pinote — Reminders$"],
            env=gtk.env,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        subprocess.run(
            ["xdotool", "windowfocus", "--sync", result.stdout.strip(), "key", "Return"],
            env=gtk.env,
            check=True,
            timeout=5,
        )
    else:
        click_button(gtk, window, window.add_button)
    wait_until(gtk.glib, lambda: not window.pending and 1 in window.rows)
    assert window.entry.get_text() == ""
    assert window.get_focus() is window.entry
    assert not window.add_button.get_sensitive()
    assert window.rows[1].body.get_text() == text
    assert not window.rows[1].body.get_use_markup()
    assert not window.notice.get_visible()
    assert notifications == []
    with Store(gtk.paths.database) as store:
        assert store.notes()[0].text == text
        assert [event["action"] for event in store.history()] == ["add"]
    assert text in cli("list").stdout


def test_editor_keeps_expanded_height_until_draft_is_cleared(gtk):
    window = gtk.open()
    single_height = window.entry_scroll.get_allocated_height()
    bottom = window.anchor_bottom

    def settled():
        wait_until(
            gtk.glib,
            lambda: (
                not window.geometry_source
                and window.entry_scroll.get_allocated_height()
                == window.entry_scroll.get_preferred_height()[1]
                and window.get_position()[1] + window.get_size().height == bottom
            ),
        )

    subprocess.run(
        ["xdotool", "search", "--name", "^pinote — Reminders$", "windowfocus", "--sync"],
        env=gtk.env,
        check=True,
        timeout=5,
    )
    window.entry.set_text("First line")
    buffer = window.entry.get_buffer()
    buffer.place_cursor(buffer.get_end_iter())
    subprocess.run(["xdotool", "key", "shift+Return"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: window.entry.get_text() == "First line\n")
    settled()
    expanded_height = window.entry_scroll.get_allocated_height()
    assert expanded_height > single_height
    heights = [expanded_height]

    def record_height(_scroll, allocation):
        if window.entry.get_text():
            heights.append(allocation.height)

    window.entry_scroll.connect("size-allocate", record_height)
    for key, expected in (
        ("a", "First line\na"),
        ("BackSpace", "First line\n"),
        ("BackSpace", "First line"),
    ):
        subprocess.run(["xdotool", "key", key], env=gtk.env, check=True, timeout=5)
        wait_until(gtk.glib, lambda expected=expected: window.entry.get_text() == expected)
        settled()
        assert window.entry_scroll.get_allocated_height() == expanded_height
    # Wrapped/pasted content can grow further, but stays bounded and never
    # collapses just because a selection was replaced with shorter text.
    buffer.insert_at_cursor("\n" + "wrapped content " * 100)
    settled()
    assert window.entry_scroll.get_allocated_height() == 82
    window.entry.set_text("Short replacement")
    settled()
    assert window.entry_scroll.get_allocated_height() == 82
    subprocess.run(["xdotool", "key", "ctrl+a", "BackSpace"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: window.entry.get_text() == "")
    settled()
    assert window.entry_scroll.get_allocated_height() == single_height
    assert all(left <= right for left, right in zip(heights[:-1], heights[1:], strict=True))
    with Store(gtk.paths.database) as store:
        assert store.notes() == [] and store.history() == []


def test_multiline_entry_and_read_only_preview(gtk):
    from pinote.gui.app import Gdk, Gtk, Pango

    with Store(gtk.paths.database) as store:
        store.add("Single line without a preview")
    window = gtk.open()
    bottom = window.anchor_bottom
    initial_height = window.get_size().height
    title = "<b>Literal title</b> 🐦"
    details = "\n" + "Details & more text\n" * 30 + "Last line\twith a tab"
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    window.entry.set_text(title)
    buffer = window.entry.get_buffer()
    buffer.place_cursor(buffer.get_end_iter())
    subprocess.run(
        [
            "xdotool",
            "search",
            "--name",
            "^pinote — Reminders$",
            "windowfocus",
            "--sync",
            "key",
            "shift+Return",
        ],
        env=gtk.env,
        check=True,
        timeout=5,
    )
    wait_until(gtk.glib, lambda: window.entry.get_text() == title + "\n")
    assert not window.pending and len(window.rows) == 1
    subprocess.run(["xdotool", "key", "Tab"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: window.get_focus() is window.add_button)
    subprocess.run(["xdotool", "key", "shift+Tab"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: window.get_focus() is window.entry)
    clipboard.set_text(details, -1)
    subprocess.run(["xdotool", "key", "ctrl+v"], env=gtk.env, check=True, timeout=5)
    text = title + "\n" + details
    wait_until(gtk.glib, lambda: window.entry.get_text() == text)
    adjustment = window.entry_scroll.get_vadjustment()
    wait_until(gtk.glib, lambda: adjustment.get_upper() > adjustment.get_page_size())
    wait_until(
        gtk.glib,
        lambda: (
            window.get_size().height > initial_height
            and window.get_position()[1] + window.get_size().height == bottom
        ),
    )
    assert window.entry_scroll.get_allocated_height() <= 82  # 80 px viewport + border
    subprocess.run(["xdotool", "key", "Return"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: not window.pending and 2 in window.rows)
    row = window.rows[2]
    assert row.body.get_text() == title and not row.body.get_use_markup()
    assert row.preview_button.get_visible()
    assert row.preview_button.get_accessible().get_name() == "Preview note 2"
    assert not window.rows[1].preview_button.get_visible()
    assert window.entry.get_text() == "" and window.placeholder.get_visible()
    wait_until(
        gtk.glib,
        lambda: (
            window.entry_scroll.get_allocated_height() < 40
            and window.reveal_note_id is None
            and not window.geometry_source
            and window.scroll.get_allocated_height() == window.scroll.get_preferred_height()[1]
        ),
    )
    # The entry can collapse one allocation before the new row grows the list.
    # Measure only after both have settled, so preview alone is tested for resizing.
    height = window.get_size().height
    click_button(gtk, window, row.preview_button)
    wait_until(gtk.glib, lambda: window.preview is not None and window.preview.get_mapped())
    preview = window.preview
    assert preview.body.get_text() == text
    assert preview.body.get_selectable() and not preview.body.get_use_markup()
    adjustment = preview.scroll.get_vadjustment()
    wait_until(gtk.glib, lambda: adjustment.get_upper() > adjustment.get_page_size())
    assert preview.scroll.get_allocated_height() == 300
    assert preview.scroll.get_allocated_width() >= 340
    assert isinstance(preview, Gtk.Window) and preview.get_window() != window.get_window()
    assert preview.get_size().height > height  # Not clipped to the short checklist's surface.
    assert window.get_size().height == height
    clipboard.set_text("Unchanged until copied", -1)
    for index, action in ((0, "mousedown"), (len(title) + 12, "mouseup")):
        rect = preview.body.get_layout().index_to_pos(len(text[:index].encode("utf-8")))
        layout_x, layout_y = preview.body.get_layout_offsets()
        pointer_at(
            gtk,
            preview,
            preview.body,
            layout_x + rect.x // Pango.SCALE,
            layout_y + (rect.y + rect.height // 2) // Pango.SCALE,
            action,
            "1",
        )
        wait_until(gtk.glib, lambda: True)
    assert preview.get_focus() is preview.body
    assert preview.body.get_selection_bounds()[0]
    assert clipboard.wait_for_text() == "Unchanged until copied"
    subprocess.run(["xdotool", "key", "ctrl+a"], env=gtk.env, check=True, timeout=5)
    subprocess.run(["xdotool", "key", "ctrl+c"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: clipboard.wait_for_text() == text)
    adjustment.set_value(80)
    before = adjustment.get_value()
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.preview is preview and preview.body.get_selection_bounds()[0]
    assert adjustment.get_value() == before
    subprocess.run(["xdotool", "key", "Escape"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: window.preview is None)
    assert not window.closed and window.get_focus() is window.entry
    click_button(gtk, window, row.preview_button)
    wait_until(gtk.glib, lambda: window.preview is not None and window.preview.get_mapped())
    pointer_at(gtk, window, window, 3, 3, "click", "1")
    wait_until(gtk.glib, lambda: window.preview is None)
    assert not window.closed
    with Store(gtk.paths.database) as store:
        assert store.notes()[1].text == text
        assert [event["action"] for event in store.history(2)] == ["add"]
    click_button(gtk, window, row.preview_button)
    wait_until(gtk.glib, lambda: window.preview is not None and window.preview.get_mapped())
    with Store(gtk.paths.database) as store:
        store.transition(2, "rm")
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending and 2 not in window.rows)
    assert window.preview is None and not window.closed
    assert Gtk.grab_get_current() is None
    with Store(gtk.paths.database) as store:
        store.transition(2, "restore")
    window._poll()
    wait_until(
        gtk.glib,
        lambda: (
            not window.pending
            and 2 in window.rows
            and not window.geometry_source
            and window.scroll.get_allocated_height()
            == sum(
                row.get_preferred_height_for_width(window.list_box.get_allocated_width())[1]
                for row in window.rows.values()
            )
            and window.get_position()[1] + window.get_size().height == bottom
        ),
    )
    click_button(gtk, window, window.rows[2].preview_button)
    wait_until(gtk.glib, lambda: window.preview is not None and window.preview.get_mapped())
    preview = window.preview
    window.close()
    wait_until(gtk.glib, lambda: window.closed)
    assert window.preview is None and not preview.get_visible()
    assert not preview.grabbed and Gtk.grab_get_current() is None


@pytest.mark.parametrize("limit", [1, 10])
def test_saved_add_scrolls_to_new_row_but_background_changes_preserve_scroll(gtk, cli, limit):
    config = Path(gtk.env["XDG_CONFIG_HOME"]) / "pinote/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(f"[gui]\nmax_visible_notes = {limit}\n")
    with Store(gtk.paths.database) as store:
        for index in range(25):
            store.add(f"Reminder {index}")
    window = gtk.open()
    adjustment = window.scroll.get_vadjustment()
    wait_until(gtk.glib, lambda: adjustment.get_upper() > adjustment.get_page_size())
    assert adjustment.get_value() == 0
    window.entry.set_text("Show the newly saved note\nFull details")
    click_button(gtk, window, window.add_button)
    wait_until(
        gtk.glib,
        lambda: not window.pending and 26 in window.rows and window.reveal_note_id is None,
    )
    allocation = window.rows[26].get_allocation()
    assert adjustment.get_value() > 0
    assert allocation.y >= adjustment.get_value()
    assert allocation.y + allocation.height <= adjustment.get_value() + adjustment.get_page_size()
    before = adjustment.get_value()
    cli("--no-notify", "Added in the background")
    wait_until(gtk.glib, lambda: 27 in window.rows)
    assert adjustment.get_value() == before
    adjustment.set_value(0)
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert adjustment.get_value() == 0


def test_blank_and_invalid_add_keep_input_without_saving(gtk):
    window = gtk.open()
    window.entry.set_text("   ")
    window.entry.emit("activate")
    assert not window.add_button.get_sensitive() and not window.pending
    text = "x" * 4097
    window.entry.set_text(text)
    assert window.entry.get_text() == text  # never silently truncate a long paste
    window.entry.emit("activate")
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.entry.get_text() == text
    assert window.notice.get_visible() and "4096" in window.error_text.get_text()
    assert window.add_button.get_sensitive()
    with Store(gtk.paths.database) as store:
        assert store.notes() == [] and store.history() == []


def test_busy_add_keeps_draft_and_can_be_retried(gtk):
    window = gtk.open()
    draft = "Keep this draft\nIncluding its details"
    window.entry.set_text(draft)
    with display_lock(gtk.paths):
        window.entry.emit("activate")
        wait_until(gtk.glib, lambda: not window.pending)
        assert window.notice.get_visible() and "busy" in window.error_text.get_text()
        assert window.entry.get_text() == draft
        assert window.add_button.get_sensitive()
    with Store(gtk.paths.database) as store:
        assert store.notes() == [] and store.history() == []
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.notice.get_visible() and window.entry.get_text() == draft
    window.entry.emit("activate")
    wait_until(gtk.glib, lambda: not window.pending and 1 in window.rows)
    assert window.entry.get_text() == "" and not window.notice.get_visible()
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add"]


def test_saved_add_clears_draft_even_when_refresh_fails(gtk, monkeypatch):
    window = gtk.open()
    original = window.model.notes

    def broken_read():
        raise sqlite3.OperationalError("refresh failed after save")

    monkeypatch.setattr(window.model, "notes", broken_read)
    window.entry.set_text("Save only once")
    window.entry.emit("activate")
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.notice.get_visible()
    assert "refresh failed after save" in window.error_text.get_text()
    assert window.entry.get_text() == "" and not window.add_button.get_sensitive()
    window.entry.emit("activate")
    assert not window.pending
    with Store(gtk.paths.database) as store:
        assert [note.text for note in store.notes()] == ["Save only once"]
        assert [event["action"] for event in store.history()] == ["add"]
    monkeypatch.setattr(window.model, "notes", original)
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending and 1 in window.rows)
    assert not window.notice.get_visible()


@pytest.mark.parametrize("next_text", ["A second draft\nMore details", "First draft"])
def test_pending_add_blocks_duplicates_and_preserves_new_edits(gtk, monkeypatch, next_text):
    window = gtk.open()
    started, release = threading.Event(), threading.Event()
    original = window.model.add
    calls = []
    main_thread = threading.get_ident()

    def slow_add(text):
        assert threading.get_ident() != main_thread
        calls.append(text)
        started.set()
        assert release.wait(timeout=5)
        return original(text)

    monkeypatch.setattr(window.model, "add", slow_add)
    window.entry.set_text("First draft")
    try:
        window.entry.emit("activate")
        assert started.wait(timeout=2)
        assert window.action_pending and not window.add_button.get_sensitive()
        assert window.entry.get_sensitive()
        window.entry.set_text("Editing while saving")
        window.entry.set_text(next_text)
        window.entry.emit("activate")
        window.add_button.clicked()
        assert calls == ["First draft"]
    finally:
        release.set()
    wait_until(gtk.glib, lambda: not window.pending and 1 in window.rows)
    assert window.entry.get_text() == next_text
    assert window.add_button.get_sensitive()
    window.entry.emit("activate")
    wait_until(gtk.glib, lambda: not window.pending and 2 in window.rows)
    assert calls == ["First draft", next_text]
    assert window.entry.get_text() == ""
    with Store(gtk.paths.database) as store:
        assert [note.text for note in store.notes()] == ["First draft", next_text]
        assert [event["action"] for event in store.history()] == ["add", "add"]


def test_add_during_a_departing_row_preserves_animation_and_order(gtk, animations, monkeypatch):
    from pinote.gui.app import NoteRow

    monkeypatch.setattr(NoteRow, "DONE_HOLD_MS", 10000)
    with Store(gtk.paths.database) as store:
        store.add("Finish this")
        store.add("Keep this")
        store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    row.done.clicked()
    wait_until(gtk.glib, lambda: not window.pending)
    assert row.exiting
    window.entry.set_text("Added during the animation")
    window.add_button.clicked()
    wait_until(gtk.glib, lambda: not window.pending and 3 in window.rows)
    assert window.rows[1] is row and row.exiting
    assert [child.note.id for child in window.list_box.get_children()] == [1, 2, 3]
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == [
            "add",
            "add",
            "start",
            "done",
            "add",
        ]


def test_menu_archive_lists_dates_restores_and_closes_independently(gtk, cli, monkeypatch):
    from datetime import datetime

    from pinote import notify

    notifications = []
    monkeypatch.setattr(notify, "show", lambda notes: notifications.append(notes))
    text = "<b>Completed & literal</b> 🐦\nSecond line"
    cli("--no-notify", text)
    cli("--no-notify", "Deleted task")
    cli("done", "1", "--no-notify")
    cli("rm", "2", "--no-notify")
    window = gtk.open()
    height = window.get_size().height
    click_button(gtk, window, window.menu_button)
    wait_until(gtk.glib, lambda: window.menu.get_mapped())
    assert window.get_size().height == height
    subprocess.run(["xdotool", "key", "Escape"], env=gtk.env, check=True, timeout=5)
    wait_until(gtk.glib, lambda: not window.menu.get_visible())
    assert not window.closed
    click_button(gtk, window, window.menu_button)
    click_button(gtk, window.archive_button.get_toplevel(), window.archive_button)
    wait_until(gtk.glib, lambda: window.archive_window is not None)
    archive = window.archive_window
    wait_until(
        gtk.glib,
        lambda: not archive.pending and len(archive.rows) == 2 and not window.menu.get_visible(),
    )
    assert archive.get_transient_for() is window and archive.get_resizable()
    assert not archive.get_decorated() and archive.get_titlebar() is None
    assert archive.get_role() == "pinote-archive"
    assert [row.note.id for row in archive.list_box.get_children()] == [2, 1]
    assert archive.rows[1].body.get_text() == text
    assert not archive.rows[1].body.get_use_markup()
    for note_id, status in ((1, "Completed"), (2, "Deleted")):
        row = archive.rows[note_id]
        date = datetime.fromisoformat(row.note.updated_at).astimezone()
        assert row.date.get_text() == f"{status} · {date:%Y-%m-%d %H:%M:%S %Z}"
        assert row.restore.get_accessible().get_name() == f"Restore note {note_id}"
    retained = archive.rows[1]
    retained.body.select_region(0, 10)
    archive._poll()
    wait_until(gtk.glib, lambda: not archive.pending)
    assert archive.rows[1] is retained and retained.body.get_selection_bounds()[0]
    click_button(gtk, archive, archive.rows[2].restore)
    wait_until(gtk.glib, lambda: not archive.pending and 2 not in archive.rows and 2 in window.rows)
    assert window.rows[2].note.state == "active" and not window.rows[2].done.get_active()
    assert notifications == []
    window._open_archive()
    assert window.archive_window is archive and len(window.get_application().get_windows()) == 2
    presented = []
    with monkeypatch.context() as patch:
        patch.setattr(window, "present", lambda: presented.append(window))
        window.get_application().activate()
    assert presented == [window]  # Relaunch presents the checklist, not the archive.
    click_button(gtk, archive, archive.close_button)
    wait_until(gtk.glib, lambda: archive.closed)
    assert not window.closed
    window._open_archive()
    reopened = window.archive_window
    wait_until(gtk.glib, lambda: not reopened.pending and 1 in reopened.rows)
    assert reopened is not archive
    cli("done", "2", "--no-notify")
    wait_until(gtk.glib, lambda: 2 in reopened.rows and 2 not in window.rows)
    # The transient archive can cover its parent; expose the actual menu before clicking it.
    reopened.move(600, 100)
    wait_until(gtk.glib, lambda: tuple(reopened.get_position()) == (600, 100))
    click_button(gtk, window, window.menu_button)
    wait_until(gtk.glib, lambda: window.menu.get_mapped())
    click_button(gtk, window.close_menu_button.get_toplevel(), window.close_menu_button)
    wait_until(gtk.glib, lambda: window.closed and reopened.closed)
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history(2)] == ["add", "rm", "restore", "done"]


@pytest.mark.parametrize("action", ["done", "rm"])
def test_archive_restore_during_exit_is_retryable_and_preserves_draft(
    gtk, animations, monkeypatch, action
):
    from pinote.gui.app import NoteRow

    monkeypatch.setattr(NoteRow, "DONE_HOLD_MS", 10000)
    monkeypatch.setattr(NoteRow, "EXIT_MS", 10000)
    with Store(gtk.paths.database) as store:
        store.add("Bring this task back")
        store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    if action == "rm":
        pointer_at(gtk, window, row.done, 10, 10, "click", "3")
        wait_until(gtk.glib, lambda: not window.pending and row.note.state == "active")
        pointer_at(gtk, window, row.done, 10, 10, "click", "--repeat", "2", "3")
    else:
        click_button(gtk, window, row.done)
    wait_until(gtk.glib, lambda: not window.pending and row.exiting)
    window.entry.set_text("Keep this unsubmitted draft")
    window._open_archive()
    archive = window.archive_window
    wait_until(gtk.glib, lambda: not archive.pending and 1 in archive.rows)
    restore = archive.rows[1].restore
    with display_lock(gtk.paths):
        click_button(gtk, archive, restore)
        wait_until(gtk.glib, lambda: not archive.pending and archive.notice.get_visible())
    assert "busy" in archive.error_text.get_text()
    assert restore.get_sensitive() and row.exiting
    original = window.model.restore
    started, release = threading.Event(), threading.Event()
    main_thread = threading.get_ident()

    def slow_restore(note):
        assert threading.get_ident() != main_thread
        started.set()
        assert release.wait(timeout=5)
        return original(note)

    monkeypatch.setattr(window.model, "restore", slow_restore)
    try:
        click_button(gtk, archive, restore)
        wait_until(gtk.glib, started.is_set)
        assert archive.action_pending and not restore.get_sensitive()
        restore.clicked()
        assert archive.pending == 1
    finally:
        release.set()
    wait_until(gtk.glib, lambda: not archive.pending and not archive.rows and not row.exiting)
    assert window.rows[1] is row and row.note.state == "active"
    assert row.done.get_sensitive()
    assert not row.done.get_active() and not row.done.get_inconsistent()
    assert not row.get_style_context().has_class("completed")
    assert not row.get_style_context().has_class("leaving")
    assert not row.pause_source and not row.settings_handler
    row.revealer.notify("child-revealed")
    assert window.rows[1] is row
    assert window.entry.get_text() == "Keep this unsubmitted draft"
    assert archive.empty.get_visible() and not archive.notice.get_visible()
    with Store(gtk.paths.database) as store:
        expected = ["add", "start", "reset"] if action == "rm" else ["add", "start"]
        assert [event["action"] for event in store.history()] == [*expected, action, "restore"]


def test_stale_archive_restore_reports_conflict_without_resetting_progress(gtk):
    with Store(gtk.paths.database) as store:
        store.add("Changed elsewhere")
        store.transition(1, "rm")
    window = gtk.open()
    window._open_archive()
    archive = window.archive_window
    wait_until(gtk.glib, lambda: not archive.pending and 1 in archive.rows)
    with Store(gtk.paths.database) as store:
        store.transition(1, "restore")
        store.transition(1, "start")
    archive.rows[1].restore.clicked()  # Click the stale row before the next poll.
    wait_until(gtk.glib, lambda: not archive.pending and not archive.rows)
    assert archive.notice.get_visible() and "changed elsewhere" in archive.error_text.get_text()
    wait_until(gtk.glib, lambda: 1 in window.rows and window.rows[1].note.state == "in_progress")
    archive._poll()
    wait_until(gtk.glib, lambda: not archive.pending)
    assert archive.notice.get_visible()
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add", "rm", "restore", "start"]


def test_saved_archive_restore_is_not_retryable_when_refresh_fails(gtk, monkeypatch):
    with Store(gtk.paths.database) as store:
        store.add("Restore once")
        store.transition(1, "rm")
    window = gtk.open()
    window._open_archive()
    archive = window.archive_window
    wait_until(gtk.glib, lambda: not archive.pending and 1 in archive.rows)

    def broken_snapshot():
        raise sqlite3.OperationalError("archive refresh failed")

    monkeypatch.setattr(window.model, "archive", broken_snapshot)
    archive.rows[1].restore.clicked()
    wait_until(gtk.glib, lambda: not archive.pending and archive.notice.get_visible())
    assert not archive.rows and "archive refresh failed" in archive.error_text.get_text()
    wait_until(gtk.glib, lambda: 1 in window.rows)
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add", "rm", "restore"]


@pytest.mark.parametrize("close_parent", [False, True])
def test_closing_archive_or_checklist_drains_accepted_restore(gtk, monkeypatch, close_parent):
    with Store(gtk.paths.database) as store:
        store.add("Finish this restore even while closing")
        store.transition(1, "rm")
    window = gtk.open()
    window._open_archive()
    archive = window.archive_window
    wait_until(gtk.glib, lambda: not archive.pending and 1 in archive.rows)
    started, release, saved = threading.Event(), threading.Event(), threading.Event()
    original_read, original_restore = window.model.archive, window.model.restore

    def slow_read():
        started.set()
        assert release.wait(timeout=5)
        return original_read()

    def restore(note):
        result = original_restore(note)
        saved.set()
        return result

    monkeypatch.setattr(window.model, "archive", slow_read)
    monkeypatch.setattr(window.model, "restore", restore)
    try:
        archive._poll()
        assert started.wait(timeout=2)
        archive.rows[1].restore.clicked()
        (window if close_parent else archive).close()
        wait_until(gtk.glib, lambda: archive.closed)
        assert window.closed == close_parent
        assert gtk.glib.MainContext.default().find_source_by_id(archive.refresh_source) is None
    finally:
        release.set()
    assert saved.wait(timeout=3)
    with Store(gtk.paths.database) as store:
        assert store.notes()[0].state == "active"
        assert [event["action"] for event in store.history()] == ["add", "rm", "restore"]


@pytest.mark.parametrize("action", ["done", "rm"])
def test_click_animates_after_save_with_real_fade_and_collapse(
    gtk, animations, monkeypatch, action
):
    from pinote.gui.app import Gtk, NoteRow

    monkeypatch.setattr(NoteRow, "EXIT_MS", 500)
    with Store(gtk.paths.database) as store:
        store.add("Animate this reminder\nwith a second line")
        store.add("Keep this one")
        if action == "done":
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    wait_until(gtk.glib, lambda: row.get_allocated_height() > 1)
    height = row.get_allocated_height()
    samples = []

    def sample(_widget, _clock):
        opacity = row.content.get_style_context().get_property("opacity", Gtk.StateFlags.NORMAL)
        samples.append((row.get_allocated_height(), opacity))
        return True

    row.add_tick_callback(sample)
    original = window.model.transition
    started, release = threading.Event(), threading.Event()

    def slow_save(note_id, operation):
        started.set()
        assert release.wait(timeout=5)
        return original(note_id, operation)

    monkeypatch.setattr(window.model, "transition", slow_save)
    try:
        activate_note_action(row, action)
        assert started.wait(timeout=2)
        assert not row.exiting
        assert not row.get_style_context().has_class("completed")
        assert row.get_allocated_height() == height
    finally:
        release.set()
    wait_until(gtk.glib, lambda: not window.pending)
    assert row.exiting and window.rows[1] is row
    assert not row.done.get_sensitive()
    assert row.get_style_context().has_class("completed") == (action == "done")
    assert row.get_style_context().has_class("deletion-marked") == (action == "rm")
    assert row.done.get_active()
    assert row.done.get_inconsistent() == (action == "rm")
    assert window.rows[2].done.get_sensitive()  # animations do not block other notes
    assert window.list_box.get_accessible().get_name() == "Reminders, 1 active note"
    with Store(gtk.paths.database) as store:
        assert store.notes(all_states=True)[0].state == ("done" if action == "done" else "removed")
        expected = ["add", "start", "done"] if action == "done" else ["add", "rm"]
        assert [event["action"] for event in store.history(1)] == expected
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.rows[1] is row and row.exiting  # polling must not destroy/restart it
    wait_until(gtk.glib, lambda: 1 not in window.rows)
    assert any(0 < size < height for size, _opacity in samples)
    assert any(0 < opacity < 1 for _size, opacity in samples)
    assert not row.pause_source and not row.settings_handler
    assert [child.note.id for child in window.list_box.get_children()] == [2]


@pytest.mark.parametrize("phase", ["highlight", "collapse"])
def test_restore_and_insert_during_animation_preserve_rows_and_order(
    gtk, animations, monkeypatch, cli, phase
):
    from pinote.gui.app import Gtk, NoteRow

    monkeypatch.setattr(NoteRow, "DONE_HOLD_MS", 2000 if phase == "highlight" else 0)
    monkeypatch.setattr(NoteRow, "EXIT_MS", 2000)
    with Store(gtk.paths.database) as store:
        for index in range(4):
            store.add(f"Reminder {index}")
        store.transition(1, "rm")
        store.transition(3, "start")
    window = gtk.open()
    row, unchanged = window.rows[3], window.rows[2]
    row.done.clicked()
    wait_until(gtk.glib, lambda: not window.pending)
    assert row.exiting
    if phase == "collapse":
        wait_until(gtk.glib, lambda: not row.revealer.get_reveal_child())
    pause_source = row.pause_source
    cli("restore", "1", "--no-notify")
    cli("--no-notify", "New last note")
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending and 5 in window.rows)
    assert row.exiting
    assert [child.note.id for child in window.list_box.get_children()] == [1, 2, 3, 4, 5]
    cli("restore", "3", "--no-notify")
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending and not row.exiting)
    assert window.rows[3] is row and window.rows[2] is unchanged
    assert row.done.get_sensitive() and not row.done.get_active()
    assert row.revealer.get_reveal_child() and row.revealer.get_child_revealed()
    assert not row.get_style_context().has_class("completed")
    assert not row.get_style_context().has_class("leaving")
    assert row.content.get_style_context().get_property("opacity", Gtk.StateFlags.NORMAL) == 1
    assert not row.pause_source and not row.settings_handler
    if pause_source:
        assert gtk.glib.MainContext.default().find_source_by_id(pause_source) is None
    # Late revealer notifications must not remove a now-active row.
    row.revealer.notify("child-revealed")
    assert window.rows[3] is row
    with Store(gtk.paths.database) as store:
        assert [note.id for note in store.notes()] == [1, 2, 3, 4, 5]


@pytest.mark.parametrize("external_action", ["done", "rm"])
@pytest.mark.parametrize("click_action", ["start", "done", "rm"])
def test_stale_click_does_not_animate_or_write(
    gtk, animations, cli, monkeypatch, external_action, click_action
):
    cli("--no-notify", "Changed before the next poll")
    if click_action == "done":
        with Store(gtk.paths.database) as store:
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    dismissed = []
    original = row.dismiss

    def record_dismissal(action, callback):
        dismissed.append(action)
        original(action, callback)

    monkeypatch.setattr(row, "dismiss", record_dismissal)
    cli(external_action, "1", "--no-notify")
    assert window.rows[1] is row  # the CLI change has not been rendered yet
    activate_note_action(row, click_action)
    wait_until(gtk.glib, lambda: not window.pending)
    assert dismissed == []
    assert not window.rows and not window.list_box.get_children()
    with Store(gtk.paths.database) as store:
        expected = ["add", "start"] if click_action == "done" else ["add"]
        assert [event["action"] for event in store.history()] == [*expected, external_action]


@pytest.mark.parametrize("action", ["done", "rm"])
def test_disabled_animations_remove_immediately(gtk, animations, action):
    animations.set_property("gtk-enable-animations", False)
    with Store(gtk.paths.database) as store:
        store.add("No motion")
        if action == "done":
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    activate_note_action(row, action)
    wait_until(gtk.glib, lambda: not window.pending)
    assert not window.rows and not window.list_box.get_children()
    assert not row.pause_source and not row.settings_handler
    assert not row.get_style_context().has_class("completed")
    assert not row.get_style_context().has_class("leaving")
    assert window.empty.get_visible()
    with Store(gtk.paths.database) as store:
        expected = ["add", "start", "done"] if action == "done" else ["add", "rm"]
        assert [event["action"] for event in store.history()] == expected


@pytest.mark.parametrize("action", ["done", "rm"])
@pytest.mark.parametrize("finish", ["close", "disable"])
def test_close_or_disable_during_animation_cleans_up(gtk, animations, monkeypatch, action, finish):
    from pinote.gui.app import NoteRow

    monkeypatch.setattr(NoteRow, "DONE_HOLD_MS", 10000)
    monkeypatch.setattr(NoteRow, "EXIT_MS", 10000)
    with Store(gtk.paths.database) as store:
        store.add("Already saved")
        if action == "done":
            store.transition(1, "start")
    window = gtk.open()
    row = window.rows[1]
    activate_note_action(row, action)
    wait_until(gtk.glib, lambda: not window.pending)
    assert row.exiting
    pause_source, settings_handler = row.pause_source, row.settings_handler
    assert settings_handler
    if finish == "close":
        window.close()
        wait_until(gtk.glib, lambda: window.closed)
    else:
        animations.set_property("gtk-enable-animations", False)
        assert not window.rows
    assert not row.exiting and not row.pause_source and not row.settings_handler
    assert not animations.handler_is_connected(settings_handler)
    if pause_source:
        assert gtk.glib.MainContext.default().find_source_by_id(pause_source) is None
    with Store(gtk.paths.database) as store:
        assert store.notes() == []
        expected = ["add", "start", "done"] if action == "done" else ["add", "rm"]
        assert [event["action"] for event in store.history()] == expected


def test_multiple_clicks_do_not_resubmit_departing_rows(gtk, animations, monkeypatch):
    from pinote.gui.app import NoteRow

    monkeypatch.setattr(NoteRow, "EXIT_MS", 600)
    with Store(gtk.paths.database) as store:
        store.add("Complete")
        store.add("Archive")
        store.transition(1, "start")
    window = gtk.open()
    window.rows[1].done.clicked()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.rows[1].exiting
    window._act(1, "rm")  # a disappearing Done row must never be re-archived
    assert not window.pending
    activate_note_action(window.rows[2], "rm")
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    assert window.empty.get_visible()
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == [
            "add",
            "add",
            "start",
            "done",
            "rm",
        ]


def test_buttons_save_history_literal_text_and_refresh_from_cli(gtk, cli):
    text = '<b>Literal & "quoted"</b> 🐦 \\n\nnext line $(not-a-command)'
    cli("--no-notify", text)
    cli("--no-notify", "archive me")
    window = gtk.open()
    assert list(window.rows) == [1, 2]
    assert window.rows[1].body.get_text() == text.split("\n", 1)[0]
    assert window.rows[1].note.text == text
    assert not window.rows[1].body.get_use_markup()
    # Drive both stages with real X11 pointer clicks, not Python callbacks.
    click_button(gtk, window, window.rows[1].done)
    wait_until(gtk.glib, lambda: not window.pending and window.rows[1].note.state == "in_progress")
    click_button(gtk, window, window.rows[1].done)
    wait_until(gtk.glib, lambda: not window.pending and 1 not in window.rows)
    pointer_at(gtk, window, window.rows[2].done, 10, 10, "click", "--repeat", "2", "3")
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    assert window.empty.get_visible()
    assert window.empty.get_text() == "No active reminders."
    with Store(gtk.paths.database) as store:
        assert [note.state for note in store.notes(all_states=True)] == ["done", "removed"]
        assert [event["action"] for event in store.history()] == [
            "add",
            "add",
            "start",
            "done",
            "rm",
        ]
    cli("restore", "1", "--no-notify")
    # No explicit UI refresh: the timer must notice external changes.
    wait_until(gtk.glib, lambda: 1 in window.rows)
    assert window.rows[1].body.get_text() == text.split("\n", 1)[0]
    assert window.rows[1].note.text == text
    assert window.list_box.get_accessible().get_name() == "Reminders, 1 active note"
    assert not window.notice.get_visible()


def test_polling_reuses_rows_preserves_scroll_and_shows_full_list(gtk, cli):
    with Store(gtk.paths.database) as store:
        for index in range(25):
            store.add(f"Reminder {index}: " + "long text " * 30)
    window = gtk.open()
    assert len(window.rows) == 25
    adjustment = window.scroll.get_vadjustment()
    wait_until(gtk.glib, lambda: adjustment.get_upper() > adjustment.get_page_size())
    adjustment.set_value(180)
    before = adjustment.get_value()
    row = window.rows[2]
    assert len(row.body.get_text()) > 180
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.rows[2] is row
    assert adjustment.get_value() == before
    cli("--no-notify", "added while open")
    wait_until(gtk.glib, lambda: 26 in window.rows)
    assert window.rows[2] is row
    assert adjustment.get_value() == before
    assert [child.note.id for child in window.list_box.get_children()] == list(range(1, 27))


def test_busy_mutation_is_visible_retryable_and_does_not_freeze(gtk, cli):
    from pinote.gui.app import Gtk

    cli("--no-notify", "busy note")
    window = gtk.open()
    with display_lock(gtk.paths):
        window.rows[1].done.clicked()
        wait_until(gtk.glib, lambda: not window.pending)
        assert window.notice.get_visible()
        assert "busy" in window.error_text.get_text()
        color = window.error_text.get_style_context().get_color(Gtk.StateFlags.NORMAL)
        assert (color.red, color.green, color.blue) == pytest.approx((1, 240 / 255, 243 / 255))
        assert window.rows[1].done.get_sensitive()
        assert not window.rows[1].done.get_active()  # failed saves must reset the checkbox
        assert not window.rows[1].exiting
        assert not window.rows[1].get_style_context().has_class("completed")
        assert not window.rows[1].get_style_context().has_class("leaving")
    with Store(gtk.paths.database) as store:
        assert store.notes()[0].id == 1
        assert len(store.history()) == 1
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.notice.get_visible()  # a successful poll doesn't hide a failed click
    window.rows[1].done.clicked()
    wait_until(gtk.glib, lambda: not window.pending and window.rows[1].note.state == "in_progress")
    assert not window.notice.get_visible()
    window.rows[1].done.clicked()
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)


def test_read_failure_keeps_rows_and_recovers(gtk, cli, monkeypatch):
    cli("--no-notify", "still visible")
    window = gtk.open()
    original = window.model.notes

    def broken():
        raise sqlite3.OperationalError("test read failure")

    monkeypatch.setattr(window.model, "notes", broken)
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.notice.get_visible()
    assert window.rows[1].body.get_text() == "still visible"
    assert "test read failure" in gtk.paths.log.read_text()
    monkeypatch.setattr(window.model, "notes", original)
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert not window.notice.get_visible()


def test_close_cancels_timer_and_ignores_late_worker_results(gtk, monkeypatch):
    window = gtk.open()
    started = threading.Event()
    release = threading.Event()
    original = window.model.notes

    def slow_read():
        started.set()
        assert release.wait(timeout=5)
        return original()

    monkeypatch.setattr(window.model, "notes", slow_read)
    try:
        window._poll()
        assert started.wait(timeout=2)
        window.close()
        wait_until(gtk.glib, lambda: window.closed)
        assert gtk.glib.MainContext.default().find_source_by_id(window.refresh_source) is None
    finally:
        release.set()
    window.worker.shutdown(wait=True)
    wait_until(gtk.glib, lambda: True)
    assert not window.rows


def test_close_finishes_an_already_clicked_mutation(gtk, cli, monkeypatch):
    cli("--no-notify", "save even if the window closes")
    with Store(gtk.paths.database) as store:
        store.transition(1, "start")
    window = gtk.open()
    started = threading.Event()
    release = threading.Event()
    original = window.model.notes

    def slow_read():
        started.set()
        assert release.wait(timeout=5)
        return original()

    monkeypatch.setattr(window.model, "notes", slow_read)
    try:
        window._poll()
        assert started.wait(timeout=2)
        window.rows[1].done.clicked()  # queued behind the read
        window.close()
        wait_until(gtk.glib, lambda: window.closed)
    finally:
        release.set()
    window.worker.shutdown(wait=True)
    with Store(gtk.paths.database) as store:
        assert store.notes() == []
        assert [event["action"] for event in store.history()] == ["add", "start", "done"]


@pytest.mark.parametrize("finish", ["close", "crash", "clear", "submit", "edit", "failed-submit"])
def test_input_draft_survives_process_restart_without_resurrecting_submissions(gtk, finish):
    draft = "  Unfinished <task> café ☕\n\nDetails\twith whitespace  \n"
    script = textwrap.dedent("""
        import os
        import sys
        import threading
        from pinote.gui import main
        from pinote.gui.app import Gio, GLib

        finish, draft = sys.argv[1:]
        started = False

        def edit_and_close():
            global started
            app = Gio.Application.get_default()
            window = app.get_active_window()
            if window is None or window.pending:
                return True
            if not started:
                assert window.entry.get_text() == ""
                window.entry.set_text(draft)
                started = True
            if finish != "close":
                if not window.draft.path.exists() or window.draft.path.read_text() != draft:
                    return True
            if finish == "crash":
                os._exit(0)  # Verify autosave without running the close handler.
            if finish == "clear":
                window.entry.set_text("")
            elif finish in {"submit", "edit", "failed-submit"}:
                entered, release = threading.Event(), threading.Event()
                original = window.model.add

                def slow_add(text):
                    entered.set()
                    assert release.wait(timeout=3)
                    if finish == "failed-submit":
                        raise OSError("test add failure")
                    return original(text)

                window.model.add = slow_add
                window.entry.emit("activate")
                assert entered.wait(timeout=2)
                if finish == "edit":
                    window.entry.set_text("A newer draft")
                    window.entry.set_text(draft)  # Same text, but a newer revision.
                threading.Timer(0.2, release.set).start()
            window.close()  # Before the autosave timer or pending add completes.
            return False

        GLib.timeout_add(20, edit_and_close)
        status = main([])
        assert started
        raise SystemExit(status)
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, finish, draft],
        env=gtk.env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    expected = "" if finish in {"clear", "submit"} else draft
    window = gtk.open()
    assert window.entry.get_text() == expected
    assert window.placeholder.get_visible() == (not expected)
    assert window.add_button.get_sensitive() == bool(expected)
    if expected:
        assert window.draft.path.read_text() == expected
        assert window.draft.path.stat().st_mode & 0o777 == 0o600
    else:
        assert not window.draft.path.exists()
    with Store(gtk.paths.database) as store:
        saved = [draft.strip()] if finish in {"submit", "edit"} else []
        assert [note.text for note in store.notes()] == saved
        assert [event["action"] for event in store.history()] == ["add"] * len(saved)


def test_single_instance_reopen_and_real_window_close(gtk, tmp_path):
    from pinote.gui.app import Gdk

    geometry = Gdk.Display.get_default().get_monitor_at_point(25, 1300).get_workarea()
    expected_bottom = geometry.y + geometry.height - 25
    assert shutil.which("xdotool"), "GTK process tests require xdotool"
    executable = str(Path(sys.executable).parent / "pinote-gui")
    with Store(gtk.paths.database) as store:
        store.add("closing never changes this")

    def visible_windows():
        result = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", "^pinote — Reminders$"],
            env=gtk.env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert result.returncode in (0, 1), result.stderr
        return result.stdout.split()

    for _ in range(2):
        with (tmp_path / "process.log").open("w") as output:
            process = subprocess.Popen([executable], env=gtk.env, stdout=output, stderr=output)
            try:
                wait_until(gtk.glib, lambda: bool(visible_windows()))
                windows = visible_windows()
                assert len(windows) == 1

                def position(window_id=windows[0], *, bottom=False):
                    result = subprocess.run(
                        ["xdotool", "getwindowgeometry", "--shell", window_id],
                        env=gtk.env,
                        capture_output=True,
                        text=True,
                        check=True,
                        timeout=5,
                    )
                    values = dict(line.split("=", 1) for line in result.stdout.splitlines())
                    y = int(values["Y"]) + (int(values["HEIGHT"]) if bottom else 0)
                    return int(values["X"]), y

                wait_until(gtk.glib, lambda: position(bottom=True) == (25, expected_bottom))
                # A manual move lasts for this instance only; reopening starts
                # at the default rather than restoring the last dragged position.
                subprocess.run(
                    ["xdotool", "windowmove", windows[0], "160", "220"],
                    env=gtk.env,
                    check=True,
                    timeout=5,
                )
                wait_until(gtk.glib, lambda: position() == (160, 220))
                second = subprocess.run(
                    [executable], env=gtk.env, capture_output=True, text=True, timeout=5
                )
                assert second.returncode == 0, second.stdout + second.stderr
                assert process.poll() is None
                assert visible_windows() == windows
                assert position() == (160, 220)
                # windowclose calls XDestroyWindow, racing GTK's redraws (e.g.
                # the entry caret). Exercise graceful close through real input.
                subprocess.run(
                    ["xdotool", "windowfocus", "--sync", windows[0], "key", "Escape"],
                    env=gtk.env,
                    check=True,
                    timeout=5,
                )
                assert process.wait(timeout=5) == 0, (tmp_path / "process.log").read_text()
                wait_until(gtk.glib, lambda: not visible_windows())
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
    with Store(gtk.paths.database) as store:
        assert len(store.notes()) == 1
        assert len(store.history()) == 1


def test_restart_helper_preserves_hidden_workspace_and_environment(gtk, tmp_path):
    if not shutil.which("i3") or not shutil.which("i3-msg"):
        pytest.skip("install i3 for restart-helper coverage")
    root = Path(__file__).resolve().parents[1]
    helper = root / "scripts/restart-pinote.sh"
    executable = root / ".venv-gui/bin/pinote-gui"
    assert executable.is_file(), "restart-helper tests require the checkout's .venv-gui"
    socket = str(tmp_path / "i3.sock")
    env = {**gtk.env, "I3SOCK": socket}
    config = tmp_path / "i3.conf"
    config.write_text(
        f"font pango:monospace 9\nipc-socket {socket}\n"
        'for_window [window_role="^pinote-"] floating enable, border none\n'
    )

    def wm(*args):
        result = subprocess.run(
            ["i3-msg", "-s", socket, *args],
            env=env,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        reply = json.loads(result.stdout)
        if isinstance(reply, list):
            assert all(item["success"] for item in reply), reply
        return reply

    def windows():
        def collect(node, workspace=None):
            if node.get("type") == "workspace":
                workspace = node["name"]
            if node.get("window_properties", {}).get("window_role") == "pinote-reminders":
                yield node["window"], workspace
            for child in node.get("nodes", []) + node.get("floating_nodes", []):
                yield from collect(child, workspace)

        return list(collect(wm("-t", "get_tree")))

    def restart():
        result = subprocess.run(
            [str(helper)],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout

    process = None
    with (tmp_path / "restart.log").open("w") as output:
        manager = subprocess.Popen(
            ["i3", "-a", "-c", str(config)], env=env, stdout=output, stderr=output
        )
        try:
            wait_until(gtk.glib, lambda: Path(socket).exists() or manager.poll() is not None)
            assert manager.poll() is None, (tmp_path / "restart.log").read_text()
            wm("workspace original")
            assert "left stopped" in restart()
            assert not windows()
            with Store(gtk.paths.database) as store:
                store.add("Preserve the saved task")
            process = subprocess.Popen(
                [str(executable)],
                env={**env, "PINOTE_RESTART_TEST": "original"},
                stdout=output,
                stderr=output,
            )
            wait_until(gtk.glib, lambda: len(windows()) == 1)
            _, workspace = windows()[0]
            assert workspace == "original"
            wm("workspace elsewhere")
            visible = subprocess.run(
                ["xdotool", "search", "--onlyvisible", "--name", "^pinote — Reminders$"],
                env=env,
                capture_output=True,
                timeout=5,
            )
            assert visible.returncode == 1
            # Do not poll/wait the old process until restart returns: it becomes
            # an unreaped zombie, which the helper must recognize as stopped.
            result = restart()
            assert f"PID {process.pid} -> " in result
            assert process.wait(timeout=5) == 0, (tmp_path / "restart.log").read_text()
            [(new_window, new_workspace)] = windows()
            assert new_workspace == workspace
            # X11 may reuse the old window ID; process identity proves a restart.
            pid = subprocess.run(
                ["xdotool", "getwindowpid", str(new_window)],
                env=env,
                capture_output=True,
                text=True,
                check=True,
                timeout=5,
            ).stdout.strip()
            assert int(pid) != process.pid
            assert b"PINOTE_RESTART_TEST=original" in Path(
                f"/proc/{pid}/environ"
            ).read_bytes().split(b"\0")
            with Store(gtk.paths.database) as store:
                assert [note.text for note in store.notes()] == ["Preserve the saved task"]
                assert len(store.history()) == 1
            wm(f'[id="{new_window}"] kill')
            wait_until(gtk.glib, lambda: not windows())
            assert "left stopped" in restart()
        finally:
            if manager.poll() is None and windows():
                wm('[window_role="^pinote-reminders$"] kill')
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            manager.terminate()
            manager.wait(timeout=5)


@pytest.mark.parametrize("operation", ["start", "reset", "done", "add"])
def test_process_exit_drains_accepted_click_without_an_explicit_join(gtk, cli, operation):
    cli("--no-notify", "accepted before closing")
    if operation in {"done", "reset"}:
        with Store(gtk.paths.database) as store:
            store.transition(1, "start")
    script = textwrap.dedent("""
        import sys
        import threading
        from pinote.gui import main
        from pinote.gui.app import Gio, GLib

        clicked = False

        def close_with_queued_click():
            global clicked
            app = Gio.Application.get_default()
            window = app.get_active_window()
            if window is None or window.pending or not window.rows:
                return True
            started, release = threading.Event(), threading.Event()
            original = window.model.notes

            def slow_read():
                started.set()
                assert release.wait(timeout=3)
                return original()

            window.model.notes = slow_read
            window._poll()
            assert started.wait(timeout=2)
            if sys.argv[1] == "add":
                window.entry.set_text("Add accepted before closing")
                window.entry.emit("activate")
            elif sys.argv[1] == "reset":
                window._act(1, "reset")
            else:
                window.rows[1].done.clicked()
            clicked = True
            threading.Timer(0.2, release.set).start()
            window.close()
            return False

        GLib.timeout_add(20, close_with_queued_click)
        status = main([])
        assert clicked
        # No explicit executor join: normal Python process shutdown must drain it.
        raise SystemExit(status)
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, operation],
        env=gtk.env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    with Store(gtk.paths.database) as store:
        if operation == "add":
            assert [note.text for note in store.notes()] == [
                "accepted before closing",
                "Add accepted before closing",
            ]
            assert [event["action"] for event in store.history()] == ["add", "add"]
        else:
            states = {"start": ["in_progress"], "reset": ["active"], "done": []}
            assert [note.state for note in store.notes()] == states[operation]
            expected = ["add"] if operation == "start" else ["add", "start"]
            assert [event["action"] for event in store.history()] == [*expected, operation]


def test_invalid_config_is_reported_without_creating_database(gtk):
    path = Path(gtk.env["XDG_CONFIG_HOME"]) / "pinote/config.toml"
    path.parent.mkdir(parents=True)
    path.write_text("[gui]\nmax_visible_notes = 0\n")
    result = subprocess.run(
        [sys.executable, "-m", "pinote.gui"],
        env=gtk.env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 1
    assert "max_visible_notes must be a positive integer" in result.stdout
    assert str(path) in gtk.paths.log.read_text()
    assert "Traceback" not in result.stdout + result.stderr
    assert not gtk.paths.database.exists()


@pytest.mark.parametrize("missing", ["display", "bus"])
def test_missing_desktop_is_reported_without_creating_database(gtk, missing):
    env = gtk.env.copy()
    if missing == "display":
        env.pop("DISPLAY", None)
    else:
        env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/nonexistent-pinote-gui-test-bus"
    result = subprocess.run(
        [sys.executable, "-m", "pinote.gui"], env=env, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 1
    expected = "graphical display" if missing == "display" else "session D-Bus"
    assert expected in result.stdout
    assert expected in gtk.paths.log.read_text()
    assert not gtk.paths.database.exists()
