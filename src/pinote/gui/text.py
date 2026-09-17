"""Multiline task input and a read-only, bounded note preview."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GObject, Gtk, Pango  # noqa: E402

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

    def __init__(self, button: Gtk.Button, note: Note):
        super().__init__(
            type=Gtk.WindowType.POPUP,
            transient_for=button.get_toplevel(),
            destroy_with_parent=True,
            resizable=False,
        )
        self.button = button
        self.note_id = note.id
        self.seat = self.get_display().get_default_seat()
        self.grabbed = False
        self.set_type_hint(Gdk.WindowTypeHint.POPUP_MENU)
        self.get_style_context().add_class("pinote-window")
        self.get_accessible().set_name(f"Preview of note {note.id}")
        self.body = Gtk.Label(label=note.text, xalign=0, yalign=0, selectable=True)
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
        panel = Gtk.Box()
        panel.get_style_context().add_class("note-preview")
        panel.add(self.scroll)
        self.add(panel)
        panel.show_all()
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.connect("key-press-event", self._key_press)
        self.connect("button-press-event", self._button_press)
        self.connect("grab-broken-event", lambda *_args: self.popdown())
        self.connect("destroy", self._release_grab)

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

    def update(self, note: Note) -> None:
        if self.body.get_text() != note.text:
            self.body.set_text(note.text)  # Literal text, never markup.
