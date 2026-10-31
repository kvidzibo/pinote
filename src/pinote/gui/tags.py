"""Persistent tag management, using the checklist's serialized database worker."""

from __future__ import annotations

import sqlite3
from concurrent.futures import Future

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, Pango  # noqa: E402

from pinote.gui.icons import TagLabel, icon_button  # noqa: E402
from pinote.gui.placement import place_child  # noqa: E402
from pinote.logging_setup import LOGGER  # noqa: E402
from pinote.store import NoteError, validate_tag  # noqa: E402


class TagsWindow(Gtk.ApplicationWindow):
    def __init__(self, owner):
        super().__init__(
            application=owner.get_application(),
            title="pinote — Tags",
            transient_for=owner,
            destroy_with_parent=True,
            modal=True,
        )
        self.owner = owner
        self.closed = False
        self.pending = False
        self.saving = False
        self.selected: str | None = None
        self.requested_tag: str | None = None
        self.tags: list[str] = []
        self.folders: dict[str, str | None] = {}
        self.folder_dialog = None
        self.rows: dict[str, Gtk.ListBoxRow] = {}
        self.set_role("pinote-tags")
        self.set_decorated(False)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        place_child(self, owner)
        area = self.get_display().get_monitor_at_window(owner.get_window()).get_workarea()
        self.set_default_size(min(440, max(1, area.width - 50)), min(380, max(1, area.height - 80)))
        self.get_style_context().add_class("pinote-window")
        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        layout.get_style_context().add_class("reminder-panel")
        self.add(layout)
        header = Gtk.Box(spacing=8)
        header.pack_start(Gtk.Label(label="Tags", xalign=0), True, True, 0)
        self.new_button = icon_button("list-add-symbolic", "New tag")
        self.new_button.connect("clicked", lambda _button: self._new())
        header.pack_start(self.new_button, False, False, 0)
        self.close_button = icon_button("window-close-symbolic", "Close tags (Esc)")
        self.close_button.connect("clicked", lambda _button: self.close())
        header.pack_start(self.close_button, False, False, 0)
        layout.pack_start(header, False, False, 0)
        self.error_text = Gtk.Label(xalign=0, wrap=True)
        self.error_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.error_text.set_max_width_chars(48)
        self.error_text.set_no_show_all(True)
        layout.pack_start(self.error_text, False, False, 0)
        self.list_box = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.list_box.get_style_context().add_class("reminder-list")
        self.list_box.get_accessible().set_name("Saved tags")
        self.list_box.set_sort_func(self._sort_rows)
        empty = Gtk.Label(label="No tags yet. Enter a name below to create one.", wrap=True)
        empty.get_style_context().add_class("dim-label")
        empty.show()
        self.list_box.set_placeholder(empty)
        self.list_box.connect("row-selected", self._selected)
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.add(self.list_box)
        layout.pack_start(scroll, True, True, 0)
        form = Gtk.Box(spacing=8)
        self.entry = Gtk.Entry(hexpand=True)
        self.entry.set_placeholder_text("Tag name (up to 64 characters)")
        self.entry.get_accessible().set_name("Tag name")
        self.entry.connect("activate", lambda _entry: self._save())
        self.entry.connect("changed", lambda _entry: self._cancel_delete())
        form.pack_start(self.entry, True, True, 0)
        self.save_button = icon_button("document-save-symbolic", "Save tag")
        self.save_button.connect("clicked", lambda _button: self._save())
        form.pack_start(self.save_button, False, False, 0)
        self.delete_button = icon_button("edit-delete-symbolic", "Delete tag")
        self.delete_button.connect("clicked", lambda _button: self._confirm_delete())
        form.pack_start(self.delete_button, False, False, 0)
        layout.pack_start(form, False, False, 0)
        folder_form = Gtk.Box(spacing=8)
        self.folder_label = Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.MIDDLE)
        self.folder_label.set_max_width_chars(32)
        folder_form.pack_start(self.folder_label, True, True, 0)
        self.folder_button = icon_button("folder-symbolic", "Choose default folder")
        self.folder_button.connect("clicked", lambda _button: self._choose_folder())
        folder_form.pack_start(self.folder_button, False, False, 0)
        self.clear_folder_button = icon_button("window-close-symbolic", "Clear default folder")
        self.clear_folder_button.connect("clicked", lambda _button: self._set_folder(None))
        folder_form.pack_start(self.clear_folder_button, False, False, 0)
        layout.pack_start(folder_form, False, False, 0)
        self.confirmation = Gtk.Box(spacing=8)
        self.confirmation.set_no_show_all(True)
        self.confirm_text = Gtk.Label(xalign=0, wrap=True, hexpand=True)
        self.confirm_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.confirm_text.set_max_width_chars(38)
        self.confirmation.pack_start(self.confirm_text, True, True, 0)
        self.confirm_button = icon_button("edit-delete-symbolic", "Confirm delete tag")
        self.confirm_button.connect("clicked", lambda _button: self._delete())
        self.cancel_button = icon_button("window-close-symbolic", "Cancel tag deletion")
        self.cancel_button.connect("clicked", lambda _button: self._cancel_delete())
        self.confirmation.pack_start(self.confirm_button, False, False, 0)
        self.confirmation.pack_start(self.cancel_button, False, False, 0)
        for child in self.confirmation.get_children():
            child.show_all()
        layout.pack_start(self.confirmation, False, False, 0)
        self.connect("key-press-event", self._key_press)
        self.connect("delete-event", lambda *_args: self.saving)
        self.connect("destroy", self._destroyed)
        self.show_all()
        self._controls()
        self.refresh_source = GLib.timeout_add(1000, self._poll)
        self._poll()

    def _key_press(self, _window, event) -> bool:
        if event.keyval == Gdk.KEY_Escape:
            if not self.saving:
                if self.confirmation.get_visible():
                    self._cancel_delete()
                else:
                    self.close()
            return True
        return False

    def _controls(self) -> None:
        for widget in (
            self.list_box,
            self.entry,
            self.new_button,
            self.save_button,
            self.close_button,
        ):
            widget.set_sensitive(not self.saving)
        self.delete_button.set_sensitive(not self.saving and self.selected is not None)
        self.folder_button.set_sensitive(not self.saving and self.selected is not None)
        self.clear_folder_button.set_sensitive(
            not self.saving and bool(self.folders.get(self.selected))
        )
        self._update_folder()
        self.confirm_button.set_sensitive(not self.saving)
        self.cancel_button.set_sensitive(not self.saving)

    def _selected(self, _list, row) -> None:
        self.selected = row.tag if row else None
        self.entry.set_text(self.selected or "")
        self._cancel_delete()
        self._controls()

    def _new(self) -> None:
        self.list_box.unselect_all()
        self.entry.set_text("")
        self.entry.grab_focus()

    def _cancel_delete(self) -> None:
        if hasattr(self, "confirmation"):
            self.confirmation.hide()

    def _confirm_delete(self) -> None:
        if self.selected is not None and not self.saving:
            self.confirm_text.set_text(
                f"Delete {self.selected}? Clear it from all tasks, including archived "
                "and scheduled tasks. Tasks are kept."
            )
            self.confirmation.show()

    def _delete(self) -> None:
        if self.selected is not None and self.confirmation.get_visible():
            old = self.selected
            self._mutate(lambda: self.owner.model.delete_tag(old), old, None)

    def _update_folder(self) -> None:
        folder = self.folders.get(self.selected)
        text = folder or "No default folder — choose when starting"
        self.folder_label.set_text(text)
        self.folder_label.set_tooltip_text(text)

    def _choose_folder(self) -> None:
        if self.selected is None or self.saving or self.owner.action_pending:
            return
        if self.folder_dialog is not None:
            self.folder_dialog.present()
            return
        tag = self.selected
        dialog = Gtk.FileChooserDialog(
            title="Choose default folder",
            transient_for=self,
            modal=True,
            destroy_with_parent=True,
            use_header_bar=True,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        self.folder_dialog = dialog
        dialog.set_local_only(True)
        dialog.add_buttons("_Cancel", Gtk.ResponseType.CANCEL, "_Select", Gtk.ResponseType.ACCEPT)
        dialog.set_default_response(Gtk.ResponseType.ACCEPT)
        if self.folders.get(tag):
            dialog.set_current_folder(self.folders[tag])
        self.owner._watch_child_focus(dialog)

        def response(_dialog, result):
            folder = dialog.get_filename()
            dialog.destroy()
            if result == Gtk.ResponseType.ACCEPT and folder and not self.closed:
                self._mutate(lambda: self.owner.model.set_tag_folder(tag, folder), tag, tag)

        dialog.connect("response", response)
        dialog.connect("destroy", lambda _dialog: setattr(self, "folder_dialog", None))
        dialog.show()

    def _set_folder(self, folder: str | None) -> None:
        if self.selected is not None:
            tag = self.selected
            self._mutate(lambda: self.owner.model.set_tag_folder(tag, folder), tag, tag)

    def _save(self) -> None:
        try:
            name = validate_tag(self.entry.get_text())
            if name is None:
                raise NoteError("Enter a tag name.")
        except NoteError as exc:
            self._error(str(exc))
            return
        old = self.selected
        operation = (
            (lambda: self.owner.model.create_tag(name))
            if old is None
            else (lambda: self.owner.model.rename_tag(old, name))
        )
        self._mutate(operation, old, name)

    def _mutate(self, operation, old: str | None, new: str | None) -> None:
        if self.closed or self.saving or self.owner.action_pending:
            return
        self.saving = True
        self.owner.action_pending = True
        self.owner._update_controls()
        self._cancel_delete()
        self._controls()
        self._submit(operation, change=(old, new))

    def _poll(self) -> bool:
        if self.closed:
            return GLib.SOURCE_REMOVE
        if not self.pending and not self.saving:
            self._submit(self.owner.model.tag_folders)
        return GLib.SOURCE_CONTINUE

    def _submit(self, operation, *, change=None) -> None:
        self.pending = True
        future = self.owner.worker.submit(operation)

        def completed(result):
            if self.owner.closed:
                self.owner._finish_after_close(result)
            else:
                GLib.idle_add(self._finish, result, change)

        future.add_done_callback(completed)

    def _finish(self, future: Future, change) -> bool:
        if self.owner.closed:
            self.owner._finish_after_close(future)
            return GLib.SOURCE_REMOVE
        self.pending = False
        if change is not None:
            self.saving = False
            self.owner.action_pending = False
            if not self.owner.closed:
                self.owner._update_controls()
        try:
            result = future.result()
        except (NoteError, OSError, sqlite3.Error) as exc:
            self._error(str(exc))
        except Exception:
            LOGGER.exception("Cannot update tags.")
            self._error("Cannot update tags. Reopen Tags to check the saved state.")
        else:
            if change is None:
                if not self.closed:
                    self._render(result)
            else:
                old, new = change
                if old is None:
                    new = result  # Creation may reuse an existing tag's casing.
                self.owner._tags_changed(old, new)
                if not self.closed:
                    self.error_text.hide()
                    if old != new:
                        self._new()
                    self._poll()
        if not self.closed:
            self._controls()
        return GLib.SOURCE_REMOVE

    def select_tag(self, tag: str) -> None:
        if tag in self.rows:
            self.list_box.select_row(self.rows[tag])
            self.entry.grab_focus()
            self.requested_tag = None
        else:
            self.requested_tag = tag

    def _render(self, folders: dict[str, str | None]) -> None:
        self.folders = folders
        self._update_folder()
        tags = sorted(folders, key=lambda tag: (tag.casefold(), tag))
        if tags == self.tags:
            return
        self.tags = tags
        for tag in self.rows.keys() - set(tags):
            self.rows.pop(tag).destroy()
        for index, tag in enumerate(tags):
            if tag not in self.rows:
                row = Gtk.ListBoxRow()
                row.get_style_context().add_class("note-row")
                row.get_style_context().add_class("tag-manager-row")
                row.tag = tag
                label = TagLabel(tag, max_width_chars=42)
                label.set_margin_top(6)
                label.set_margin_bottom(6)
                label.set_tooltip_text(tag)
                row.add(label)
                self.rows[tag] = row
                self.list_box.insert(row, index)
                row.show_all()
        if self.requested_tag is not None:
            tag, self.requested_tag = self.requested_tag, None
            if tag in self.rows:
                self.select_tag(tag)

    @staticmethod
    def _sort_rows(left, right) -> int:
        a, b = (left.tag.casefold(), left.tag), (right.tag.casefold(), right.tag)
        return (a > b) - (a < b)

    def _error(self, message: str) -> None:
        LOGGER.error("GUI tags: %s", message)
        if not self.closed:
            self.error_text.set_text(message)
            self.error_text.show()

    def _destroyed(self, _window) -> None:
        self.closed = True
        GLib.source_remove(self.refresh_source)
        if self.owner.tags_window is self:
            self.owner.tags_window = None
