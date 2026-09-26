"""Keep transient windows inside a monitor's usable area after WM placement."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402


def place_child(window: Gtk.Window, owner: Gtk.Window) -> None:
    """Install before show_all; retain manual placement while clamping later growth."""
    window.set_position(Gtk.WindowPosition.NONE)
    window.set_keep_above(True)
    source = 0
    initial = True
    closed = False

    def constrain() -> bool:
        nonlocal source, initial
        source = 0
        if closed or not window.get_mapped():
            return GLib.SOURCE_REMOVE
        native = window.get_window()
        _ok, current_x, current_y = native.get_origin()
        x, y = current_x, current_y
        size = native.get_geometry()
        display = window.get_display()
        anchor = owner.get_window() if initial else native
        area = display.get_monitor_at_window(anchor).get_workarea()
        # Insets keep borders/resize handles clear of panels and screen edges.
        margin = min(12, max(0, min(area.width, area.height) // 20))
        width = min(size.width, max(1, area.width - 2 * margin))
        height = min(size.height, max(1, area.height - 2 * margin))
        if initial:
            _ok, parent_x, parent_y = owner.get_window().get_origin()
            parent_size = owner.get_window().get_geometry()
            x = parent_x + (parent_size.width - width) // 2
            y = parent_y + (parent_size.height - height) // 2
            initial = False
        target_x = max(area.x + margin, min(x, area.x + area.width - margin - width))
        target_y = max(area.y + margin, min(y, area.y + area.height - margin - height))
        if (size.width, size.height) != (width, height):
            window.resize(width, height)
        if (current_x, current_y) != (target_x, target_y):
            window.move(target_x, target_y)
        return GLib.SOURCE_REMOVE

    def queue(*_args) -> None:
        nonlocal source
        if not closed and not source:
            source = GLib.idle_add(constrain)

    def destroy(*_args) -> None:
        nonlocal source, closed
        closed = True
        if source:
            GLib.source_remove(source)
            source = 0

    window.connect("map-event", queue)
    window.connect("configure-event", queue)
    window.connect("size-allocate", queue)
    window.connect("destroy", destroy)
