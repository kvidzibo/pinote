"""Small, bundled SVG icons; independent of the desktop icon theme."""

from importlib.resources import files

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, GLib, Gtk  # noqa: E402


def icon_image(name: str, size: int = 12) -> Gtk.Image:
    data = files("pinote.gui").joinpath("icons", f"{name}.svg").read_bytes()
    image = Gtk.Image.new_from_gicon(Gio.BytesIcon.new(GLib.Bytes.new(data)), Gtk.IconSize.MENU)
    image.set_pixel_size(size)
    return image


def icon_menu_item(icon: str, description: str) -> Gtk.MenuItem:
    item = Gtk.MenuItem()
    item.add(icon_image(icon))
    item.set_tooltip_text(description)
    item.get_accessible().set_name(description)
    item.show_all()
    return item


def icon_button(icon: str, description: str) -> Gtk.Button:
    button = Gtk.Button(image=icon_image(icon), valign=Gtk.Align.START)
    button.set_relief(Gtk.ReliefStyle.NONE)
    button.set_tooltip_text(description)
    button.get_accessible().set_name(description)
    return button
