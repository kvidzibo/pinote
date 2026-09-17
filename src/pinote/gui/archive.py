"""Scrollable archive window; shares the checklist's serialized worker."""

from __future__ import annotations

import sqlite3
from concurrent.futures import Future
from datetime import datetime

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, Pango  # noqa: E402

from pinote.logging_setup import LOGGER  # noqa: E402
from pinote.store import Note, NoteError  # noqa: E402


class ArchiveRow(Gtk.ListBoxRow):
    def __init__(self, note: Note, on_restore):
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
        self.body.set_max_width_chars(58)
        self.date = Gtk.Label(xalign=0, selectable=True)
        self.date.set_line_wrap(True)
        self.date.get_style_context().add_class("dim-label")
        text.pack_start(self.body, False, False, 0)
        text.pack_start(self.date, False, False, 0)
        content.pack_start(text, True, True, 0)
        self.restore = Gtk.Button(label="Restore", valign=Gtk.Align.START)
        self.restore.get_style_context().add_class("restore-button")
        self.restore.get_accessible().set_name(f"Restore note {note.id}")
        self.restore.get_accessible().set_description("Return this task to the active list.")
        self.restore.connect("clicked", lambda _button: on_restore(note.id))
        content.pack_start(self.restore, False, False, 0)
        self.update(note, sensitive=True)

    def update(self, note: Note, *, sensitive: bool) -> None:
        self.note = note
        if self.body.get_text() != note.text:
            self.body.set_text(note.text)  # Literal text, never Pango markup.
        status = "Completed" if note.state == "done" else "Deleted"
        when = datetime.fromisoformat(note.updated_at).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
        label = f"{status} · {when}"
        if self.date.get_text() != label:
            self.date.set_text(label)
        self.restore.set_sensitive(sensitive)
        self.changed()


