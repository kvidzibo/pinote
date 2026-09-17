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
from pinote.gui.archive import ArchiveWindow  # noqa: E402
from pinote.gui.config import GuiConfig  # noqa: E402
from pinote.gui.model import ReminderModel, application_id  # noqa: E402
from pinote.gui.text import NotePreview, TaskEntry  # noqa: E402
from pinote.logging_setup import LOGGER  # noqa: E402
from pinote.paths import Paths  # noqa: E402
from pinote.store import Note, NoteError  # noqa: E402


def icon_button(icon: str, description: str) -> Gtk.Button:
    image = Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.MENU)
    image.set_pixel_size(12)
    button = Gtk.Button(image=image, valign=Gtk.Align.START)
    button.set_relief(Gtk.ReliefStyle.NONE)
    button.get_accessible().set_name(description)
    return button


class NoteRow(Gtk.ListBoxRow):
    DONE_HOLD_MS = 200
    EXIT_MS = 200  # Keep the CSS opacity transition in sync.

    def __init__(self, note: Note, on_action, on_preview):
        super().__init__()
        self.note = note
        self.on_action = on_action
        self.deletion_marked = False
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
        self.check_handler = self.done.connect("clicked", self._check_clicked)
        self.done.connect("button-press-event", self._check_pressed)
        self.done.connect("button-release-event", lambda _button, event: event.button == 3)
        content.pack_start(self.done, False, False, 0)
        # Never treat stored text as Pango markup, commands, or widget source.
        self.body = Gtk.Label(
            label=note.text.split("\n", 1)[0], xalign=0, yalign=0, selectable=True
        )
        self.body.set_line_wrap(True)
        self.body.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.body.set_max_width_chars(42)
        self.body.set_hexpand(True)
        self.body.set_margin_top(3)
        content.pack_start(self.body, True, True, 0)
        self.preview_button = icon_button("view-reveal-symbolic", f"Preview note {note.id}")
        self.preview_button.set_no_show_all(True)
        self.preview_button.get_accessible().set_description("Show the full multiline task.")
        self.preview_button.connect("clicked", lambda _button: on_preview(note.id))
        content.pack_start(self.preview_button, False, False, 0)

    def _check_clicked(self, _button) -> None:
        if self.done.get_sensitive() and not self.exiting:
            if self.deletion_marked:
                self.deletion_marked = False
                self.update(self.note, sensitive=True)
                return
            action = "done" if self.note.state == "in_progress" else "start"
            self.on_action(self.note.id, action)

    def _check_pressed(self, _button, event) -> bool:
        if event.button != 3:
            return False
        if (
            event.type == Gdk.EventType.BUTTON_PRESS
            and self.done.get_sensitive()
            and not self.exiting
        ):
            if self.note.state == "in_progress":
                self.on_action(self.note.id, "reset")
            elif self.deletion_marked:
                self.on_action(self.note.id, "rm")
            else:
                self.deletion_marked = True
                self.update(self.note, sensitive=True)
        return True  # Right-click must not run the normal checkbox activation.

    def _set_checkbox(self, *, active: bool, progress: bool) -> None:
        # GtkToggleButton.set_active can emit clicked as well as toggled. A
        # refresh/error/animation must never submit another user action.
        self.done.handler_block(self.check_handler)
        try:
            self.done.set_inconsistent(progress)
            self.done.set_active(active)
        finally:
            self.done.handler_unblock(self.check_handler)

    def update(self, note: Note, *, sensitive: bool) -> None:
        if note != self.note or note.state != "active":
            # Only unchanged empty tasks can keep a deletion confirmation.
            self.deletion_marked = False
        if note.text != self.note.text:
            self.body.set_text(note.text.split("\n", 1)[0])
        self.note = note
        self.preview_button.set_visible("\n" in note.text)
        self.preview_button.set_sensitive(not self.exiting)
        sensitive = sensitive and not self.exiting
        self.done.set_sensitive(sensitive)
        if not self.exiting:
            progress = note.state == "in_progress"
            marked = self.deletion_marked
            self._set_checkbox(active=progress or marked, progress=progress or marked)
            context = self.get_style_context()
            for style, enabled in (("in-progress", progress), ("deletion-marked", marked)):
                if enabled:
                    context.add_class(style)
                else:
                    context.remove_class(style)
            if marked:
                name = f"Cancel deletion of note {note.id}"
                description = (
                    "Marked for deletion. Right-click again to delete; left-click to cancel."
                )
            else:
                name = (
                    f"Complete note {note.id} (in progress)"
                    if progress
                    else f"Start note {note.id}"
                )
                description = (
                    "Left-click to complete; right-click to clear progress."
                    if progress
                    else "Left-click to start; right-click to mark for deletion."
                )
            self.done.get_accessible().set_name(name)
            self.done.get_accessible().set_description(description)

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
            self.get_style_context().remove_class("in-progress")
            self.get_style_context().add_class("completed")
            self._set_checkbox(active=True, progress=False)
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
    def __init__(self, application: Gtk.Application, model: ReminderModel, config: GuiConfig):
        super().__init__(application=application, title="pinote — Reminders")
        self.model = model
        self.config = config
        self.archive_window: ArchiveWindow | None = None
        self.preview: NotePreview | None = None
        self.reveal_note_id: int | None = None
        self.geometry_source = 0
        self.focus_source = 0
        self._configured_geometry = None
        self._initial_placement = True
        self._placement_requests: set[tuple[int, int]] = set()
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
        # Keep the original monitor choice, independent of keyboard focus, but
        # anchor the bottom edge rather than a fixed top-left y coordinate.
        area = self.get_display().get_monitor_at_point(25, 1300).get_workarea()
        width = min(420, max(1, area.width - 24))
        self.set_default_size(width, -1)
        self.anchor_x = max(area.x, min(25, area.x + area.width - width))
        self.anchor_bottom = area.y + area.height - 25
        self.move(self.anchor_x, max(area.y, self.anchor_bottom - 60))

        # i3 may initially offset a borderless client. Reapply on first map,
        # while later remaps preserve a manually moved bottom anchor.
        def place_once(window, _event):
            window.disconnect(placement_handler)
            window._queue_geometry()

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
        self.scroll.set_min_content_height(0)
        self.scroll.set_max_content_height(1)
        self.scroll.add(self.list_box)
        layout.pack_start(self.scroll, True, True, 0)

        self.composer = Gtk.Box(spacing=6)
        self.entry = TaskEntry()
        self.entry_scroll = Gtk.ScrolledWindow()
        self.entry_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.entry_scroll.set_min_content_height(0)
        self.entry_scroll.set_max_content_height(80)
        self.entry_scroll.set_propagate_natural_height(True)
        self.entry_scroll.get_style_context().add_class("task-entry")
        self.entry_scroll.add(self.entry)
        self.entry_scroll.connect("size-allocate", self._keep_entry_height)
        self.entry_box = Gtk.Overlay(hexpand=True)
        self.entry_box.add(self.entry_scroll)
        self.placeholder = Gtk.Label(
            label="Add a task…", halign=Gtk.Align.START, valign=Gtk.Align.START
        )
        self.placeholder.set_margin_start(7)
        self.placeholder.set_margin_top(4)
        self.placeholder.get_style_context().add_class("dim-label")
        self.placeholder.set_no_show_all(True)
        self.placeholder.show()
        self.entry_box.add_overlay(self.placeholder)
        self.entry_box.set_overlay_pass_through(self.placeholder, True)
        self.entry.connect("focus-in-event", self._entry_focus)
        self.entry.connect("focus-out-event", self._entry_focus)
        self.add_button = icon_button("list-add-symbolic", "Add task")
        self.add_button.set_valign(Gtk.Align.CENTER)
        menu_icon = Gtk.Image.new_from_icon_name("open-menu-symbolic", Gtk.IconSize.MENU)
        menu_icon.set_pixel_size(12)
        self.menu_button = Gtk.MenuButton(image=menu_icon, valign=Gtk.Align.CENTER)
        self.menu_button.set_relief(Gtk.ReliefStyle.NONE)
        self.menu_button.get_accessible().set_name("Reminders menu")
        self.menu = Gtk.Popover.new(self.menu_button)
        self.menu.set_position(Gtk.PositionType.TOP)
        self.menu.set_no_show_all(True)
        self.menu.get_style_context().add_class("pinote-window")
        self.menu.get_style_context().add_class("reminder-menu")
        menu_items = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, border_width=4)
        self.archive_button = Gtk.Button(label="Archive…")
        self.close_menu_button = Gtk.Button(label="Close")
        self.close_menu_button.get_accessible().set_name("Close reminders (Esc)")
        menu_items.pack_start(self.archive_button, False, False, 0)
        menu_items.pack_start(self.close_menu_button, False, False, 0)
        self.menu.add(menu_items)
        menu_items.show_all()
        self.menu_button.set_popover(self.menu)
        self.entry.get_buffer().connect("changed", self._draft_changed)
        self.entry.connect("activate", lambda _entry: self._add())
        self.add_button.connect("clicked", lambda _button: self._add())
        self.archive_button.connect("clicked", lambda _button: self._open_archive())
        self.close_menu_button.connect("clicked", lambda _button: self.close())
        self.composer.pack_start(self.entry_box, True, True, 0)
        self.composer.pack_start(self.add_button, False, False, 0)
        self.composer.pack_start(self.menu_button, False, False, 0)
        layout.pack_start(self.composer, False, False, 0)
        self._update_controls()

        self.connect("key-press-event", self._on_key_press)
        self.connect("size-allocate", self._queue_geometry)
        self.list_box.connect("size-allocate", self._queue_geometry)
        self.scroll.get_vadjustment().connect("changed", self._queue_geometry)
        self.connect("configure-event", self._on_configure)
        for widget in (self, self.list_box, self.scroll):
            widget.add_events(Gdk.EventMask.BUTTON_RELEASE_MASK)
            widget.connect("event-after", self._after_pointer_event)
        self.connect("destroy", self._on_destroy)
        self.show_all()
        self.entry.grab_focus()
        self.refresh_source = GLib.timeout_add(1000, self._poll)
        self._poll()

    def _queue_geometry(self, *_args) -> None:
        if not self.closed and not self.geometry_source:
            self.geometry_source = GLib.idle_add(self._sync_geometry)

    def _sync_geometry(self) -> bool:
        self.geometry_source = 0
        if self.closed or not self.get_mapped():
            return GLib.SOURCE_REMOVE
        # Coalesce buffer changes: replacing selected text briefly deletes the
        # whole draft before inserting its replacement. Only collapse if it stays empty.
        if (
            not self.entry.get_buffer().get_char_count()
            and self.entry_scroll.get_min_content_height()
        ):
            self.entry_scroll.set_min_content_height(0)
        current = tuple(self.get_position())
        height = self.get_size().height
        if (
            not self._initial_placement
            and self._configured_geometry
            and current != self._configured_geometry[0]
            and current not in self._placement_requests
        ):
            # X11 can expose a manual move before GTK dispatches configure-event.
            # Never overwrite that move with an idle resize's old anchor.
            self.anchor_x = current[0]
            self.anchor_bottom = current[1] + height
        area = self.get_display().get_monitor_at_window(self.get_window()).get_workarea()
        self.anchor_bottom = min(self.anchor_bottom, area.y + area.height)
        width = self.list_box.get_allocated_width()
        rows = self.list_box.get_children()[: self.config.max_visible_notes]
        content_height = sum(row.get_preferred_height_for_width(width)[1] for row in rows)
        if not rows:
            content_height = self.empty.get_preferred_height_for_width(width)[1]
        # Measure chrome, including any error notice, rather than reserving a
        # fixed pixel budget that clips wrapped rows or the task entry.
        chrome = height - self.scroll.get_allocated_height()
        available = max(1, self.anchor_bottom - area.y - 25 - chrome)
        limit = min(max(1, content_height), available)
        if self.scroll.get_max_content_height() != limit:
            self.scroll.set_max_content_height(limit)
        position = (self.anchor_x, max(area.y, self.anchor_bottom - height))
        # Compare with the same snapshot used to update the anchor. A fresh
        # query can see a later manual move and undo it before its event arrives.
        if current != position:
            self._placement_requests.add(position)
            self.move(*position)
        # The first mapped pass has applied the WM correction. Its configure
        # acknowledgement can be coalesced with a drag; accept manual moves now.
        self._initial_placement = False
        if self.reveal_note_id is not None:
            row = self.rows.get(self.reveal_note_id)
            if row is not None:
                allocation = row.get_allocation()
                adjustment = self.scroll.get_vadjustment()
                top, bottom = allocation.y, allocation.y + allocation.height
                # Wait for both the new row and the resized viewport to be allocated.
                if (
                    allocation.height > 1
                    and self.scroll.get_allocated_height() == limit
                    and adjustment.get_upper() >= bottom
                ):
                    if (
                        top < adjustment.get_value()
                        or allocation.height > adjustment.get_page_size()
                    ):
                        adjustment.set_value(top)
                    elif bottom > adjustment.get_value() + adjustment.get_page_size():
                        adjustment.set_value(bottom - adjustment.get_page_size())
                    self.reveal_note_id = None
        return GLib.SOURCE_REMOVE

    def _on_configure(self, _window, event) -> bool:
        position = (event.x, event.y)
        size = (event.width, event.height)
        requested = position in self._placement_requests
        self._placement_requests.discard(position)
        # Old WM offsets can arrive after a placement acknowledgement. Ignore
        # events already superseded on X11 rather than moving the anchor back.
        if position != tuple(self.get_position()):
            return False
        previous = self._configured_geometry
        self._configured_geometry = (position, size)
        if requested:
            self._initial_placement = False
        if not self._initial_placement and previous and previous[0] != position and not requested:
            # A WM/user move can arrive together with an async content resize.
            # Only our tracked placement requests should be ignored.
            self.anchor_x = event.x
            self.anchor_bottom = event.y + event.height
            self._queue_geometry()
        return False

    def _after_pointer_event(self, _widget, event) -> None:
        if event.type != Gdk.EventType.BUTTON_RELEASE or event.get_button()[1] != 1 or self.closed:
            return
        target = Gtk.get_event_widget(event)
        label = target if isinstance(target, Gtk.Label) and target.get_selectable() else None
        while target is not None:
            if isinstance(target, (Gtk.Button, Gtk.TextView, Gtk.Range, Gtk.Popover)):
                return  # Keep buttons, editor/preview selection and scrollbar drags native.
            target = target.get_parent()
        if self.focus_source:
            GLib.source_remove(self.focus_source)
        # Run after GTK finishes selection and event propagation. Never steal
        # focus during a drag, or copy a previous selection on a background click.
        self.focus_source = GLib.idle_add(self._copy_and_focus, label)

    def _copy_and_focus(self, label) -> bool:
        self.focus_source = 0
        if not self.closed:
            if label is not None:
                selected, start, end = label.get_selection_bounds()
                if selected:
                    Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(
                        label.get_text()[start:end], -1
                    )
            self.entry.grab_focus()
        return GLib.SOURCE_REMOVE

    def _on_key_press(self, _window, event) -> bool:
        if event.keyval == Gdk.KEY_Escape:
            if self.preview is not None and self.preview.get_visible():
                self.preview.popdown()
            elif self.menu.get_visible():
                self.menu.popdown()
            else:
                self.close()
            return True
        return False

    def _open_preview(self, note_id: int) -> None:
        row = self.rows.get(note_id)
        if self.closed or row is None or row.exiting or "\n" not in row.note.text:
            return
        if self.focus_source:
            GLib.source_remove(self.focus_source)
            self.focus_source = 0
        if self.preview is not None:
            self._close_preview(self.preview)
        self.preview = NotePreview(row.preview_button, row.note)
        self.preview.connect("closed", self._close_preview)
        self.preview.popup()

    def _close_preview(self, preview: NotePreview) -> None:
        if self.preview is preview:
            self.preview = None
            preview.destroy()
            if not self.closed:
                self.entry.grab_focus()

    def _open_archive(self) -> None:
        if self.closed:
            return
        self.menu.popdown()
        if self.archive_window is None or self.archive_window.closed:
            self.archive_window = ArchiveWindow(self)
        self.archive_window.present()

    def _poll(self) -> bool:
        if self.closed:
            return GLib.SOURCE_REMOVE
        # No backlog of polls, and no poll can overtake a pending mutation.
        if not self.pending:
            self._submit(self.model.notes, action=None)
        return GLib.SOURCE_CONTINUE

    def _keep_entry_height(self, scroll, _allocation) -> None:
        if not self.closed and self.entry.get_buffer().get_char_count():
            # Keep the largest viewport reached by this draft, not GTK's changing
            # natural-size estimate. The child allocation excludes the scroll border.
            height = min(scroll.get_max_content_height(), self.entry.get_allocated_height())
            if height > scroll.get_min_content_height():
                scroll.set_min_content_height(height)

    def _entry_focus(self, _entry, event) -> bool:
        context = self.entry_scroll.get_style_context()
        if event.in_:
            context.add_class("focused")
        else:
            context.remove_class("focused")
        return False

    def _draft_changed(self, _buffer) -> None:
        self.draft_revision += 1
        self.placeholder.set_visible(not self.entry.get_text())
        self._update_add_button()
        self._queue_geometry()

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
                self.reveal_note_id = result
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
            if mutation and self.archive_window is not None:
                self.archive_window._poll()
        finally:
            self._update_controls()
        return GLib.SOURCE_REMOVE

    def _render(self, notes: list[Note], *, action: tuple[int, str] | None = None) -> None:
        wanted = {note.id for note in notes}
        if self.preview is not None and self.preview.note_id not in wanted:
            self._close_preview(self.preview)
        if self.reveal_note_id not in wanted:
            self.reveal_note_id = None
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
                row = NoteRow(note, self._act, self._open_preview)
                for widget in (row, row.body):
                    widget.connect("event-after", self._after_pointer_event)
                # Departing rows still occupy a slot until their animation ends.
                position = sum(note_id < note.id for note_id in self.rows)
                self.rows[note.id] = row
                self.list_box.insert(row, position)
                row.show_all()
            row = self.rows[note.id]
            if row.exiting:
                row.cancel_dismissal()
            row.update(note, sensitive=not self.action_pending)
            if self.preview is not None and self.preview.note_id == note.id:
                if "\n" in note.text:
                    self.preview.update(note)
                else:
                    self._close_preview(self.preview)
        self.empty.set_text("No active reminders.")
        self.list_box.get_accessible().set_name(
            f"Reminders, {len(notes)} active {'note' if len(notes) == 1 else 'notes'}"
        )
        self._queue_geometry()
        # Existing rows and the scroll adjustment are deliberately left intact.

    def _remove_row(self, row: NoteRow) -> None:
        if not self.closed and self.rows.get(row.note.id) is row:
            self.rows.pop(row.note.id)
            row.destroy()
            self._queue_geometry()

    def _error(self, message: str, *, action: bool) -> None:
        if message != self.last_error:
            LOGGER.error("GUI: %s", message)
            self.last_error = message
        self.error_is_action = action or self.error_is_action
        self.error_text.set_text(message)
        self.notice.show()

    def close(self) -> None:
        # GTK ignores close requests to a window blocked by a popup's grab.
        if self.preview is not None:
            self._close_preview(self.preview)
        Gtk.ApplicationWindow.close(self)

    def _on_destroy(self, _window) -> None:
        self.closed = True
        if self.preview is not None:
            self._close_preview(self.preview)
        if self.archive_window is not None and not self.archive_window.closed:
            self.archive_window.destroy()
        self.menu.destroy()
        GLib.source_remove(self.refresh_source)
        for source in (self.geometry_source, self.focus_source):
            if source:
                GLib.source_remove(source)
        self.geometry_source = self.focus_source = 0
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
        self.config = GuiConfig.load()
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
            window = next(
                (window for window in self.get_windows() if isinstance(window, ReminderWindow)),
                None,
            )
            if window is None:
                window = ReminderWindow(self, ReminderModel(self.paths), self.config)
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
