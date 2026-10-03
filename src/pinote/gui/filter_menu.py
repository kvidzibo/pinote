"""Tag-filter menus that keep their grab while choices change."""

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402


class FilterMenu(Gtk.Menu):
    def __init__(self, on_edit):
        super().__init__()
        self.on_edit = on_edit
        self.pressed_item = None

    def _item_at(self, event):
        origin = self.get_window().get_origin()
        x, y = event.x_root - origin.x, event.y_root - origin.y
        for item in self.get_children():
            allocation = item.get_allocation()
            if (
                item.get_sensitive()
                and not isinstance(item, Gtk.SeparatorMenuItem)
                and allocation.x <= x < allocation.x + allocation.width
                and allocation.y <= y < allocation.y + allocation.height
            ):
                return item
        return None

    def do_button_press_event(self, event):
        item = self._item_at(event)
        if item is not None and event.button == 1:
            self.select_item(item)
            self.pressed_item = item
            return True
        if item is not None and event.button == 3 and hasattr(item, "filter_tag"):
            self.pressed_item = None
            self.on_edit(item.filter_tag or None)
            return True
        return Gtk.Menu.do_button_press_event(self, event)

    def do_button_release_event(self, event):
        pressed, self.pressed_item = self.pressed_item, None
        if event.button == 1 and pressed is not None:
            if self._item_at(event) is pressed:
                pressed.activate()
            return True
        return Gtk.Menu.do_button_release_event(self, event)

    def do_activate_current(self, _force_hide):
        item = self.get_selected_item()
        if item is not None and item.get_sensitive():
            item.activate()