class ArchiveWindow(Gtk.ApplicationWindow):
    def __init__(self, owner):
        super().__init__(
            application=owner.get_application(),
            title="pinote — Archive",
            transient_for=owner,
            destroy_with_parent=True,
        )
        self.owner = owner
        self.model = owner.model
        self.closed = False
        self.pending = 0
        self.action_pending = False
        self.error_is_action = False
        self.last_error = None
        self.rows: dict[int, ArchiveRow] = {}
        self.set_role("pinote-archive")
        self.set_decorated(False)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        self.set_position(Gtk.WindowPosition.CENTER_ON_PARENT)
        area = self.get_display().get_monitor_at_window(owner.get_window()).get_workarea()
        self.set_default_size(min(640, max(1, area.width - 50)), min(440, max(1, area.height - 80)))
        self.get_style_context().add_class("pinote-window")
        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        layout.get_style_context().add_class("reminder-panel")
        self.add(layout)
        header = Gtk.Box(spacing=12)
        header.pack_start(Gtk.Label(label="Archive", xalign=0), True, True, 0)
        self.close_button = Gtk.Button(label="Close")
        self.close_button.get_accessible().set_name("Close archive (Esc)")
        self.close_button.connect("clicked", lambda _button: self.close())
        header.pack_start(self.close_button, False, False, 0)
        layout.pack_start(header, False, False, 0)
        self.notice = Gtk.InfoBar(message_type=Gtk.MessageType.ERROR, show_close_button=True)
        self.notice.set_no_show_all(True)
        self.error_text = Gtk.Label(xalign=0)
        self.error_text.set_line_wrap(True)
        self.error_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.error_text.set_max_width_chars(58)
        self.notice.get_content_area().add(self.error_text)
        self.notice.get_content_area().show_all()
        self.notice.connect("response", lambda *_args: self.notice.hide())
        layout.pack_start(self.notice, False, False, 0)
        self.list_box = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.list_box.get_style_context().add_class("reminder-list")
        self.list_box.set_sort_func(self._sort_rows)
        self.empty = Gtk.Label(label="Loading archive…")
        self.empty.get_style_context().add_class("dim-label")
        self.empty.set_margin_top(12)
        self.empty.show()
        self.list_box.set_placeholder(self.empty)
        self.scroll = Gtk.ScrolledWindow()
        self.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.scroll.add(self.list_box)
        layout.pack_start(self.scroll, True, True, 0)
        self.connect("key-press-event", self._on_key_press)
        self.connect("destroy", self._on_destroy)
        self.show_all()
        self.refresh_source = GLib.timeout_add(1000, self._poll)
        self._poll()

    @staticmethod
    def _sort_rows(left, right) -> int:
        a = (left.note.updated_at, left.note.id)
        b = (right.note.updated_at, right.note.id)
        return (b > a) - (b < a)

    def _on_key_press(self, _window, event) -> bool:
        if event.keyval == Gdk.KEY_Escape:
            self.close()
            return True
        return False

    def _poll(self) -> bool:
        if self.closed:
            return GLib.SOURCE_REMOVE
        if not self.pending:
            self._submit(self.model.archive)
        return GLib.SOURCE_CONTINUE

    def _restore(self, note_id: int) -> None:
        row = self.rows.get(note_id)
        if self.closed or self.action_pending or row is None:
            return
        note = row.note
        self.action_pending = True
        self._update_controls()
        self._submit(lambda: self.model.restore(note), note_id=note_id)

    def _submit(self, operation, *, note_id: int | None = None) -> None:
        self.pending += 1
        future = self.owner.worker.submit(operation)

        def completed(result):
            if self.closed:
                self.owner._finish_after_close(result)
            else:
                GLib.idle_add(self._finish, result, note_id)

        future.add_done_callback(completed)

    def _finish(self, future: Future, note_id: int | None) -> bool:
        if self.closed:
            self.owner._finish_after_close(future)
            return GLib.SOURCE_REMOVE
        self.pending -= 1
        mutation = note_id is not None
        if mutation:
            self.action_pending = False
        try:
            result = future.result()
            if mutation:
                if result:
                    # The save is committed: remove its button before refreshing,
                    # even if that read fails. Never invite a duplicate restore.
                    row = self.rows.pop(note_id, None)
                    if row is not None:
                        row.destroy()
                    self._update_count()
            else:
                self._render(result)
        except BlockingIOError:
            self._error("Another note command is busy. Try again.", action=mutation)
        except (NoteError, OSError, sqlite3.Error) as exc:
            self._error(f"{exc}\nRun note to check the saved state.", action=mutation)
        except Exception:
            LOGGER.exception("Unexpected archive operation failure.")
            self._error("Unexpected failure. Run note to check the saved state.", action=mutation)
        else:
            self.last_error = None
            if mutation and not result:
                self._error("This task changed elsewhere. Refreshing the archive.", action=True)
            elif mutation or not self.error_is_action:
                self.notice.hide()
                self.error_is_action = False
            if mutation:
                self._poll()
                self.owner._poll()
        finally:
            self._update_controls()
        return GLib.SOURCE_REMOVE

    def _update_controls(self) -> None:
        for row in self.rows.values():
            row.restore.set_sensitive(not self.closed and not self.action_pending)

    def _update_count(self) -> None:
        self.empty.set_text("No completed or deleted tasks.")
        self.list_box.get_accessible().set_name(f"Archive, {len(self.rows)} tasks")

    def _render(self, notes: list[Note]) -> None:
        wanted = {note.id for note in notes}
        for note_id in self.rows.keys() - wanted:
            self.rows.pop(note_id).destroy()
        for note in notes:
            if note.id not in self.rows:
                row = ArchiveRow(note, self._restore)
                self.rows[note.id] = row
                self.list_box.add(row)
                row.show_all()
            self.rows[note.id].update(note, sensitive=not self.action_pending)
        self._update_count()

    def _error(self, message: str, *, action: bool) -> None:
        if message != self.last_error:
            LOGGER.error("Archive: %s", message)
            self.last_error = message
        self.error_is_action = action or self.error_is_action
        self.error_text.set_text(message)
        self.notice.show()

    def _on_destroy(self, _window) -> None:
        self.closed = True
        GLib.source_remove(self.refresh_source)
        # The checklist owns the shared worker. Closing this window never
        # cancels an accepted restore or shuts down the still-open checklist.
