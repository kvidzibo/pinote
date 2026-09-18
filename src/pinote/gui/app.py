"""GTK 3 presentation. Database work never runs on the GTK event thread."""

from __future__ import annotations

import sqlite3
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from importlib.resources import files

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango  # noqa: E402

from pinote.gui import GuiUnavailable  # noqa: E402
from pinote.gui.archive import ArchiveWindow  # noqa: E402
from pinote.gui.config import GuiConfig  # noqa: E402
from pinote.gui.draft import DraftCache  # noqa: E402
from pinote.gui.editor import NoteEditor  # noqa: E402
from pinote.gui.model import ReminderModel, application_id  # noqa: E402
from pinote.gui.reminders import ScheduledWindow  # noqa: E402
from pinote.gui.text import NotePreview, TaskEntry  # noqa: E402
from pinote.logging_setup import LOGGER  # noqa: E402
from pinote.paths import Paths  # noqa: E402
from pinote.reminders import relative_reminder_time  # noqa: E402
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

    def __init__(self, note: Note, on_action, on_preview, on_menu):
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
        self.body.connect("populate-popup", lambda _label, menu: on_menu(self.note.id, menu))
        content.pack_start(self.body, True, True, 0)
        self.reminder_icon = Gtk.Image.new_from_icon_name(
            "preferences-system-notifications-symbolic", Gtk.IconSize.MENU
        )
        self.reminder_icon.set_pixel_size(12)
        self.reminder_icon.set_valign(Gtk.Align.START)
        self.reminder_icon.set_margin_top(4)
        self.reminder_icon.set_no_show_all(True)
        self.reminder_icon.get_style_context().add_class("reminder-indicator")
        self.reminder_icon.get_accessible().set_name(f"Scheduled reminder for note {note.id}")
        content.pack_start(self.reminder_icon, False, False, 0)
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
        due_text = (
            f"Due {relative_reminder_time(note.reminder_due_at)}"
            if note.reminder_due_at is not None
            else None
        )
        reminder = f"Scheduled reminder. {due_text}. " if due_text else ""
        self.body.get_accessible().set_description(
            f"{reminder}Tag: {note.tag or 'Untagged'}. Right-click to edit or choose a tag."
        )
        if self.reminder_icon.get_tooltip_text() != due_text:
            self.reminder_icon.set_tooltip_text(due_text)
        self.reminder_icon.get_accessible().set_description(due_text or "")
        self.reminder_icon.set_visible(due_text is not None)
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
        self.scheduled_window: ScheduledWindow | None = None
        self.editor: NoteEditor | None = None
        self.preview: NotePreview | None = None
        self.context_menu: Gtk.Menu | None = None
        self.context_note_id: int | None = None
        self.tag_filter: str | None = ""  # Empty = Untagged; None = All.
        self.tags: list[str] = []
        self.notes_snapshot: list[Note] = []
        self.reveal_note_id: int | None = None
        self.geometry_source = 0
        self.focus_source = 0
        self.pin_source = 0
        self.handoff_source = 0
        self.focus_handoff: Gtk.Window | None = None
        self.deferred_progress: set[int] = set()
        self.starting_note_id: int | None = None
        self.loaded_notes = False
        self._configured_geometry = None
        self._initial_placement = True
        self._placement_requests: set[tuple[int, int]] = set()
        self.rows: dict[int, NoteRow] = {}
        self.closed = False
        self.pending = 0
        self.action_pending = False
        self.draft_revision = 0
        self.draft = DraftCache(model.paths.data / "gui-draft.txt")
        self.draft_source = 0
        self.draft_error: str | None = None
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

        self.list_box, self.scroll = self._task_list()
        self.progress_list, self.progress_scroll = self._task_list()
        self.progress_scroll.show_all()
        self.progress_scroll.hide()
        self.progress_scroll.set_no_show_all(True)
        self.progress_separator = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self.progress_separator.get_style_context().add_class("progress-divider")
        self.progress_separator.set_no_show_all(True)
        self.empty = Gtk.Label(label="Loading reminders…")
        self.empty.get_style_context().add_class("dim-label")
        self.empty.set_margin_top(6)
        self.empty.set_margin_bottom(6)
        self.empty.show()
        self.list_box.set_placeholder(self.empty)
        layout.pack_start(self.scroll, True, True, 0)
        layout.pack_start(self.progress_separator, False, False, 0)
        layout.pack_start(self.progress_scroll, False, True, 0)

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
        # Native menus stay visible above even an empty, very short checklist.
        self.menu = Gtk.Menu()
        self.menu.set_no_show_all(True)
        self.menu.get_style_context().add_class("pinote-window")
        self.menu.get_style_context().add_class("reminder-menu")
        self.filter_item = Gtk.MenuItem()
        self.reminders_button = Gtk.MenuItem(label="Reminders…")
        self.archive_button = Gtk.MenuItem(label="Archive…")
        self.close_menu_button = Gtk.MenuItem(label="Close")
        self.close_menu_button.get_accessible().set_name("Close reminders (Esc)")
        for item in (
            self.filter_item,
            self.reminders_button,
            self.archive_button,
            self.close_menu_button,
        ):
            self.menu.append(item)
            item.show()
        self.menu.connect("show", self._prepare_filters)
        self.menu.connect("hide", self._queue_pin_check)
        self._prepare_filters()
        self.menu_button.set_popup(self.menu)
        self.menu_button.set_direction(Gtk.ArrowType.UP)
        try:
            self.entry.set_text(self.draft.load())
        except (OSError, UnicodeError) as exc:
            self.draft_error = f"Cannot restore the input draft: {exc}"
            self._error(self.draft_error, action=True)
        self.placeholder.set_visible(not self.entry.get_text())
        self.entry.get_buffer().connect("changed", self._draft_changed)
        self.entry.connect("activate", lambda _entry: self._add())
        self.add_button.connect("clicked", lambda _button: self._add())
        self.reminders_button.connect("activate", lambda _item: self._open_reminders())
        self.archive_button.connect("activate", lambda _item: self._open_archive())
        self.close_menu_button.connect("activate", lambda _item: self.close())
        self.composer.pack_start(self.entry_box, True, True, 0)
        self.composer.pack_start(self.add_button, False, False, 0)
        self.composer.pack_start(self.menu_button, False, False, 0)
        layout.pack_start(self.composer, False, False, 0)
        self._update_controls()

        self.connect("key-press-event", self._on_key_press)
        self.connect("size-allocate", self._queue_geometry)
        for list_box, scroll in (
            (self.list_box, self.scroll),
            (self.progress_list, self.progress_scroll),
        ):
            list_box.connect("size-allocate", self._queue_geometry)
            scroll.get_vadjustment().connect("changed", self._queue_geometry)
        self.connect("notify::is-active", self._queue_pin_check)
        self.connect("configure-event", self._on_configure)
        for widget in (self, self.list_box, self.scroll, self.progress_list, self.progress_scroll):
            widget.add_events(Gdk.EventMask.BUTTON_RELEASE_MASK)
            widget.connect("event-after", self._after_pointer_event)
        self.connect("destroy", self._on_destroy)
        self.show_all()
        self.entry.grab_focus()
        self.refresh_source = GLib.timeout_add(1000, self._poll)
        self._poll()

    @staticmethod
    def _task_list() -> tuple[Gtk.ListBox, Gtk.ScrolledWindow]:
        list_box = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        list_box.get_style_context().add_class("reminder-list")
        list_box.set_margin_end(6)
        scroll = Gtk.ScrolledWindow()
        # Both sections reserve scrollbar space rather than covering row icons.
        scroll.set_overlay_scrolling(False)
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_propagate_natural_height(True)
        scroll.set_min_content_height(0)
        scroll.set_max_content_height(1)
        scroll.add(list_box)
        return list_box, scroll

    def _has_checklist_focus(self) -> bool:
        # Menus and the native preview grab focus without leaving the checklist.
        return (
            any(window.is_active() for window in self.get_application().get_windows())
            or self.focus_handoff is not None
            or self.menu.get_visible()
            or self.context_menu is not None
            or self.preview is not None
        )

    def _watch_child_focus(self, window: Gtk.Window) -> None:
        window.connect("notify::is-active", self._child_focus_changed)
        window.connect("destroy", self._child_focus_closed)

    def _present_child(self, window: Gtk.Window) -> None:
        self._finish_focus_handoff()
        # The WM may deactivate the parent before activating the child. Keep this
        # intentional handoff inside pinote, but do not wait forever if focus is refused.
        self.focus_handoff = window
        self.handoff_source = GLib.timeout_add(250, self._finish_focus_handoff)
        window.present()
        if window.is_active():
            self._finish_focus_handoff()

    def _finish_focus_handoff(self) -> bool:
        if self.handoff_source:
            GLib.source_remove(self.handoff_source)
            self.handoff_source = 0
        self.focus_handoff = None
        self._queue_pin_check()
        return GLib.SOURCE_REMOVE

    def _child_focus_changed(self, window, _property) -> None:
        if self.focus_handoff is window and window.is_active():
            self._finish_focus_handoff()
        self._queue_pin_check()

    def _child_focus_closed(self, window) -> None:
        if self.focus_handoff is window:
            self._finish_focus_handoff()
        self._queue_pin_check()

    def _queue_pin_check(self, *_args) -> None:
        if not self.closed and not self.pin_source:
            self.pin_source = GLib.idle_add(self._pin_after_focus_loss)

    def _pin_after_focus_loss(self) -> bool:
        self.pin_source = 0
        if not self.closed and self.deferred_progress and not self._has_checklist_focus():
            # Includes an accepted Start whose worker has not finished yet.
            self.deferred_progress.clear()
            self._arrange_rows()
        return GLib.SOURCE_REMOVE

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
        limits = self._section_limits(height, area.y)
        for scroll, limit in limits.items():
            if scroll.get_max_content_height() != limit:
                scroll.set_max_content_height(limit)
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
                scroll = (
                    self.progress_scroll if row.get_parent() is self.progress_list else self.scroll
                )
                adjustment = scroll.get_vadjustment()
                top, bottom = allocation.y, allocation.y + allocation.height
                # Wait for both the new row and the resized viewport to be allocated.
                if (
                    allocation.height > 1
                    and scroll.get_allocated_height() == limits[scroll]
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

    def _section_limits(self, height: int, monitor_top: int) -> dict[Gtk.ScrolledWindow, int]:
        ordinary = self.list_box.get_children()
        progress = self.progress_list.get_children()
        count = self.config.max_visible_notes
        # Share the row budget, reserving at least one row for each nonempty section.
        pinned_count = min(len(progress), max(1, count // 2) if ordinary else count)
        ordinary_count = max(1, count - pinned_count)

        def content_height(list_box, rows):
            width = list_box.get_allocated_width()
            return sum(row.get_preferred_height_for_width(width)[1] for row in rows)

        normal_height = content_height(self.list_box, ordinary[:ordinary_count])
        if not ordinary and not progress:
            normal_height = self.empty.get_preferred_height_for_width(
                self.list_box.get_allocated_width()
            )[1]
        pinned_height = content_height(self.progress_list, progress[:pinned_count])
        # Measure chrome, including the separator and errors, against the fixed anchor.
        chrome = height - sum(
            scroll.get_allocated_height()
            for scroll in (self.scroll, self.progress_scroll)
            if scroll.get_visible()
        )
        available = max(2, self.anchor_bottom - monitor_top - 25 - chrome)
        pinned_limit = min(pinned_height, max(1, available // 2) if ordinary else available)
        return {
            self.scroll: max(1, min(normal_height, available - pinned_limit)),
            self.progress_scroll: max(1, pinned_limit),
        }

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
            if isinstance(
                target, (Gtk.Button, Gtk.TextView, Gtk.Range, Gtk.Popover, Gtk.MenuShell)
            ):
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
        self.preview = NotePreview(
            row.preview_button, row.note, markdown=self.config.markdown_preview
        )
        self.preview.connect("closed", self._close_preview)
        self.preview.popup()

    def _close_preview(self, preview: NotePreview) -> None:
        if self.preview is preview:
            self.preview = None
            preview.destroy()
            if not self.closed:
                self.entry.grab_focus()
                self._queue_pin_check()

    @staticmethod
    def _radio_choices(menu, choices, selected, on_select) -> None:
        group = None
        for value, label in choices:
            item = Gtk.RadioMenuItem.new_with_label_from_widget(group, label)
            group = item
            item.set_active(value == selected)
            item.connect(
                "toggled", lambda item, value=value: on_select(value) if item.get_active() else None
            )
            menu.append(item)
            item.show()

    def _update_filter_label(self) -> None:
        if self.tag_filter is None:
            label = "All"
        else:
            label = f"#{self.tag_filter}" if self.tag_filter else "Untagged"
        self.filter_item.set_label(f"Filter by tag: {label}")
        self.menu_button.get_accessible().set_description(f"Filter by tag: {label}")

    def _tag_choices(self, selected: str | None, *, filtering: bool = False):
        # Count the full active snapshot, not just rows matching the current filter.
        counts = Counter(note.tag for note in self.notes_snapshot)
        tags = set(self.tags) | {tag for tag in counts if tag is not None}
        if selected:
            tags.add(selected)
        choices = [("" if filtering else None, f"Untagged ({counts[None]})")]
        if filtering:
            choices.append((None, f"All ({len(self.notes_snapshot)})"))
        choices.extend(
            (tag, f"#{tag} ({counts[tag]})")
            for tag in sorted(tags, key=lambda tag: (tag.casefold(), tag))
        )
        return choices

    def _prepare_filters(self, *_args) -> None:
        self._update_filter_label()
        previous = self.filter_item.get_submenu()
        if previous is not None:
            previous.destroy()
        self.filter_menu = Gtk.Menu()
        self.filter_menu.get_style_context().add_class("pinote-window")
        self.filter_menu.get_style_context().add_class("reminder-menu")
        self._radio_choices(
            self.filter_menu,
            self._tag_choices(self.tag_filter, filtering=True),
            self.tag_filter,
            self._set_filter,
        )
        self.filter_item.set_submenu(self.filter_menu)

    def _set_filter(self, tag: str | None) -> None:
        self.tag_filter = tag
        self.menu.popdown()
        # Do not carry a departing row's animation into a different view.
        for row in list(self.rows.values()):
            if row.exiting:
                self._remove_row(row)
        self._render(self.notes_snapshot)

    def _populate_note_menu(self, note_id: int, menu: Gtk.Menu) -> None:
        row = self.rows.get(note_id)
        if self.closed or row is None or row.exiting:
            return
        if self.context_menu is not None and self.context_menu is not menu:
            previous = self.context_menu
            previous.popdown()
            self._context_closed(previous)
        if self.focus_source:
            GLib.source_remove(self.focus_source)
            self.focus_source = 0
        self.context_menu = menu
        self.context_note_id = note_id
        row.get_style_context().add_class("context-target")
        for signal in ("deactivate", "hide", "destroy"):
            menu.connect(signal, self._context_closed)
        menu.get_style_context().add_class("pinote-window")
        menu.get_style_context().add_class("reminder-menu")
        note = row.note  # Actions carry the revision shown when the menu opened.
        separator = Gtk.SeparatorMenuItem()
        edit = Gtk.MenuItem(label="Edit…")
        edit.connect("activate", lambda _item: self._open_editor(note))
        schedule = Gtk.MenuItem(label="Set reminder…")
        schedule.connect("activate", lambda _item: self._open_schedule(note))
        tag_item = Gtk.MenuItem(label="Tag")
        tag_menu = Gtk.Menu()
        tag_menu.get_style_context().add_class("pinote-window")
        tag_menu.get_style_context().add_class("reminder-menu")
        self._radio_choices(
            tag_menu, self._tag_choices(note.tag), note.tag, lambda tag: self._set_tag(note, tag)
        )
        tag_menu.append(Gtk.SeparatorMenuItem())
        new_tag = Gtk.MenuItem(label="New tag…")
        new_tag.connect("activate", lambda _item: self._open_editor(note, tag_only=True))
        tag_menu.append(new_tag)
        tag_menu.show_all()
        tag_item.set_submenu(tag_menu)
        for item in (separator, edit, schedule, tag_item):
            menu.append(item)
            item.show()
        edit.set_sensitive(not self.action_pending)
        schedule.set_sensitive(not self.action_pending)
        tag_item.set_sensitive(not self.action_pending)

    def _context_closed(self, menu) -> None:
        if self.context_menu is menu:
            row = self.rows.get(self.context_note_id)
            if row is not None:
                row.get_style_context().remove_class("context-target")
            self.context_menu = None
            self.context_note_id = None
            self._queue_pin_check()

    def _open_editor(self, note: Note, *, tag_only: bool = False) -> None:
        if self.closed or self.action_pending or note.id not in self.rows:
            return
        if self.context_menu is not None:
            self.context_menu.popdown()
        if self.editor is None:
            self.editor = NoteEditor(self, note, tag_only=tag_only)
            self._watch_child_focus(self.editor)
        self._present_child(self.editor)

    def _open_schedule(self, note: Note) -> None:
        if self.closed or self.action_pending:
            return
        if self.context_menu is not None:
            self.context_menu.popdown()
        if self.editor is None:
            self.editor = NoteEditor(self, note, schedule_only=True)
            self._watch_child_focus(self.editor)
        self._present_child(self.editor)

    def _open_reminders(self) -> None:
        if self.closed:
            return
        self.menu.popdown()
        if self.scheduled_window is None or self.scheduled_window.closed:
            self.scheduled_window = ScheduledWindow(self)
            self._watch_child_focus(self.scheduled_window)
        self._present_child(self.scheduled_window)

    def _set_tag(self, note: Note, tag: str | None) -> None:
        if self.closed or self.action_pending or note.id not in self.rows:
            return
        if self.context_menu is not None:
            self.context_menu.popdown()
        self.action_pending = True
        self._update_controls()
        self._submit(lambda: self.model.set_tag(note, tag), action=(note.id, "tag"))

    def _open_archive(self) -> None:
        if self.closed:
            return
        self.menu.popdown()
        if self.archive_window is None or self.archive_window.closed:
            self.archive_window = ArchiveWindow(self)
            self._watch_child_focus(self.archive_window)
        self._present_child(self.archive_window)

    def _poll(self) -> bool:
        if self.closed:
            return GLib.SOURCE_REMOVE
        # No backlog of polls, and no poll can overtake a pending mutation.
        if not self.pending:
            self._submit(lambda: (self.model.notes(), self.model.tags()), action=None)
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
        if self.closed:
            return
        text = self.entry.get_text()
        self.draft_revision = self.draft.update(text)
        self.placeholder.set_visible(not text)
        self._update_add_button()
        self._queue_geometry()
        if not self.draft_source:
            self.draft_source = GLib.timeout_add(250, self._queue_draft_save)

    def _queue_draft_save(self) -> bool:
        self.draft_source = 0
        self.worker.submit(self._persist_draft)
        return GLib.SOURCE_REMOVE

    def _persist_draft(self) -> None:
        try:
            self.draft.save()
        except (OSError, UnicodeError) as exc:
            message = f"Cannot save the input draft; it may be lost on restart: {exc}"
            if message != self.draft_error:
                LOGGER.error("GUI: %s", message)
            self.draft_error = message
            if not self.closed:
                GLib.idle_add(self._show_draft_error)
        else:
            self.draft_error = None

    def _show_draft_error(self) -> bool:
        if not self.closed and self.draft_error:
            self.error_is_action = True
            self.error_text.set_text(self.draft_error)
            self.notice.show()
        return GLib.SOURCE_REMOVE

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
        revision = self.draft_revision
        tag = self.tag_filter or None

        def add():
            note_id = self.model.add(text, tag=tag) if tag else self.model.add(text)
            # This runs even if the window closed before the add completed.
            # A cache error must never make a committed task look retryable.
            self.draft.submitted(revision)
            self._persist_draft()
            return note_id

        self._submit(add, action=None, draft_revision=revision)

    def _act(self, note_id: int, action: str) -> None:
        row = self.rows.get(note_id)
        if self.closed or self.action_pending or row is None or row.exiting:
            return
        self.action_pending = True
        if action == "start":
            self.starting_note_id = note_id
            if self._has_checklist_focus():
                self.deferred_progress.add(note_id)
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
                if action[1] != "tag":
                    self._render(result.notes, action=action if result.changed else None)
            else:
                notes, self.tags = result
                self._render(notes)
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
            if draft_revision is not None or (action and action[1] == "tag"):
                # Refresh separately: read failure cannot disguise a committed save.
                self._poll()
            if mutation and self.archive_window is not None:
                self.archive_window._poll()
        finally:
            if action and action[1] == "start":
                self.starting_note_id = None
                self.deferred_progress.intersection_update(
                    note.id for note in self.notes_snapshot if note.state == "in_progress"
                )
            self._update_controls()
            self._show_draft_error()
        return GLib.SOURCE_REMOVE

    def _render(self, notes: list[Note], *, action: tuple[int, str] | None = None) -> None:
        progress = {note.id for note in notes if note.state == "in_progress"}
        focused = self._has_checklist_focus()
        if self.loaded_notes and focused:
            previous = {note.id for note in self.notes_snapshot if note.state == "in_progress"}
            self.deferred_progress.update(progress - previous - {self.starting_note_id})
        elif not focused:
            self.deferred_progress.clear()
        self.deferred_progress.intersection_update(progress | {self.starting_note_id})
        self.loaded_notes = True
        self.notes_snapshot = notes
        self._update_filter_label()
        notes = [
            note
            for note in notes
            if self.tag_filter is None or note.tag == (self.tag_filter or None)
        ]
        wanted = {note.id for note in notes}
        if self.context_menu is not None and self.context_note_id not in wanted:
            self.context_menu.popdown()
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
                row = NoteRow(note, self._act, self._open_preview, self._populate_note_menu)
                for widget in (row, row.body):
                    widget.connect("event-after", self._after_pointer_event)
                self.rows[note.id] = row
                self._place_row(row)
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
        empty = "No active reminders."
        if self.tag_filter:
            empty = f"No active reminders tagged #{self.tag_filter}."
        elif self.tag_filter == "" and self.notes_snapshot:
            empty = "No untagged reminders."
        self.empty.set_text(empty)
        self._arrange_rows()
        # Unchanged rows and both scroll adjustments are deliberately left intact.

    def _place_row(self, row: NoteRow) -> None:
        target = (
            self.progress_list
            if row.note.state == "in_progress" and row.note.id not in self.deferred_progress
            else self.list_box
        )
        parent = row.get_parent()
        if parent is target:
            return
        if parent is not None:
            parent.remove(row)
        # Keep creation order within each section, including departing animation slots.
        position = sum(child.note.id < row.note.id for child in target.get_children())
        target.insert(row, position)

    def _arrange_rows(self) -> None:
        for row in self.rows.values():
            if not row.exiting:
                self._place_row(row)
        self._update_sections()

    def _update_sections(self) -> None:
        ordinary = self.list_box.get_children()
        progress = self.progress_list.get_children()
        self.scroll.set_visible(bool(ordinary) or not progress)
        self.progress_scroll.set_visible(bool(progress))
        self.progress_separator.set_visible(bool(ordinary) and bool(progress))
        for list_box, rows, name in (
            (self.list_box, ordinary, "Reminders"),
            (self.progress_list, progress, "In progress"),
        ):
            count = sum(not row.exiting for row in rows)
            list_box.get_accessible().set_name(
                f"{name}, {count} active {'note' if count == 1 else 'notes'}"
            )
        self._queue_geometry()

    def _remove_row(self, row: NoteRow) -> None:
        if not self.closed and self.rows.get(row.note.id) is row:
            self.rows.pop(row.note.id)
            row.destroy()
            self._update_sections()

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
        if self.context_menu is not None:
            self.context_menu.popdown()
        self.menu.popdown()
        if self.editor is not None:
            self.editor.destroy()
        Gtk.ApplicationWindow.close(self)

    def _on_destroy(self, _window) -> None:
        self.closed = True
        if self.preview is not None:
            self._close_preview(self.preview)
        if self.archive_window is not None and not self.archive_window.closed:
            self.archive_window.destroy()
        if self.scheduled_window is not None and not self.scheduled_window.closed:
            self.scheduled_window.destroy()
        if self.editor is not None:
            self.editor.destroy()
        if self.context_menu is not None:
            self.context_menu.popdown()
        self.menu.destroy()
        GLib.source_remove(self.refresh_source)
        for source in (
            self.geometry_source,
            self.focus_source,
            self.pin_source,
            self.handoff_source,
            self.draft_source,
        ):
            if source:
                GLib.source_remove(source)
        self.geometry_source = self.focus_source = self.pin_source = self.draft_source = 0
        self.handoff_source = 0
        self.focus_handoff = None
        # GTK may retain child widgets after closing. Stop their callbacks now,
        # rather than waiting for each row's eventual destroy signal.
        for row in self.rows.values():
            row.cancel_dismissal()
        # Flush after accepted adds have cleared only their own draft. Read the
        # latest snapshot on the worker, never re-save a stale editor snapshot.
        self.worker.submit(self._persist_draft)
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
