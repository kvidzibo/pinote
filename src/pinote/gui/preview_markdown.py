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


def _inline(nodes: list[SyntaxTreeNode], *, title: bool = False) -> str:
    first_line = title

    def render(nodes: list[SyntaxTreeNode]) -> str:
        nonlocal first_line
        result = []
        for node in nodes:
            kind = node.type
            if kind in {"softbreak", "hardbreak"}:
                first_line = False
                result.append("\n")
            elif kind in {"strong", "em"}:
                tag = "b" if kind == "strong" else "i"
                result.append(f"<{tag}>{render(node.children)}</{tag}>")
            elif kind == "link":
                label = render(node.children)
                uri = str(node.attrs.get("href", ""))
                if is_safe_link(uri):
                    result.append(
                        f'<a href="{escape(uri)}"><span foreground="#8ab4f8">{label}</span></a>'
                    )
                else:
                    result.append(f"{label} ({escape(uri)})")
            elif node.children and kind != "image":
                result.append(render(node.children))
            else:
                if kind == "code_inline":
                    markup = _CODE.format(escape(node.content))
                elif kind == "image":
                    markup = escape(f"[Image: {node.content}]")
                else:
                    markup = escape(node.content)
                if first_line and markup:
                    markup = f'<span size="x-large" weight="bold">{markup}</span>'
                result.append(markup)
        return "".join(result)

    return render(nodes)


@dataclass
class _Block:
    start: int
    end: int
    markup: str

    def indent(self, first: str, rest: str) -> None:
        self.markup = first + self.markup.replace("\n", "\n" + rest)


def _blocks(nodes: list[SyntaxTreeNode], *, title: bool = False) -> list[_Block]:
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
                markup = _inline(
                    node.children, title=title and kind == "paragraph" and node.map[0] == 0
                )
                if kind == "heading":
                    size = {"h1": "x-large", "h2": "large"}.get(node.tag, "medium")
                    markup = f'<span size="{size}" weight="bold">{markup}</span>'
            result.append(_Block(*node.map, markup))
    return result


def render_markdown(text: str, *, title: bool = False) -> str | None:
    """Return escaped, allowlisted GTK markup, or None for the literal preview.

    Source line maps keep blank lines and ordinary multiline notes intact. With
    title=True, an ordinary multiline task starts with a display-only H1. The
    parser is confined here so removing the optional extra needs no data migration.
    """
    if MarkdownIt is None:
        return None
    parser = MarkdownIt("commonmark", {"html": False})
    # Style the existing inline tree, rather than reparsing a generated heading:
    # reparsing can turn visible body lines into invisible reference definitions.
    blocks = _blocks(SyntaxTreeNode(parser.parse(text)).children, title=title and "\n" in text)
    result = []
    previous_end = None
    for block in blocks:
        if previous_end is not None:
            result.append("\n" * max(1, block.start - previous_end + 1))
        result.append(block.markup)
        previous_end = block.end
    markup = "".join(result)
    return markup if markup != escape(text) else None
