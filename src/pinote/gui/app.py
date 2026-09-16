"""GTK 3 presentation. Database work never runs on the GTK event thread."""

from __future__ import annotations

import sqlite3
from concurrent.futures import Future, ThreadPoolExecutor
from importlib.resources import files

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango  # noqa: E402

from pinote.gui import GuiUnavailable  # noqa: E402
from pinote.gui.model import ReminderModel, application_id  # noqa: E402
from pinote.logging_setup import LOGGER  # noqa: E402
from pinote.paths import Paths  # noqa: E402
from pinote.store import Note, NoteError  # noqa: E402


def icon_button(icon: str, description: str) -> Gtk.Button:
    image = Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.MENU)
    image.set_pixel_size(12)
    button = Gtk.Button(image=image, valign=Gtk.Align.START)
    button.set_relief(Gtk.ReliefStyle.NONE)
    button.set_tooltip_text(description)
    button.get_accessible().set_name(description)
    return button


class NoteRow(Gtk.ListBoxRow):
    DONE_HOLD_MS = 200
    EXIT_MS = 200  # Keep the CSS opacity transition in sync.

    def __init__(self, note: Note, on_action):
        super().__init__()
        self.note = note
        self.exiting = False
        self.pause_source = 0
        self.settings_handler = 0
        self.on_dismissed = None
        self.animation_settings = self.get_settings()
        self.get_style_context().add_class("note-row")
        self.revealer = Gtk.Revealer(
            reveal_child=True, transition_type=Gtk.RevealerTransitionType.SLIDE_UP
        )
        self.revealer.connect("notify::child-revealed", self._revealed)
        self.add(self.revealer)
        content = self.content = Gtk.Box(spacing=8)
        content.get_style_context().add_class("note-content")
        self.revealer.add(content)
        self.connect("destroy", lambda _row: self._clear_animation())
        self.done = Gtk.CheckButton(valign=Gtk.Align.START)
        self.done.set_tooltip_text(f"Complete note {note.id}")
        self.done.get_accessible().set_name(f"Done note {note.id}")
        self.done.connect(
            "toggled", lambda button: on_action(note.id, "done") if button.get_active() else None
        )
        content.pack_start(self.done, False, False, 0)
        # Never treat stored text as Pango markup, commands, or widget source.
        self.body = Gtk.Label(label=note.text, xalign=0, yalign=0, selectable=True)
        self.body.set_line_wrap(True)
        self.body.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.body.set_max_width_chars(42)
        self.body.set_hexpand(True)
        self.body.set_margin_top(3)
        self.body.set_tooltip_text(f"Note #{note.id}")
        content.pack_start(self.body, True, True, 0)
        self.remove = icon_button("user-trash-symbolic", f"Remove note {note.id}")
        self.remove.set_tooltip_text(f"Archive note {note.id}; recover with note restore {note.id}")
        self.remove.get_style_context().add_class("remove-button")
        self.remove.connect("clicked", lambda _button: on_action(note.id, "rm"))
        content.pack_start(self.remove, False, False, 0)

    def update(self, note: Note, *, sensitive: bool) -> None:
        if note != self.note:
            self.note = note
            self.body.set_text(note.text)
        sensitive = sensitive and not self.exiting
        self.done.set_sensitive(sensitive)
        if sensitive:
            # A failed save leaves the note active; toggling off never submits work.
            self.done.set_active(False)
        self.remove.set_sensitive(sensitive)

    def dismiss(self, action: str, on_dismissed) -> None:
        """Called only after a successful mutation removes this note from the snapshot."""
        if self.exiting:
            return
        self.exiting = True
        self.on_dismissed = on_dismissed
        self.update(self.note, sensitive=False)
        enabled = self.animation_settings.get_property("gtk-enable-animations")
        if not self.get_mapped() or not enabled:
            self._finish_dismissal()
            return
        self.settings_handler = self.animation_settings.connect(
            "notify::gtk-enable-animations", self._animations_changed
        )
        self.revealer.set_transition_duration(self.EXIT_MS)
        if action == "done":
            self.get_style_context().add_class("completed")
            self.done.set_active(True)
            self.pause_source = GLib.timeout_add(self.DONE_HOLD_MS, self._collapse)
        else:
            self._collapse()

    def _collapse(self) -> bool:
        self.pause_source = 0
        self.get_style_context().add_class("leaving")
        self.revealer.set_reveal_child(False)
        return GLib.SOURCE_REMOVE

    def _revealed(self, revealer, _property) -> None:
        if self.exiting and not revealer.get_reveal_child() and not revealer.get_child_revealed():
            self._finish_dismissal()

    def _animations_changed(self, settings, _property) -> None:
        if not settings.get_property("gtk-enable-animations"):
            self._finish_dismissal()

    def _finish_dismissal(self) -> None:
        callback = self.on_dismissed
        self._clear_animation()
        if callback is not None:
            callback(self)

    def _clear_animation(self) -> None:
        self.exiting = False
        self.on_dismissed = None
        if self.pause_source:
            GLib.source_remove(self.pause_source)
            self.pause_source = 0
        if self.settings_handler:
            self.animation_settings.disconnect(self.settings_handler)
            self.settings_handler = 0

    def cancel_dismissal(self) -> None:
        # A newer snapshot restored this note. Cancel both the hold and collapse;
        # any late GTK notification must not remove a now-active row.
        self._clear_animation()
        self.get_style_context().remove_class("completed")
        self.get_style_context().remove_class("leaving")
        self.revealer.set_transition_duration(0)
        self.revealer.set_reveal_child(True)


