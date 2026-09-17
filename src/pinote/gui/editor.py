"""Nonblocking task editor. Save commits before a separate checklist refresh."""

from __future__ import annotations

import sqlite3
from concurrent.futures import Future
from datetime import UTC, datetime, timedelta

import gi

from pinote.logging_setup import LOGGER
from pinote.reminders import parse_reminder_time
from pinote.store import Note, NoteError

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402


class NoteEditor(Gtk.ApplicationWindow):
    def __init__(self, owner, note: Note, *, tag_only: bool = False, schedule_only: bool = False):
        title = "Set reminder" if schedule_only else "New tag" if tag_only else "Edit task"
        super().__init__(
            application=owner.get_application(),
            title=f"pinote — {title}",
            transient_for=owner,
            destroy_with_parent=True,
            modal=True,
        )
        self.owner = owner
        self.note = note  # Keep the displayed revision, even if the checklist polls.
        self.tag_only = tag_only
        self.schedule_only = schedule_only
        self.closed = False
        self.saving = False
        self.set_role("pinote-editor")
        self.set_decorated(False)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        self.set_position(Gtk.WindowPosition.CENTER_ON_PARENT)
        area = self.get_display().get_monitor_at_window(owner.get_window()).get_workarea()
        self.set_default_size(
            min(480, max(1, area.width - 50)), -1 if tag_only or schedule_only else 240
        )
        self.get_style_context().add_class("pinote-window")
        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        layout.get_style_context().add_class("reminder-panel")
        self.add(layout)
        layout.pack_start(Gtk.Label(label=title, xalign=0), False, False, 0)
        self.error_text = Gtk.Label(xalign=0)
        self.error_text.set_line_wrap(True)
        self.error_text.set_max_width_chars(45)
        self.error_text.set_no_show_all(True)
        layout.pack_start(self.error_text, False, False, 0)
        if schedule_only:
            when = (
                datetime.fromisoformat(note.remind_at).astimezone()
                if note.remind_at
                else (datetime.now(UTC) + timedelta(hours=1)).astimezone()
            )
            layout.pack_start(
                Gtk.Label(label="Local date and time (24-hour clock)", xalign=0), False, False, 0
            )
            self.entry = Gtk.Calendar()
            self.entry.get_accessible().set_name("Reminder date")
            self.entry.select_month(when.month - 1, when.year)
            self.entry.select_day(when.day)
            layout.pack_start(self.entry, False, False, 0)
            time = Gtk.Box(spacing=6)
            time.pack_start(Gtk.Label(label="Time"), False, False, 0)
            self.hour = Gtk.SpinButton.new_with_range(0, 23, 1)
            self.minute = Gtk.SpinButton.new_with_range(0, 59, 1)
            for spin, value, name in (
                (self.hour, when.hour, "Hour"),
                (self.minute, when.minute, "Minute"),
            ):
                spin.set_numeric(True)
                spin.set_width_chars(2)
                spin.get_accessible().set_name(name)
                spin.connect("output", self._format_time)
                spin.set_value(value)
            time.pack_start(self.hour, False, False, 0)
            time.pack_start(Gtk.Label(label=":"), False, False, 0)
            time.pack_start(self.minute, False, False, 0)
            layout.pack_start(time, False, False, 0)
        elif tag_only:
            self.entry = Gtk.Entry()
            self.entry.set_placeholder_text("Tag name (up to 64 characters)")
            self.entry.get_accessible().set_name("Tag name")
            self.entry.connect("activate", lambda _entry: self._save())
            layout.pack_start(self.entry, False, False, 0)
        else:
            self.entry = Gtk.TextView(
                wrap_mode=Gtk.WrapMode.WORD_CHAR,
                accepts_tab=False,
                left_margin=6,
                right_margin=6,
                top_margin=6,
                bottom_margin=6,
            )
            self.entry.get_accessible().set_name("Task text")
            self.entry.get_accessible().set_description(
                "Enter inserts a newline; Ctrl+Enter saves. Escape cancels."
            )
            self.entry.get_buffer().set_text(note.text)
            scroll = Gtk.ScrolledWindow()
            scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            scroll.get_style_context().add_class("task-entry")
            scroll.add(self.entry)
            layout.pack_start(scroll, True, True, 0)
        controls = Gtk.Box(spacing=8, halign=Gtk.Align.END)
        self.cancel_button = Gtk.Button(label="Cancel")
        self.save_button = Gtk.Button(label="Set reminder" if schedule_only else "Save")
        self.cancel_button.connect("clicked", lambda _button: self.close())
        self.save_button.connect("clicked", lambda _button: self._save())
        controls.add(self.cancel_button)
        controls.add(self.save_button)
        layout.pack_start(controls, False, False, 0)
        self.connect("key-press-event", self._key_press)
        self.connect("delete-event", lambda *_args: self.saving)
        self.connect("destroy", self._on_destroy)
        self.show_all()
        self.entry.grab_focus()

    def _key_press(self, _window, event) -> bool:
        if event.keyval == Gdk.KEY_Escape:
            if not self.saving:
                self.close()
            return True
        if event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) and (
            event.state & Gdk.ModifierType.CONTROL_MASK
        ):
            self._save()
            return True
        return False

    @staticmethod
    def _format_time(spin) -> bool:
        spin.set_text(f"{spin.get_value_as_int():02d}")
        return True

    def _controls(self):
        controls = [self.entry, self.save_button, self.cancel_button]
        if self.schedule_only:
            controls.extend((self.hour, self.minute))
        return controls

    def _save(self) -> None:
        if self.closed or self.saving:
            return
        if self.schedule_only:
            self.hour.update()
            self.minute.update()
            year, month, day = self.entry.get_date()
            try:
                value = parse_reminder_time(
                    f"{year:04d}-{month + 1:02d}-{day:02d} "
                    f"{self.hour.get_value_as_int():02d}:{self.minute.get_value_as_int():02d}"
                )
            except NoteError as exc:
                self._error(str(exc))
                return
        elif self.tag_only:
            value = self.entry.get_text()
            if not value.strip():
                self._error("Enter a tag name, or Cancel to keep the current tag.")
                return
        else:
            buffer = self.entry.get_buffer()
            value = buffer.get_text(*buffer.get_bounds(), True)

        def operation():
            if self.schedule_only:
                return self.owner.model.schedule(self.note, value)
            if self.tag_only:
                return self.owner.model.set_tag(self.note, value)
            return self.owner.model.edit(self.note, value)

        self.saving = True
        for control in self._controls():
            control.set_sensitive(False)
        future = self.owner.worker.submit(operation)

        def completed(result):
            if self.closed or self.owner.closed:
                self.owner._finish_after_close(result)
            else:
                GLib.idle_add(self._finish, result)

        future.add_done_callback(completed)

    def _finish(self, future: Future) -> bool:
        if self.closed or self.owner.closed:
            self.owner._finish_after_close(future)
            return GLib.SOURCE_REMOVE
        self.saving = False
        try:
            future.result()
        except BlockingIOError:
            self._error("Another note command is busy. Try again.")
        except (NoteError, OSError, sqlite3.Error) as exc:
            self._error(str(exc))
        except Exception:
            LOGGER.exception("Cannot save task changes.")
            self._error("Unexpected failure. Run note to check the saved state.")
        else:
            self.owner._poll()
            if self.owner.scheduled_window is not None:
                self.owner.scheduled_window._poll()
            self.destroy()
        if not self.closed:
            for control in self._controls():
                control.set_sensitive(True)
            self.entry.grab_focus()
        return GLib.SOURCE_REMOVE

    def _error(self, message: str) -> None:
        LOGGER.error("GUI editor: %s", message)
        self.error_text.set_text(message)
        self.error_text.show()

    def _on_destroy(self, _window) -> None:
        self.closed = True
        if self.owner.editor is self:
            self.owner.editor = None
        if not self.owner.closed:
            self.owner.entry.grab_focus()
