"""Small, bundled SVG icons; independent of the desktop icon theme."""

from importlib.resources import files

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, GLib, Gtk, Pango  # noqa: E402


def icon_image(name: str, size: int = 12) -> Gtk.Image:
    data = files("pinote.gui").joinpath("icons", f"{name}.svg").read_bytes()
    image = Gtk.Image.new_from_gicon(Gio.BytesIcon.new(GLib.Bytes.new(data)), Gtk.IconSize.MENU)
    image.set_pixel_size(size)
    return image


def icon_menu_item(icon: str, description: str) -> Gtk.MenuItem:
    item = Gtk.MenuItem()
    image = icon_image(icon, size=16)
    image.set_halign(Gtk.Align.START)
    item.add(image)
    item.set_tooltip_text(description)
    item.get_accessible().set_name(description)
    item.show_all()
    return item


class TagLabel(Gtk.Box):
    """Literal tag name with the same bundled icon in badges and lists."""

    def __init__(self, text: str = "", *, max_width_chars: int = 12, icon_size: int = 12):
        super().__init__(spacing=4)
        self.image = icon_image("tag-symbolic", size=icon_size)
        self.label = Gtk.Label(label=text, xalign=0, ellipsize=Pango.EllipsizeMode.END)
        self.label.set_max_width_chars(max_width_chars)
        self.pack_start(self.image, False, False, 0)
        self.pack_start(self.label, True, True, 0)
        self.show_all()


def tag_menu_item(text: str, *, selected: bool = False, checkable: bool = False) -> Gtk.MenuItem:
    item = Gtk.CheckMenuItem(active=selected) if checkable else Gtk.MenuItem()
    item.add(TagLabel(text, max_width_chars=40))
    item.get_accessible().set_name(text)
    item.get_accessible().set_description("Selected" if selected else "")
    if selected:
        item.get_style_context().add_class("selected-tag")
    item.show_all()
    return item


def icon_button(icon: str, description: str) -> Gtk.Button:
    button = Gtk.Button(image=icon_image(icon), valign=Gtk.Align.START)
    button.set_relief(Gtk.ReliefStyle.NONE)
    button.set_tooltip_text(description)
    button.get_accessible().set_name(description)
    return button
