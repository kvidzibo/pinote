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


def click_button(gtk, window, button):
    wait_until(gtk.glib, lambda: button.get_allocated_width() > 1)
    x, y = button.translate_coordinates(
        window, button.get_allocated_width() // 2, button.get_allocated_height() // 2
    )
    _success, origin_x, origin_y = window.get_window().get_origin()
    subprocess.run(
        ["xdotool", "mousemove", "--sync", str(origin_x + x), str(origin_y + y), "click", "1"],
        env=gtk.env,
        check=True,
        timeout=5,
    )


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

    def open_window():
        application = ReminderApplication(paths)
        assert application.register(None)
        assert not application.get_is_remote()
        applications.append(application)
        application.activate()
        assert not application.failed
        window = application.get_windows()[0]
        windows.append(window)
        wait_until(GLib, lambda: not window.pending)
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
    assert window.entry.get_parent() is window.composer
    assert window.entry.get_accessible().get_name() == "New task"
    assert window.add_button.get_accessible().get_name() == "Add task"
    assert not window.get_resizable()
    assert window.get_size().width == 420
    assert window.get_size().height < 140
    assert row.get_allocated_height() <= 30
    assert isinstance(row.done, Gtk.CheckButton)
    assert not row.done.get_active()
    assert row.done.get_accessible().get_name() == "Done note 1"
    assert row.remove.get_accessible().get_name() == "Remove note 1"
    assert row.remove.get_image() is not None
    assert row.body.get_line_wrap()
    font = row.body.get_pango_context().get_font_description()
    assert "Hack Nerd Font Mono" in font.get_family()
    assert font.get_size() == 9 * 1024
    color = row.body.get_style_context().get_color(Gtk.StateFlags.NORMAL)
    assert (color.red, color.green, color.blue) == pytest.approx((243 / 255, 245 / 255, 248 / 255))
    monitor = window.get_display().get_monitor_at_window(window.get_window()).get_geometry()
    x, y = window.get_position()
    assert x == 25
    assert y == min(1300, monitor.y + monitor.height - 140)
    assert window.get_type_hint() == Gdk.WindowTypeHint.DIALOG
    window.close_button.clicked()
    wait_until(gtk.glib, lambda: window.closed)
    with Store(gtk.paths.database) as store:
        assert len(store.notes()) == 3
        assert len(store.history()) == 3


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
    assert empty_height < window.get_size().height <= 480
    monitor = window.get_display().get_monitor_at_window(window.get_window()).get_geometry()
    assert window.get_position()[1] + window.get_size().height <= monitor.y + monitor.height
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
    window.entry.set_text("Unsubmitted text must not be saved on close")
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
            'for_window [window_role="^pinote-reminders$"] floating enable, border none\n'
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
                    store.add(f"Reminder {index}")
            window = gtk.open()
            monitor = window.get_display().get_monitor_at_window(window.get_window())
            geometry = monitor.get_geometry()
            screen_bottom = geometry.y + geometry.height
            expected = (25, min(1300, screen_bottom - 140))
            wait_until(gtk.glib, lambda: tuple(window.get_position()) == expected)
            assert window.get_size().width == 420
            assert window.get_size().height < 140
            nodes = [tree()]
            while nodes:
                node = nodes.pop()
                if node.get("name") == window.get_title():
                    assert node["floating"] == "auto_on"
                    assert node["border"] == "none"
                    assert node["deco_rect"]["height"] == 0
                    assert (node["rect"]["x"], node["rect"]["y"]) == expected
                    break
                nodes.extend(node.get("nodes", []) + node.get("floating_nodes", []))
            else:
                pytest.fail("private i3 did not manage the popup")
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
            assert window.get_size().height <= 480
            bottom = window.get_position()[1] + window.get_size().height
            assert bottom <= screen_bottom
            with Store(gtk.paths.database) as store:
                for note in store.notes():
                    store.transition(note.id, "rm")
            window._poll()
            wait_until(gtk.glib, lambda: not window.rows and window.get_size().height < 100)
            assert tuple(window.get_position()) == expected
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