class ReminderWindow(Gtk.ApplicationWindow):
    def __init__(self, application: Gtk.Application, model: ReminderModel):
        super().__init__(application=application, title="pinote — Reminders")
        self.model = model
        self.rows: dict[int, NoteRow] = {}
        self.closed = False
        self.pending = 0
        self.action_pending = False
        self.draft_revision = 0
        self.error_is_action = False
        self.last_error = None
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pinote-gui")
        # A Dunst-sized popup, not a conventional application with a title bar.
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        self.set_keep_above(True)
        self.set_role("pinote-reminders")
        Gtk.Widget.set_opacity(self, 0.96)
        self.get_style_context().add_class("pinote-window")
        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)
        # Absolute desktop coordinates, independent of the focused monitor.
        # On smaller displays keep enough room for the list and task entry.
        start_x, start_y = 25, 1300
        geometry = self.get_display().get_monitor_at_point(start_x, start_y).get_geometry()
        width = min(420, max(1, geometry.width - 24))
        self.set_default_size(width, -1)
        position = (
            max(geometry.x, min(start_x, geometry.x + geometry.width - width)),
            max(geometry.y, min(start_y, geometry.y + geometry.height - 140)),
        )
        self.move(*position)

        # i3 can initially offset the client for decorations it then removes.
        # Correct only the first map; later remaps must preserve manual moves.
        def place_once(window, _event):
            window.disconnect(placement_handler)
            window.move(*position)

        placement_handler = self.connect("map-event", place_once)

        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        layout.get_style_context().add_class("reminder-panel")
        self.add(layout)
        self.notice = Gtk.InfoBar(message_type=Gtk.MessageType.ERROR, show_close_button=True)
        self.notice.set_no_show_all(True)
        self.error_text = Gtk.Label(xalign=0)
        self.error_text.set_line_wrap(True)
        self.error_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.error_text.set_max_width_chars(38)
        self.notice.get_content_area().add(self.error_text)
        self.notice.get_content_area().show_all()
        self.notice.connect("response", lambda *_args: self.notice.hide())
        layout.pack_start(self.notice, False, False, 0)

        self.list_box = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.list_box.get_style_context().add_class("reminder-list")
        self.empty = Gtk.Label(label="Loading reminders…")
        self.empty.get_style_context().add_class("dim-label")
        self.empty.set_margin_top(6)
        self.empty.set_margin_bottom(6)
        self.empty.show()
        self.list_box.set_placeholder(self.empty)
        self.scroll = Gtk.ScrolledWindow()
        self.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.scroll.set_propagate_natural_height(True)
        available_height = geometry.y + geometry.height - position[1]
        self.scroll.set_max_content_height(min(420, max(80, available_height - 60)))
        self.scroll.add(self.list_box)
        layout.pack_start(self.scroll, True, True, 0)

        self.composer = Gtk.Box(spacing=6)
        self.entry = Gtk.Entry(placeholder_text="Add a task…", hexpand=True)
        self.entry.set_width_chars(1)
        self.entry.set_tooltip_text("Type a task, then press Enter to save")
        self.entry.get_accessible().set_name("New task")
        self.add_button = icon_button("list-add-symbolic", "Add task")
        self.add_button.set_tooltip_text("Add task (Enter)")
        self.add_button.set_valign(Gtk.Align.CENTER)
        self.close_button = icon_button("window-close-symbolic", "Close reminders (Esc)")
        self.close_button.set_valign(Gtk.Align.CENTER)
        self.entry.connect("changed", self._draft_changed)
        self.entry.connect("activate", lambda _entry: self._add())
        self.add_button.connect("clicked", lambda _button: self._add())
        self.close_button.connect("clicked", lambda _button: self.close())
        self.composer.pack_start(self.entry, True, True, 0)
        self.composer.pack_start(self.add_button, False, False, 0)
        self.composer.pack_start(self.close_button, False, False, 0)
        layout.pack_start(self.composer, False, False, 0)
        self._update_add_button()

        self.connect("key-press-event", self._on_key_press)
        self.connect("size-allocate", self._keep_on_screen)
        self.connect("destroy", self._on_destroy)
        self.show_all()
        self.entry.grab_focus()
        self.refresh_source = GLib.timeout_add(1000, self._poll)
        self._poll()

    def _keep_on_screen(self, _window, allocation) -> None:
        if not self.get_mapped():
            return
        # An error notice can grow the popup beyond its normal list budget.
        # Shift up only when necessary, without resetting a user's manual move.
        geometry = self.get_display().get_monitor_at_window(self.get_window()).get_geometry()
        x, y = self.get_position()
        bottom = geometry.y + geometry.height
        if y + allocation.height > bottom:
            self.move(x, max(geometry.y, bottom - allocation.height))

    def _on_key_press(self, _window, event) -> bool:
        if event.keyval == Gdk.KEY_Escape:
            self.close()
            return True
        return False

    def _poll(self) -> bool:
        if self.closed:
            return GLib.SOURCE_REMOVE
        # No backlog of polls, and no poll can overtake a pending mutation.
        if not self.pending:
            self._submit(self.model.notes, action=None)
        return GLib.SOURCE_CONTINUE

    def _draft_changed(self, _entry) -> None:
        self.draft_revision += 1
        self._update_add_button()

    def _update_add_button(self) -> None:
        self.add_button.set_sensitive(
            not self.closed and not self.action_pending and bool(self.entry.get_text().strip())
        )

    def _update_controls(self) -> None:
        for row in self.rows.values():
            row.update(row.note, sensitive=not self.action_pending)
        self._update_add_button()

    def _add(self) -> None:
        text = self.entry.get_text()
        if self.closed or self.action_pending or not text.strip():
            return
        self.action_pending = True
        self._update_controls()
        self._submit(lambda: self.model.add(text), action=None, draft_revision=self.draft_revision)

    def _act(self, note_id: int, action: str) -> None:
        row = self.rows.get(note_id)
        if self.closed or self.action_pending or row is None or row.exiting:
            return
        self.action_pending = True
        self._update_controls()
        self._submit(lambda: self.model.transition(note_id, action), action=(note_id, action))

    def _submit(
        self, operation, *, action: tuple[int, str] | None, draft_revision: int | None = None
    ) -> None:
        self.pending += 1
        future = self.worker.submit(operation)

        def completed(result):
            if self.closed:
                self._finish_after_close(result)
            else:
                GLib.idle_add(self._finish, result, action, draft_revision)

        future.add_done_callback(completed)

    @staticmethod
    def _finish_after_close(future: Future) -> None:
        try:
            future.result()
        except Exception:
            LOGGER.exception("GUI operation failed while closing. Run note to check saved state.")

    def _finish(
        self, future: Future, action: tuple[int, str] | None, draft_revision: int | None
    ) -> bool:
        if self.closed:
            self._finish_after_close(future)
            return GLib.SOURCE_REMOVE
        self.pending -= 1
        mutation = action is not None or draft_revision is not None
        if mutation:
            self.action_pending = False
        try:
            result = future.result()
            if draft_revision is not None:
                # The add is committed. Never erase edits made while it was
                # queued, even when the user edited back to identical text.
                if self.draft_revision == draft_revision:
                    self.entry.set_text("")
                self.entry.grab_focus()
            elif action:
                self._render(result.notes, action=action if result.changed else None)
            else:
                self._render(result)
        except BlockingIOError:
            self._error("Another note command is busy. Try again.", action=mutation)
        except (NoteError, OSError, sqlite3.Error) as exc:
            self._error(f"{exc}\nRun note to check the saved state.", action=mutation)
        except Exception:
            LOGGER.exception("Unexpected GUI operation failure.")
            self._error("Unexpected failure. Run note to check the saved state.", action=mutation)
        else:
            self.last_error = None
            # Keep failed-action messages visible even when polling recovers.
            if mutation or not self.error_is_action:
                self.notice.hide()
                self.error_is_action = False
            if draft_revision is not None:
                # Refresh separately: a read failure must not make a saved add
                # look like it failed and invite a duplicate submission.
                self._poll()
        finally:
            self._update_controls()
        return GLib.SOURCE_REMOVE

    def _render(self, notes: list[Note], *, action: tuple[int, str] | None = None) -> None:
        wanted = {note.id for note in notes}
        for note_id in self.rows.keys() - wanted:
            row = self.rows[note_id]
            if row.exiting:
                continue  # A poll must not interrupt or restart a saved click's animation.
            if action and note_id == action[0]:
                row.dismiss(action[1], self._remove_row)
            else:
                self._remove_row(row)
        for note in notes:
            if note.id not in self.rows:
                row = NoteRow(note, self._act)
                # Departing rows still occupy a slot until their animation ends.
                position = sum(note_id < note.id for note_id in self.rows)
                self.rows[note.id] = row
                self.list_box.insert(row, position)
                row.show_all()
            row = self.rows[note.id]
            if row.exiting:
                row.cancel_dismissal()
            row.update(note, sensitive=not self.action_pending)
        self.empty.set_text("No active reminders.")
        self.list_box.get_accessible().set_name(
            f"Reminders, {len(notes)} active {'note' if len(notes) == 1 else 'notes'}"
        )
        # Existing rows and the scroll adjustment are deliberately left intact.

    def _remove_row(self, row: NoteRow) -> None:
        if not self.closed and self.rows.get(row.note.id) is row:
            self.rows.pop(row.note.id)
            row.destroy()

    def _error(self, message: str, *, action: bool) -> None:
        if message != self.last_error:
            LOGGER.error("GUI: %s", message)
            self.last_error = message
        self.error_is_action = action or self.error_is_action
        self.error_text.set_text(message)
        self.notice.show()

    def _on_destroy(self, _window) -> None:
        self.closed = True
        GLib.source_remove(self.refresh_source)
        # GTK may retain child widgets after closing. Stop their callbacks now,
        # rather than waiting for each row's eventual destroy signal.
        for row in self.rows.values():
            row.cancel_dismissal()
        # Closing must not silently drop a click queued behind a poll. The
        # bounded worker drains pending operations before the process exits.
        self.worker.shutdown(wait=False)


