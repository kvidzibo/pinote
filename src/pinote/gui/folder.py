"""Optional default-folder picker shared by tag forms."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Pango  # noqa: E402

from pinote.gui.icons import icon_button  # noqa: E402


class FolderPicker(Gtk.Box):
    def __init__(self, owner, on_changed):
        super().__init__(spacing=8)
        self.owner = owner
        self.on_changed = on_changed
        self.folder: str | None = None
        self.dialog = None
        self.label = Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.MIDDLE)
        self.label.set_max_width_chars(32)
        self.pack_start(self.label, True, True, 0)
        self.choose_button = icon_button("folder-symbolic", "Choose default folder (optional)")
        self.choose_button.connect("clicked", lambda _button: self._choose())
        self.pack_start(self.choose_button, False, False, 0)
        self.clear_button = icon_button("window-close-symbolic", "Clear default folder")
        self.clear_button.connect("clicked", lambda _button: self.on_changed(None))
        self.pack_start(self.clear_button, False, False, 0)
        self.set_folder(None)

    def set_folder(self, folder: str | None) -> None:
        self.folder = folder
        text = folder or "Default folder (optional)"
        self.label.set_text(text)
        self.label.set_tooltip_text(folder or "Choose a folder when starting if left blank.")
        self.clear_button.set_sensitive(folder is not None)

    def _choose(self) -> None:
        if self.dialog is not None:
            self.dialog.present()
            return
        dialog = Gtk.FileChooserDialog(
            title="Choose default folder",
            transient_for=self.get_toplevel(),
            modal=True,
            destroy_with_parent=True,
            use_header_bar=True,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        self.dialog = dialog
        dialog.set_local_only(True)
        dialog.add_buttons("_Cancel", Gtk.ResponseType.CANCEL, "_Select", Gtk.ResponseType.ACCEPT)
        dialog.set_default_response(Gtk.ResponseType.ACCEPT)
        if self.folder:
            dialog.set_current_folder(self.folder)
        self.owner._watch_child_focus(dialog)

        def response(_dialog, result):
            folder = dialog.get_filename()
            dialog.destroy()
            if result == Gtk.ResponseType.ACCEPT and folder:
                self.on_changed(folder)

        dialog.connect("response", response)
        dialog.connect("destroy", lambda _dialog: setattr(self, "dialog", None))
        dialog.show()