def test_blank_and_invalid_add_keep_input_without_saving(gtk):
    window = gtk.open()
    window.entry.set_text("   ")
    window.entry.emit("activate")
    assert not window.add_button.get_sensitive() and not window.pending
    assert window.entry.get_max_length() == 0  # never silently truncate a long paste
    text = "x" * 4097
    window.entry.set_text(text)
    window.entry.emit("activate")
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.entry.get_text() == text
    assert window.notice.get_visible() and "4096" in window.error_text.get_text()
    assert window.add_button.get_sensitive()
    with Store(gtk.paths.database) as store:
        assert store.notes() == [] and store.history() == []


def test_busy_add_keeps_draft_and_can_be_retried(gtk):
    window = gtk.open()
    window.entry.set_text("Keep this draft")
    with display_lock(gtk.paths):
        window.entry.emit("activate")
        wait_until(gtk.glib, lambda: not window.pending)
        assert window.notice.get_visible() and "busy" in window.error_text.get_text()
        assert window.entry.get_text() == "Keep this draft"
        assert window.add_button.get_sensitive()
    with Store(gtk.paths.database) as store:
        assert store.notes() == [] and store.history() == []
    window._poll()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.notice.get_visible() and window.entry.get_text() == "Keep this draft"
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


@pytest.mark.parametrize("next_text", ["A second draft", "First draft"])
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
        assert [event["action"] for event in store.history()] == ["add", "add", "done", "add"]


@pytest.mark.parametrize("action", ["done", "rm"])
def test_click_animates_after_save_with_real_fade_and_collapse(
    gtk, animations, monkeypatch, action
):
    from pinote.gui.app import Gtk, NoteRow

    monkeypatch.setattr(NoteRow, "EXIT_MS", 500)
    with Store(gtk.paths.database) as store:
        store.add("Animate this reminder\nwith a second line")
        store.add("Keep this one")
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
        (row.done if action == "done" else row.remove).clicked()
        assert started.wait(timeout=2)
        assert not row.exiting
        assert not row.get_style_context().has_class("completed")
        assert row.get_allocated_height() == height
    finally:
        release.set()
    wait_until(gtk.glib, lambda: not window.pending)
    assert row.exiting and window.rows[1] is row
    assert not row.done.get_sensitive() and not row.remove.get_sensitive()
    assert row.get_style_context().has_class("completed") == (action == "done")
    assert row.done.get_active() == (action == "done")
    assert window.rows[2].done.get_sensitive()  # animations do not block other notes
    assert window.list_box.get_accessible().get_name() == "Reminders, 1 active note"
    with Store(gtk.paths.database) as store:
        assert store.notes(all_states=True)[0].state == ("done" if action == "done" else "removed")
        assert [event["action"] for event in store.history(1)] == ["add", action]
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
@pytest.mark.parametrize("click_action", ["done", "rm"])
def test_stale_click_does_not_animate_or_write(
    gtk, animations, cli, monkeypatch, external_action, click_action
):
    cli("--no-notify", "Changed before the next poll")
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
    (row.done if click_action == "done" else row.remove).clicked()
    wait_until(gtk.glib, lambda: not window.pending)
    assert dismissed == []
    assert not window.rows and not window.list_box.get_children()
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add", external_action]


@pytest.mark.parametrize("action", ["done", "rm"])
def test_disabled_animations_remove_immediately(gtk, animations, action):
    animations.set_property("gtk-enable-animations", False)
    with Store(gtk.paths.database) as store:
        store.add("No motion")
    window = gtk.open()
    row = window.rows[1]
    (row.done if action == "done" else row.remove).clicked()
    wait_until(gtk.glib, lambda: not window.pending)
    assert not window.rows and not window.list_box.get_children()
    assert not row.pause_source and not row.settings_handler
    assert not row.get_style_context().has_class("completed")
    assert not row.get_style_context().has_class("leaving")
    assert window.empty.get_visible()
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add", action]


