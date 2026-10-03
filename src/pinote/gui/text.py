"""Multiline task input and a read-only, bounded note preview."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, GObject, Gtk, Pango  # noqa: E402

from pinote.gui.icons import icon_button  # noqa: E402
from pinote.gui.preview_markdown import is_safe_link, render_markdown  # noqa: E402
from pinote.logging_setup import LOGGER  # noqa: E402
from pinote.store import Note  # noqa: E402


class TaskEntry(Gtk.TextView):
    """Keep Enter-to-submit while accepting pasted text and Shift+Enter newlines."""

    __gsignals__ = {"activate": (GObject.SignalFlags.RUN_LAST, None, ())}

    def __init__(self):
        super().__init__(
            wrap_mode=Gtk.WrapMode.WORD_CHAR,
            accepts_tab=False,
            left_margin=6,
            right_margin=6,
            top_margin=3,
            bottom_margin=3,
            hexpand=True,
        )
        self.get_accessible().set_name("New task")
        self.get_accessible().set_description("Enter to add; Shift+Enter for a new line.")

    def get_text(self) -> str:
        buffer = self.get_buffer()
        return buffer.get_text(*buffer.get_bounds(), True)

    def set_text(self, text: str) -> None:
        self.get_buffer().set_text(text)

    def do_key_press_event(self, event) -> bool:
        if event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) and not (
            event.state & Gdk.ModifierType.SHIFT_MASK
        ):
            # Let an input method commit its composition before submitting.
            if not self.im_context_filter_keypress(event):
                self.emit("activate")
            return True
        return Gtk.TextView.do_key_press_event(self, event)


class NotePreview(Gtk.Window):
    # A GTK 3 popover can be clipped to a tiny parent on X11. A native popup
    # keeps the full preview visible without resizing the bottom-anchored list.
    __gsignals__ = {"closed": (GObject.SignalFlags.RUN_LAST, None, ())}

    def __init__(
        self,
        button: Gtk.Button,
        note: Note,
        *,
        markdown: bool = True,
        on_edit=None,
        agent_update: bool = False,
        on_viewed=None,
    ):
        super().__init__(
            type=Gtk.WindowType.POPUP,
            transient_for=button.get_toplevel(),
            destroy_with_parent=True,
            resizable=False,
        )
        self.button = button
        self.note_id = note.id
        self.markdown = markdown
        self.source_text: str | None = None
        self.view_source = 0
        self.on_viewed = on_viewed
        self.opened_agent_event = note.agent_event_id if agent_update else 0
        self.agent_offset = 0
        self.removal_event = 0
        self.seat = self.get_display().get_default_seat()
        self.grabbed = False
        self.set_type_hint(Gdk.WindowTypeHint.POPUP_MENU)
        self.get_style_context().add_class("pinote-window")
        self.get_accessible().set_name(f"Preview of note {note.id}")
        self.body = Gtk.Label(xalign=0, yalign=0, selectable=True)
        self.body.connect("activate-link", self._activate_link)
        self.update(note, agent_update=agent_update)
        self.body.set_line_wrap(True)
        self.body.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.body.set_max_width_chars(40)
        self.area = button.get_display().get_monitor_at_window(button.get_window()).get_workarea()
        self.scroll = Gtk.ScrolledWindow()
        self.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        # min-content-width is ignored with a NEVER horizontal scroll policy.
        self.scroll.set_size_request(min(340, max(1, self.area.width - 80)), -1)
        self.scroll.set_min_content_height(0)
        self.scroll.set_max_content_height(min(300, max(1, self.area.height - 100)))
        self.scroll.set_propagate_natural_height(True)
        self.scroll.add(self.body)
        panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        panel.get_style_context().add_class("note-preview")
        panel.add(self.scroll)
        if on_edit is not None:
            self.edit_button = icon_button("document-edit-symbolic", f"Edit note {note.id}")
            self.edit_button.set_halign(Gtk.Align.END)
            self.edit_button.connect("clicked", lambda _button: on_edit(self.note_id))
            panel.add(self.edit_button)
        self.add(panel)
        panel.show_all()
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.connect("key-press-event", self._key_press)
        self.connect("button-press-event", self._button_press)
        self.connect("grab-broken-event", lambda *_args: self.popdown())
        self.connect("destroy", self._release_grab)
        self.connect("destroy", self._cancel_view)

    def popup(self) -> None:
        owner = self.button.get_toplevel()
        _success, origin_x, origin_y = owner.get_window().get_origin()
        button_x, button_y = self.button.translate_coordinates(owner, 0, 0)
        size = self.get_preferred_size()[1]
        x = origin_x + button_x + self.button.get_allocated_width() - size.width
        y = origin_y + button_y - size.height - 6
        if y < self.area.y:
            y = origin_y + button_y + self.button.get_allocated_height() + 6
        self.move(
            max(self.area.x, min(x, self.area.x + self.area.width - size.width)),
            max(self.area.y, min(y, self.area.y + self.area.height - size.height)),
        )
        self.show_all()
        self.grab_add()
        status = self.seat.grab(
            self.get_window(),
            Gdk.SeatCapabilities.POINTER | Gdk.SeatCapabilities.KEYBOARD,
            True,
            None,
            None,
            None,
            None,
        )
        self.grabbed = status == Gdk.GrabStatus.SUCCESS
        if not self.grabbed:
            self.popdown()  # Never leave a popup that cannot dismiss on outside input.
            return
        self.body.grab_focus()
        self.body.select_region(0, 0)
        if self.opened_agent_event:
            self.view_source = GLib.idle_add(self._view_agent)

    def _view_agent(self) -> bool:
        if not self.get_mapped() or self.agent_event_id != self.opened_agent_event:
            self.view_source = 0
            return GLib.SOURCE_REMOVE
        adjustment = self.scroll.get_vadjustment()
        if self.body.get_allocated_height() <= 1 or adjustment.get_page_size() <= 1:
            return GLib.SOURCE_CONTINUE
        text = self.body.get_text()
        index = len(text[: self.agent_offset].encode("utf-8"))
        rect = self.body.get_layout().index_to_pos(index)
        adjustment.set_value(
            min(rect.y / Pango.SCALE, adjustment.get_upper() - adjustment.get_page_size())
        )
        self.view_source = 0
        if self.on_viewed is not None:
            self.on_viewed(self.note_id, self.opened_agent_event)
        return GLib.SOURCE_REMOVE

    def _cancel_view(self, _window) -> None:
        if self.view_source:
            GLib.source_remove(self.view_source)
            self.view_source = 0

    def popdown(self) -> None:
        self.emit("closed")

    def _key_press(self, _window, event) -> bool:
        if event.keyval == Gdk.KEY_Escape:
            self.popdown()
            return True
        return False

    def _button_press(self, _window, event) -> bool:
        _success, x, y = self.get_window().get_origin()
        size = self.get_size()
        if not (x <= event.x_root < x + size.width and y <= event.y_root < y + size.height):
            self.popdown()
            return True
        return False

    def _release_grab(self, _window) -> None:
        if self.grabbed:
            self.grabbed = False
            self.seat.ungrab()
        if self.has_grab():
            self.grab_remove()

    def _activate_link(self, _label, uri: str) -> bool:
        if is_safe_link(uri):
            owner = self.button.get_toplevel()
            self.popdown()  # Release the popup's input grab before launching a browser.
            try:
                Gtk.show_uri_on_window(owner, uri, Gdk.CURRENT_TIME)
            except GLib.Error as exc:
                LOGGER.warning("Cannot open preview link: %s", exc)
        return True  # Never let GTK launch other URI schemes through its default handler.

    def update(self, note: Note, *, agent_update: bool = False) -> None:
        self.agent_event_id = note.agent_event_id
        source = note.markdown
        if agent_update and not note.agent_notes:
            self.removal_event = note.agent_event_id
        if (
            not note.agent_notes
            and self.removal_event == note.agent_event_id
            and self.removal_event
        ):
            source += "\n\n# Agent\nAgent fields were removed."
        if self.source_text == source:
            return  # Compare source, not rendered text, to preserve selection on polls.
        self.source_text = source
        title = "\n" in note.text
        markup = render_markdown(source, title=title) if self.markdown else None
        if markup is None:
            self.body.set_text(source)
        else:
            self.body.set_markup(markup)
        # The appended Agent heading follows the rendered task, not its source
        # character count (Markdown syntax and Unicode change those offsets).
        prefix_markup = render_markdown(note.text, title=title) if self.markdown else None
        if prefix_markup:
            # GtkLabel supports link tags; Pango.parse_markup does not.
            prefix_label = Gtk.Label()
            prefix_label.set_markup(prefix_markup)
            prefix = prefix_label.get_text()
            prefix_label.destroy()
        else:
            prefix = note.text
        text = self.body.get_text()
        heading = "\n\nAgent\n" if markup else "\n\n# Agent\n"
        offset = text.find(heading, max(0, len(prefix) - 2))
        self.agent_offset = offset + 2 if offset >= 0 else len(prefix)
