"""Source-preserving Markdown styling and newline assistance for GTK inputs."""

from __future__ import annotations

import re

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk, Pango  # noqa: E402

_HEADING = re.compile(r"^ {0,3}#{1,6}[ \t]+", re.MULTILINE)
_BULLET = re.compile(r"^([ \t]*)-([ \t]+|$)")
# Lightweight source highlighting, not a second Markdown renderer. Matched code
# spans take precedence over emphasis; markers remain visible and editable.
_INLINE = re.compile(
    r"(?<!\\)(?P<code>(`+)[^`\n]+?\2(?!`))"
    r"|(?<![\\*])(?P<bold>\*\*(?=\S)[^\n]+?(?<=\S)\*\*(?!\*))"
    r"|(?<![\\\w])(?P<bold_under>__(?=\S)[^\n]+?(?<=\S)__(?!\w))"
    r"|(?<![\\*])(?P<italic>\*(?=[^\s*])[^*\n]*?\S\*(?!\*))"
    r"|(?<![\\\w])(?P<italic_under>_(?=[^\s_])[^_\n]*?\S_(?!\w))"
)
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_BLOCK_START = re.compile(r"^\s*(?:#{1,6}(?:\s|$)|[>*+-](?:\s|$)|\d+[.)]\s|`{3,}|~{3,})")


class MarkdownEntry(Gtk.TextView):
    """Style source without changing it; only explicit newline keys add markers."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        buffer = self.get_buffer()
        self.markdown_tags = {
            "heading": buffer.create_tag("markdown-heading", weight=Pango.Weight.BOLD, scale=1.2),
            "bold": buffer.create_tag("markdown-bold", weight=Pango.Weight.BOLD),
            "italic": buffer.create_tag("markdown-italic", style=Pango.Style.ITALIC),
            "code": buffer.create_tag("markdown-code", family="monospace", background="#1c212a"),
        }
        buffer.connect("changed", self._style_source)

    def _style_source(self, buffer) -> None:
        for tag in self.markdown_tags.values():
            buffer.remove_tag(tag, *buffer.get_bounds())
        text = buffer.get_text(*buffer.get_bounds(), True)
        offset = 0
        fence = None
        for line in text.splitlines(keepends=True):
            marker = _FENCE.match(line)
            if fence is not None or marker:
                self._style("code", offset, offset + len(line.rstrip("\n")))
                if fence is None:
                    fence = marker[1]
                elif (
                    marker
                    and marker[1][0] == fence[0]
                    and len(marker[1]) >= len(fence)
                    and not line[marker.end() :].strip()
                ):
                    fence = None
            else:
                if _HEADING.match(line):
                    self._style("heading", offset, offset + len(line.rstrip("\n")))
                for match in _INLINE.finditer(line):
                    self._style(
                        match.lastgroup.removesuffix("_under"),
                        offset + match.start(),
                        offset + match.end(),
                    )
            offset += len(line)

    def _style(self, name: str, start: int, end: int) -> None:
        buffer = self.get_buffer()
        buffer.apply_tag(
            self.markdown_tags[name],
            buffer.get_iter_at_offset(start),
            buffer.get_iter_at_offset(end),
        )

    def _insert_newline(self) -> None:
        buffer = self.get_buffer()
        buffer.begin_user_action()
        try:
            buffer.delete_selection(True, True)
            cursor = buffer.get_iter_at_mark(buffer.get_insert())
            start = cursor.copy()
            start.set_line_offset(0)
            prefix = buffer.get_text(start, cursor, True)
            # Turn a plain, single-line task into a title only as the user adds
            # its first body line. Loading/pasting and subsequent edits stay literal.
            if buffer.get_line_count() == 1 and prefix.strip() and not _BLOCK_START.match(prefix):
                buffer.insert(buffer.get_start_iter(), "# ")
                cursor = buffer.get_iter_at_mark(buffer.get_insert())
                start = buffer.get_start_iter()
                prefix = buffer.get_text(start, cursor, True)
            bullet = _BULLET.match(prefix)
            end = cursor.copy()
            if not end.ends_line():
                end.forward_to_line_end()
            if bullet and not prefix[bullet.end() :].strip() and cursor.equal(end):
                # Enter on an empty bullet leaves a plain line, ending the list.
                buffer.delete(start, cursor)
            else:
                continuation = ""
                if bullet:
                    continuation = bullet[1] + "- "
                elif _HEADING.match(prefix):
                    continuation = "- "
                buffer.insert_at_cursor("\n" + continuation)
        finally:
            buffer.end_user_action()
        self.scroll_mark_onscreen(buffer.get_insert())

    def do_key_press_event(self, event) -> bool:
        if (
            event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter)
            and not event.state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.MOD1_MASK)
            and self.get_editable()
        ):
            if not self.im_context_filter_keypress(event):
                self._insert_newline()
            return True
        return Gtk.TextView.do_key_press_event(self, event)
