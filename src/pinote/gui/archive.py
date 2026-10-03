"""Scrollable archive window; shares the checklist's serialized worker."""

from __future__ import annotations

import sqlite3
from concurrent.futures import Future
from datetime import UTC, datetime

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, Pango  # noqa: E402

from pinote.gui.icons import TagLabel, icon_button  # noqa: E402
from pinote.gui.placement import place_child  # noqa: E402
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
        details = Gtk.Box(spacing=8)
        details.pack_start(self.date, False, False, 0)
        self.tag_badge = TagLabel()
        self.tag_badge.set_no_show_all(True)
        self.tag_badge.get_style_context().add_class("tag-badge")
        details.pack_start(self.tag_badge, False, False, 0)
        text.pack_start(details, False, False, 0)
        content.pack_start(text, True, True, 0)
        self.restore = icon_button("document-revert-symbolic", f"Restore note {note.id}")
        self.restore.get_style_context().add_class("restore-button")
        self.restore.get_accessible().set_name(f"Restore note {note.id}")
        self.restore.get_accessible().set_description("Return this task to the active list.")
        self.restore.connect("clicked", lambda _button: on_restore(note.id))
        content.pack_start(self.restore, False, False, 0)
        self.update(note, sensitive=True)

    def update(self, note: Note, *, sensitive: bool) -> None:
        self.note = note
        self.tag_badge.label.set_text(note.tag or "")
        self.tag_badge.set_tooltip_text(note.tag)
        self.tag_badge.set_visible(note.tag is not None)
        if self.body.get_text() != note.markdown:
            self.body.set_text(note.markdown)  # Literal text, never Pango markup.
        status = "Completed" if note.state == "done" else "Deleted"
        when = (
            datetime.fromisoformat(note.archived_at or note.updated_at)
            .astimezone()
            .strftime("%Y-%m-%d %H:%M:%S %Z")
        )
        label = f"{status} · {when}"
        if self.date.get_text() != label:
            self.date.set_text(label)
        self.restore.set_sensitive(sensitive)
        self.changed()