@pytest.mark.parametrize("action", ["done", "rm"])
@pytest.mark.parametrize("finish", ["close", "disable"])
def test_close_or_disable_during_animation_cleans_up(gtk, animations, monkeypatch, action, finish):
    from pinote.gui.app import NoteRow

    monkeypatch.setattr(NoteRow, "DONE_HOLD_MS", 10000)
    monkeypatch.setattr(NoteRow, "EXIT_MS", 10000)
    with Store(gtk.paths.database) as store:
        store.add("Already saved")
    window = gtk.open()
    row = window.rows[1]
    (row.done if action == "done" else row.remove).clicked()
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
        assert [event["action"] for event in store.history()] == ["add", action]


def test_multiple_clicks_do_not_resubmit_departing_rows(gtk, animations, monkeypatch):
    from pinote.gui.app import NoteRow

    monkeypatch.setattr(NoteRow, "EXIT_MS", 600)
    with Store(gtk.paths.database) as store:
        store.add("Complete")
        store.add("Archive")
    window = gtk.open()
    window.rows[1].done.clicked()
    wait_until(gtk.glib, lambda: not window.pending)
    assert window.rows[1].exiting
    window._act(1, "rm")  # a disappearing Done row must never be re-archived
    assert not window.pending
    window.rows[2].remove.clicked()
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    assert window.empty.get_visible()
    with Store(gtk.paths.database) as store:
        assert [event["action"] for event in store.history()] == ["add", "add", "done", "rm"]


def test_buttons_save_history_literal_text_and_refresh_from_cli(gtk, cli):
    text = '<b>Literal & "quoted"</b> 🐦 \\n\nnext line $(not-a-command)'
    cli("--no-notify", text)
    cli("--no-notify", "archive me")
    window = gtk.open()
    assert list(window.rows) == [1, 2]
    assert window.rows[1].body.get_text() == text
    assert not window.rows[1].body.get_use_markup()
    # Drive a real X11 pointer click, not just a Python callback.
    click_button(gtk, window, window.rows[1].done)
    wait_until(gtk.glib, lambda: not window.pending and 1 not in window.rows)
    window.rows[2].remove.clicked()
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    assert window.empty.get_visible()
    assert window.empty.get_text() == "No active reminders."
    with Store(gtk.paths.database) as store:
        assert [note.state for note in store.notes(all_states=True)] == ["done", "removed"]
        assert [event["action"] for event in store.history()] == ["add", "add", "done", "rm"]
    cli("restore", "1", "--no-notify")
    # No explicit UI refresh: the timer must notice external changes.
    wait_until(gtk.glib, lambda: 1 in window.rows)
    assert window.rows[1].body.get_text() == text
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
    wait_until(gtk.glib, lambda: not window.pending and not window.rows)
    assert not window.notice.get_visible()


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
        assert [event["action"] for event in store.history()] == ["add", "done"]


def test_single_instance_reopen_and_real_window_close(gtk, tmp_path):
    from pinote.gui.app import Gdk

    geometry = Gdk.Display.get_default().get_monitor_at_point(25, 1300).get_geometry()
    expected_y = min(1300, geometry.y + geometry.height - 140)
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

                def position(window_id=windows[0]):
                    result = subprocess.run(
                        ["xdotool", "getwindowgeometry", "--shell", window_id],
                        env=gtk.env,
                        capture_output=True,
                        text=True,
                        check=True,
                        timeout=5,
                    )
                    values = dict(line.split("=", 1) for line in result.stdout.splitlines())
                    return int(values["X"]), int(values["Y"])

                wait_until(gtk.glib, lambda: position() == (25, expected_y))
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


@pytest.mark.parametrize("operation", ["done", "add"])
def test_process_exit_drains_accepted_click_without_an_explicit_join(gtk, cli, operation):
    cli("--no-notify", "accepted before closing")
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
            assert store.notes() == []
            assert [event["action"] for event in store.history()] == ["add", "done"]


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