class ReminderApplication(Gtk.Application):
    def __init__(self, paths: Paths):
        super().__init__(application_id=application_id(paths))
        self.paths = paths
        self.failed = False

    def do_startup(self) -> None:
        Gtk.Application.do_startup(self)
        try:
            self.css = Gtk.CssProvider()
            self.css.load_from_data(files("pinote.gui").joinpath("style.css").read_bytes())
            Gtk.StyleContext.add_provider_for_screen(
                Gdk.Screen.get_default(), self.css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            )
        except Exception:
            LOGGER.exception("Cannot load the reminder window style.")
            self.failed = True
            self.quit()

    def do_activate(self) -> None:
        if self.failed:
            return
        try:
            window = self.get_active_window()
            if window is None:
                window = ReminderWindow(self, ReminderModel(self.paths))
            window.present()
        except Exception:
            LOGGER.exception("Cannot open the reminder window.")
            self.failed = True
            self.quit()


def run(paths: Paths) -> int:
    if not Gtk.init_check()[0]:
        raise GuiUnavailable(
            "Cannot open a graphical display. Run pinote-gui in your desktop session."
        )
    try:
        Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as exc:
        raise GuiUnavailable(
            "Cannot connect to session D-Bus. Run inside your desktop session."
        ) from exc
    GLib.set_prgname("pinote-gui")
    GLib.set_application_name("pinote")
    application = ReminderApplication(paths)
    status = application.run(["pinote-gui"])
    return 1 if application.failed else status