class SavedTasksWindow(Gtk.ApplicationWindow):
    """Shared polling, mutation and lifecycle for archive and scheduled lists."""

    heading = "Archive"
    role = "pinote-archive"
    list_method = "archive"
    action_method = "restore"
    empty_text = "No completed or deleted tasks."

    def _make_row(self, note: Note) -> ArchiveRow:
        return ArchiveRow(note, self._restore)

    def __init__(self, owner):
        super().__init__(
            application=owner.get_application(),
            title=f"pinote — {self.heading}",
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
        self._notes: list[Note] = []
        self.set_role(self.role)
        self.set_decorated(False)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        place_child(self, owner)
        area = self.get_display().get_monitor_at_window(owner.get_window()).get_workarea()
        self.set_default_size(min(640, max(1, area.width - 50)), min(440, max(1, area.height - 80)))
        self.get_style_context().add_class("pinote-window")
        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        layout.get_style_context().add_class("reminder-panel")
        self.add(layout)
        header = Gtk.Box(spacing=12)
        header.pack_start(Gtk.Label(label=self.heading, xalign=0), True, True, 0)
        if self.heading == "Archive":
            self.archive_filter = Gtk.ComboBoxText()
            for label in ("All", "1d", "7d"):
                self.archive_filter.append_text(label)
            self.archive_filter.set_active(0)
            self.archive_filter.get_accessible().set_name("Archive filter")
            self.archive_filter.get_accessible().set_description(
                "Show all archived tasks, or tasks updated in the last 1 or 7 days."
            )
            self.archive_filter.connect("changed", self._filter_changed)
            header.pack_start(self.archive_filter, False, False, 0)
        self.close_button = icon_button(
            "window-close-symbolic", f"Close {self.heading.lower()} (Esc)"
        )
        self.close_button.get_accessible().set_name(f"Close {self.heading.lower()} (Esc)")
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
        self.empty = Gtk.Label(label=f"Loading {self.heading.lower()}…")
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
        a = (left.note.archived_at or left.note.updated_at, left.note.id)
        b = (right.note.archived_at or right.note.updated_at, right.note.id)
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
            self._submit(getattr(self.model, self.list_method))
        return GLib.SOURCE_CONTINUE

    def _restore(self, note_id: int) -> None:
        row = self.rows.get(note_id)
        if self.closed or self.action_pending or row is None:
            return
        note = row.note
        self.owner._dismiss_feedback()
        self.action_pending = True
        self._update_controls()
        self._submit(lambda: getattr(self.model, self.action_method)(note), note_id=note_id)

    def _submit(self, operation, *, note_id: int | None = None) -> None:
        self.pending += 1
        future = self.owner.worker.submit(operation)

        def completed(result):
            if self.owner.closed:
                self.owner._finish_after_close(result)
            else:
                GLib.idle_add(self._finish, result, note_id)

        future.add_done_callback(completed)

    def _notify_restored(self, note_id: int) -> None:
        note = next((note for note in self._notes if note.id == note_id), None)
        if note is not None and not self.owner.closed:
            self.owner._task_saved(note_id, "Restored", note.tag)

    def _finish(self, future: Future, note_id: int | None) -> bool:
        if self.closed:
            try:
                result = future.result()
            except Exception:
                self.owner._finish_after_close(future)
            else:
                if note_id is not None and result and not self.owner.closed:
                    self._notify_restored(note_id)
                    self.owner._poll()
            return GLib.SOURCE_REMOVE
        self.pending -= 1
        mutation = note_id is not None
        if mutation:
            self.action_pending = False
        try:
            result = future.result()
            if mutation:
                if result:
                    self._notify_restored(note_id)
                    # The save is committed: remove its button before refreshing,
                    # even if that read fails. Never invite a duplicate restore.
                    self._notes = [note for note in self._notes if note.id != note_id]
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
            LOGGER.exception("Unexpected %s operation failure.", self.heading.lower())
            self._error("Unexpected failure. Run note to check the saved state.", action=mutation)
        else:
            self.last_error = None
            if mutation and not result:
                self._error("This task changed elsewhere. Refreshing the list.", action=True)
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
            row.update(row.note, sensitive=not self.closed and not self.action_pending)

    def _update_count(self) -> None:
        period = None
        if self.heading == "Archive":
            period = {"1d": "past 24 hours", "7d": "past 7 days"}.get(
                self.archive_filter.get_active_text()
            )
        self.empty.set_text(
            f"No completed or deleted tasks in the {period}." if period else self.empty_text
        )
        heading = f"{self.heading}, {period}" if period else self.heading
        self.list_box.get_accessible().set_name(f"{heading}, {len(self.rows)} tasks")

    def _filter_changed(self, _combo) -> None:
        self._render(self._notes)

    def _filtered_notes(self, notes: list[Note]) -> list[Note]:
        if self.heading != "Archive":
            return notes
        choice = self.archive_filter.get_active_text()
        if choice == "All":
            return notes
        seconds = 86400 if choice == "1d" else 7 * 86400
        now = datetime.now(UTC)
        return [
            note
            for note in notes
            if (
                now - datetime.fromisoformat(note.archived_at or note.updated_at).astimezone(UTC)
            ).total_seconds()
            <= seconds
        ]

    def _render(self, notes: list[Note]) -> None:
        self._notes = notes
        notes = self._filtered_notes(notes)
        wanted = {note.id for note in notes}
        for note_id in self.rows.keys() - wanted:
            self.rows.pop(note_id).destroy()
        for note in notes:
            if note.id not in self.rows:
                row = self._make_row(note)
                self.rows[note.id] = row
                self.list_box.add(row)
                row.show_all()
            self.rows[note.id].update(note, sensitive=not self.action_pending)
        self._update_count()

    def _error(self, message: str, *, action: bool) -> None:
        if message != self.last_error:
            LOGGER.error("%s: %s", self.heading, message)
            self.last_error = message
        self.error_is_action = action or self.error_is_action
        self.error_text.set_text(message)
        self.notice.show()

    def _on_destroy(self, _window) -> None:
        self.closed = True
        GLib.source_remove(self.refresh_source)
        # The checklist owns the shared worker. Closing this window never
        # cancels an accepted restore or shuts down the still-open checklist.


class ArchiveWindow(SavedTasksWindow):
    """Completed and removed tasks, newest first."""
