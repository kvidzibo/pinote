"""Nonblocking task editor. Save commits before a separate checklist refresh."""

from __future__ import annotations

import json
import sqlite3
from concurrent.futures import Future
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import gi

from pinote.logging_setup import LOGGER
from pinote.reminders import parse_reminder_time
from pinote.store import Note, NoteError

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

from pinote.gui.draft import DraftCache  # noqa: E402
from pinote.gui.icons import icon_button  # noqa: E402
from pinote.gui.placement import place_child  # noqa: E402


class NoteEditor(Gtk.ApplicationWindow):
    def __init__(
        self, owner, note: Note | None, *, tag_only: bool = False, schedule_only: bool = False
    ):
        if note is None and (not tag_only or schedule_only):
            raise ValueError("A task is required for editing or scheduling")
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
        self.draft: DraftCache | None = None
        self.draft_source = 0
        self.draft_revision = 0
        self.draft_load_failed = False
        self.set_role("pinote-editor")
        self.set_decorated(False)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        place_child(self, owner)
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
                "Enter inserts a newline; Ctrl+Enter saves. Escape closes and keeps the draft."
            )
            self.entry.get_buffer().set_text(self._restore_draft(note))
            hint = Gtk.Label(label="Edits are kept as a draft until saved.", xalign=0)
            hint.get_style_context().add_class("dim-label")
            layout.pack_start(hint, False, False, 0)
            scroll = Gtk.ScrolledWindow()
            scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            scroll.get_style_context().add_class("task-entry")
            scroll.add(self.entry)
            layout.pack_start(scroll, True, True, 0)
        controls = Gtk.Box(spacing=8, halign=Gtk.Align.END)
        if self.draft is not None:
            self.discard_button = icon_button("edit-delete-symbolic", "Discard draft")
            self.discard_button.connect("clicked", lambda _button: self._discard_draft())
            controls.add(self.discard_button)
        self.cancel_button = icon_button(
            "window-close-symbolic", "Close editor (keep draft)" if self.draft else "Cancel"
        )
        self.save_button = icon_button(
            "preferences-system-notifications-symbolic"
            if schedule_only
            else "document-save-symbolic",
            "Set reminder" if schedule_only else "Save",
        )
        self.cancel_button.connect("clicked", lambda _button: self.close())
        self.save_button.connect("clicked", lambda _button: self._save())
        if self.draft_load_failed:
            self.entry.set_editable(False)
            self.save_button.set_sensitive(False)
        controls.add(self.cancel_button)
        controls.add(self.save_button)
        layout.pack_start(controls, False, False, 0)
        self.connect("key-press-event", self._key_press)
        self.connect("delete-event", lambda *_args: self.saving)
        self.connect("destroy", self._on_destroy)
        if self.draft is not None:
            self.entry.get_buffer().connect("changed", self._draft_changed)
        self.show_all()
        self.entry.grab_focus()

    def _restore_draft(self, note: Note) -> str:
        self.draft = self.owner.edit_drafts.get(note.id)
        try:
            if self.draft is None:
                self.draft = DraftCache(
                    self.owner.model.paths.data / "gui-edit-drafts" / f"{note.id}.json"
                )
                payload = self.draft.load()
            else:
                payload = self.draft.snapshot()
            if not payload:
                self.owner.edit_drafts[note.id] = self.draft
                return note.text
            data = json.loads(payload)
            if (
                not isinstance(data, dict)
                or set(data) != {"updated_at", "original_text", "text"}
                or any(not isinstance(value, str) for value in data.values())
            ):
                raise ValueError("Invalid edit-draft record")
            self.owner.edit_drafts[note.id] = self.draft
            if data["updated_at"] != note.updated_at and data["text"].strip() == note.text:
                # A previous process committed the edit before clearing its cache.
                self.draft.update("")
                self.owner.worker.submit(self._persist_draft)
                return note.text
            self.draft_revision = self.draft.update(payload)
            self.note = replace(note, text=data["original_text"], updated_at=data["updated_at"])
            if self.note.updated_at != note.updated_at:
                self._error(
                    "This task changed elsewhere. Draft restored; copy it before discarding "
                    "the draft and reopening the latest task."
                )
            return data["text"]
        except (OSError, UnicodeError, ValueError) as exc:
            self.draft_load_failed = True
            self.owner.edit_drafts.pop(note.id, None)
            self._error(f"Cannot restore the edit draft: {exc}. Close and retry, or discard it.")
            return note.text

    def _draft_changed(self, _buffer) -> None:
        if self.closed or self.draft_load_failed:
            return
        buffer = self.entry.get_buffer()
        text = buffer.get_text(*buffer.get_bounds(), True)
        payload = (
            json.dumps(
                {"updated_at": self.note.updated_at, "original_text": self.note.text, "text": text},
                ensure_ascii=False,
            )
            if text != self.note.text
            else ""
        )
        self.draft_revision = self.draft.update(payload)
        if not self.draft_source:
            self.draft_source = GLib.timeout_add(250, self._queue_draft_save)

    def _queue_draft_save(self) -> bool:
        self.draft_source = 0
        self.owner.worker.submit(self._persist_draft)
        return GLib.SOURCE_REMOVE

    def _persist_draft(self) -> None:
        if self.draft_load_failed:
            return
        try:
            self.draft.save()
        except (OSError, UnicodeError) as exc:
            message = f"Cannot save the edit draft; it may be lost on restart: {exc}"
            LOGGER.error("GUI editor: %s", message)
            if not self.owner.closed:
                GLib.idle_add(self._show_draft_error, message)

    def _show_draft_error(self, message: str) -> bool:
        if not self.owner.closed:
            if self.closed:
                self.owner._error(message, action=True)
            else:
                self._error(message)
        return GLib.SOURCE_REMOVE

    def _discard_draft(self) -> None:
        if not self.closed and not self.saving:
            self.draft_load_failed = False
            self.draft.update("")
            self.destroy()

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
        if self.draft is not None:
            controls.append(self.discard_button)
        return controls

    def _save(self) -> None:
        if self.closed or self.saving or self.draft_load_failed:
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
            if self.note is None:
                return self.owner.model.create_tag(value)
            if self.schedule_only:
                return self.owner.model.schedule(self.note, value)
            if self.tag_only:
                return self.owner.model.set_tag(self.note, value)
            result = self.owner.model.edit(self.note, value)
            self.draft.submitted(draft_revision)
            self._persist_draft()  # Cache failure must not disguise a committed edit.
            return result

        draft_revision = self.draft_revision
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
            result = future.result()
        except BlockingIOError:
            self._error("Another note command is busy. Try again.")
        except (NoteError, OSError, sqlite3.Error) as exc:
            self._error(str(exc))
        except Exception:
            LOGGER.exception("Cannot save task changes.")
            self._error("Unexpected failure. Run note to check the saved state.")
        else:
            if self.note is None:
                self.owner._tags_changed(None, result)
                self.owner._select_creation_tag(result)
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
        if self.draft_source:
            GLib.source_remove(self.draft_source)
            self.draft_source = 0
        if self.draft is not None:
            # Run after accepted edits, so their cleared draft cannot be resurrected.
            self.owner.worker.submit(self._persist_draft)
        if self.owner.editor is self:
            self.owner.editor = None
        if not self.owner.closed:
            self.owner.entry.grab_focus()
