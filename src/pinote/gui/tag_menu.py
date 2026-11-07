"""Native tag menus with a search field revealed by typing."""

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

from pinote.gui.icons import icon_image  # noqa: E402


class TagMenu(Gtk.Menu):
    def __init__(self):
        super().__init__()
        self.search_entry = None
        self.resize_source = 0
        self.connect("hide", self._reset_search)

    def add_search(self, on_create, *, columns=1):
        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Search tags…")
        self.search_entry.set_width_chars(18)
        self.search_entry.get_accessible().set_name("Search tags")
        self.search_item = Gtk.MenuItem()
        self.search_item.add(self.search_entry)
        self.search_item.set_no_show_all(True)
        self.append(self.search_item)
        self.attach(self.search_item, 0, columns, 0, 1)
        self.create_item = Gtk.MenuItem()
        content = Gtk.Box(spacing=4)
        content.pack_start(icon_image("list-add-symbolic"), False, False, 0)
        content.pack_start(Gtk.Label(label="Create tag…", xalign=0), False, False, 0)
        self.create_item.add(content)
        self.create_item.set_no_show_all(True)
        self.create_name = ""
        self.create_item.connect("activate", lambda _item: on_create(self.create_name))
        self.append(self.create_item)
        rows = [self.child_get_property(item, "bottom-attach") for item in self.get_children()]
        self.attach(self.create_item, 0, columns, max(rows), max(rows) + 1)
        self.search_entry.connect("changed", lambda _entry: self.apply_search())
        self.apply_search()

    @property
    def query(self):
        return self.search_entry.get_text().strip() if self.search_entry is not None else ""

    def apply_search(self):
        query = self.query.casefold()
        matches = 0
        layout_changed = False
        for item in self.get_children():
            if not hasattr(item, "tag_name"):
                continue
            matches_query = query in item.tag_name.casefold()
            visible = matches_query and (bool(query) or getattr(item, "tag_visible", True))
            layout_changed |= item.get_visible() != visible
            item.set_no_show_all(not visible)
            item.set_visible(visible)
            matches += matches_query
        if self.search_entry is None:
            return
        searching = bool(self.search_entry.get_text())
        layout_changed |= self.search_item.get_visible() != searching
        self.search_item.set_visible(searching)
        if self.search_item.get_visible():
            self.search_entry.show()
        if query:
            # Mouse activation hides (and resets) a native menu before emitting activate.
            self.create_name = self.query
        label = f"Create tag “{self.query}”…"
        self.create_item.set_tooltip_text(label)
        self.create_item.get_accessible().set_name(label)
        creating = bool(query) and not matches
        layout_changed |= self.create_item.get_visible() != creating
        self.create_item.set_visible(creating)
        if self.create_item.get_visible():
            self.create_item.get_child().show_all()
        selected = self.get_selected_item()
        if (
            query
            and self.get_mapped()
            and (
                selected is None or not selected.get_visible() or not hasattr(selected, "tag_name")
            )
        ):
            for item in self.get_children():
                if (
                    (hasattr(item, "tag_name") or item is self.create_item)
                    and item.get_visible()
                    and item.get_sensitive()
                ):
                    self.select_item(item)
                    break
        if layout_changed and self.get_mapped() and not self.resize_source:
            self.resize_source = GLib.idle_add(self._resize_popup)

    def _resize_popup(self):
        self.resize_source = 0
        if self.get_mapped():
            popup = self.get_toplevel().get_window()
            area = self.get_display().get_monitor_at_window(popup).get_workarea()
            size = self.get_preferred_size()[1]
            # Gtk.Window.resize leaves an already-open menu's scrolling viewport stale.
            popup.resize(min(size.width, area.width), min(size.height, area.height))
            self.reposition()
        return GLib.SOURCE_REMOVE

    def _reset_search(self, *_args):
        if self.search_entry is not None:
            self.search_entry.set_text("")

    def do_key_press_event(self, event):
        if self.search_entry is not None and event.keyval not in (
            Gdk.KEY_Escape,
            Gdk.KEY_Return,
            Gdk.KEY_KP_Enter,
            Gdk.KEY_Up,
            Gdk.KEY_Down,
            Gdk.KEY_Left,
            Gdk.KEY_Right,
            Gdk.KEY_Tab,
        ):
            if self.search_entry.handle_event(event):
                return True
        return Gtk.Menu.do_key_press_event(self, event)
