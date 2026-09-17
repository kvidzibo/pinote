"""Scheduled notes, separate from the active checklist until their due time."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Pango  # noqa: E402

from pinote.gui.archive import SavedTasksWindow  # noqa: E402
from pinote.reminders import local_reminder_time  # noqa: E402
from pinote.store import Note  # noqa: E402


class ScheduledRow(Gtk.ListBoxRow):
    def __init__(self, note: Note, on_release, on_change):
        super().__init__()
        self.note = note
        self.get_style_context().add_class("note-row")
        content = Gtk.Box(spacing=12)
        content.get_style_context().add_class("archive-content")
        self.add(content)
        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3, hexpand=True)
        self.body = Gtk.Label(xalign=0, selectable=True)
        self.body.set_line_wrap(True)
        self.body.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.body.set_max_width_chars(45)
        self.date = Gtk.Label(xalign=0, selectable=True)
        self.date.set_line_wrap(True)
        self.date.get_style_context().add_class("dim-label")
        text.pack_start(self.body, False, False, 0)
        text.pack_start(self.date, False, False, 0)
        content.pack_start(text, True, True, 0)
        controls = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, valign=Gtk.Align.START)
        self.change = Gtk.Button(label="Change time…")
        self.change.get_accessible().set_name(f"Change reminder time for note {note.id}")
        self.change.connect("clicked", lambda _button: on_change(note.id))
        self.restore = Gtk.Button(label="Move to main")
        self.restore.get_accessible().set_name(f"Move note {note.id} to main list now")
        self.restore.connect("clicked", lambda _button: on_release(note.id))
        for button in (self.change, self.restore):
            button.get_style_context().add_class("restore-button")
            controls.pack_start(button, False, False, 0)
        content.pack_start(controls, False, False, 0)
        self.update(note, sensitive=True)

    def update(self, note: Note, *, sensitive: bool) -> None:
        self.note = note
        if self.body.get_text() != note.text:
            self.body.set_text(note.text)
        label = local_reminder_time(note.remind_at)
        if note.tag:
            label += f" · #{note.tag}"
        if self.date.get_text() != label:
            self.date.set_text(label)
        self.restore.set_sensitive(sensitive)
        self.change.set_sensitive(sensitive)
        self.changed()


class ScheduledWindow(SavedTasksWindow):
    heading = "Reminders"
    role = "pinote-scheduled"
    list_method = "reminders"
    action_method = "release"
    empty_text = "No scheduled reminders. Right-click a task → Set reminder…"

    def _make_row(self, note: Note) -> ScheduledRow:
        return ScheduledRow(note, self._restore, self._change_time)

    @staticmethod
    def _sort_rows(left, right) -> int:
        a = (left.note.remind_at, left.note.id)
        b = (right.note.remind_at, right.note.id)
        return (a > b) - (a < b)

    def _change_time(self, note_id: int) -> None:
        row = self.rows.get(note_id)
        if not self.closed and not self.action_pending and row is not None:
            self.owner._open_schedule(row.note)
