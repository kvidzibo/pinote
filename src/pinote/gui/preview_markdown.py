"""Optional Markdown → GTK label markup; no GTK, storage, HTML, or network access."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from urllib.parse import urlsplit

try:
    from markdown_it import MarkdownIt
    from markdown_it.tree import SyntaxTreeNode
except ImportError:  # Base/CLI installs retain the original literal preview.
    MarkdownIt = None


_CODE = '<span font_family="monospace" background="#1c212a">{}</span>'


def is_safe_link(uri: str) -> bool:
    """Only explicit web/mail links may leave the preview; never local files/apps."""
    try:
        parts = urlsplit(uri)
    except ValueError:
        return False
    return (parts.scheme in {"http", "https"} and bool(parts.netloc)) or (
        parts.scheme == "mailto" and bool(parts.path)
    )


def _inline(nodes: list[SyntaxTreeNode]) -> str:
    result = []
    for node in nodes:
        kind = node.type
        if kind in {"softbreak", "hardbreak"}:
            result.append("\n")
        elif kind == "code_inline":
            result.append(_CODE.format(escape(node.content)))
        elif kind == "image":
            result.append(escape(f"[Image: {node.content}]"))
        elif kind in {"strong", "em"}:
            tag = "b" if kind == "strong" else "i"
            result.append(f"<{tag}>{_inline(node.children)}</{tag}>")
        elif kind == "link":
            label = _inline(node.children)
            uri = str(node.attrs.get("href", ""))
            if is_safe_link(uri):
                result.append(
                    f'<a href="{escape(uri)}"><span foreground="#8ab4f8">{label}</span></a>'
                )
            else:
                result.append(f"{label} ({escape(uri)})")
        elif node.children:
            result.append(_inline(node.children))
        else:
            result.append(escape(node.content))
    return "".join(result)


@dataclass
class _Block:
    start: int
    end: int
    markup: str

    def indent(self, first: str, rest: str) -> None:
        self.markup = first + self.markup.replace("\n", "\n" + rest)


def _blocks(nodes: list[SyntaxTreeNode]) -> list[_Block]:
    result = []
    for node in nodes:
        kind = node.type
        if kind in {"bullet_list", "ordered_list"}:
            start = int(node.attrs.get("start", 1))
            for index, item in enumerate(node.children, start):
                marker = "• " if kind == "bullet_list" else f"{index}. "
                blocks = _blocks(item.children)
                if not blocks:
                    blocks = [_Block(*item.map, "")]
                for number, block in enumerate(blocks):
                    indent = " " * len(marker)
                    block.indent(marker if number == 0 else indent, indent)
                result.extend(blocks)
        elif kind == "blockquote":
            blocks = _blocks(node.children)
            for block in blocks:
                block.indent("│ ", "│ ")
            result.extend(blocks)
        else:
            if kind in {"fence", "code_block"}:
                markup = _CODE.format(escape(node.content.removesuffix("\n")))
            elif kind == "hr":
                markup = "────────────"
            else:
                markup = _inline(node.children)
                if kind == "heading":
                    size = {"h1": "x-large", "h2": "large"}.get(node.tag, "medium")
                    markup = f'<span size="{size}" weight="bold">{markup}</span>'
            result.append(_Block(*node.map, markup))
    return result


def render_markdown(text: str) -> str | None:
    """Return escaped, allowlisted GTK markup, or None for the literal preview.

    Source line maps keep blank lines and ordinary multiline notes intact. The
    parser is confined here so removing the optional extra needs no data migration.
    """
    if MarkdownIt is None:
        return None
    parser = MarkdownIt("commonmark", {"html": False})
    blocks = _blocks(SyntaxTreeNode(parser.parse(text)).children)
    result = []
    previous_end = None
    for block in blocks:
        if previous_end is not None:
            result.append("\n" * max(1, block.start - previous_end + 1))
        result.append(block.markup)
        previous_end = block.end
    markup = "".join(result)
    return markup if markup != escape(text) else None
