from pinote.gui import preview_markdown


def test_task_title_is_preview_heading_only(monkeypatch):
    source = "Literal <b>& 🐦</b>\n\nDetails"
    assert preview_markdown.render_markdown(source, title=True) == (
        '<span size="x-large" weight="bold">Literal &lt;b&gt;&amp; 🐦&lt;/b&gt;</span>\n\nDetails'
    )
    assert preview_markdown.render_markdown(source) is None
    assert preview_markdown.render_markdown("Single line", title=True) == (
        '<span size="x-large" weight="bold">Single line</span>'
    )
    assert preview_markdown.render_markdown("Title\n[ref]: https://example.org", title=True) == (
        '<span size="x-large" weight="bold">Title</span>\n[ref]: https://example.org'
    )
    assert preview_markdown.render_markdown("**Title\nDetails**", title=True) == (
        '<b><span size="x-large" weight="bold">Title</span>\nDetails</b>'
    )
    for explicit in ("## Heading\nDetails", "Heading\n=======\nDetails", "```\ncode\n```"):
        assert preview_markdown.render_markdown(explicit, title=True) == (
            preview_markdown.render_markdown(explicit)
        )
    monkeypatch.setattr(preview_markdown, "MarkdownIt", None)
    assert preview_markdown.render_markdown(source, title=True) is None


def test_agent_subheading_is_compact_without_reinterpreting_fields():
    from pinote.store import Note

    task = "Title\n\nBody"
    note = Note(
        1,
        task,
        "active",
        "created",
        "updated",
        agent_notes={"First": "- One\n- Two", "Next": "Review"},
    )
    assert "\n\n## Agent\n" in note.markdown
    assert preview_markdown.render_markdown(
        note.markdown, title=True, compact_from=task.count("\n") + 2
    ) == (
        '<span size="x-large" weight="bold">Title</span>\n\nBody\n'
        '<span size="large" weight="bold">Agent</span>\nFirst: - One\n• Two\nNext: Review'
    )


def test_basic_markdown_is_safe_markup_with_optional_plain_text_fallback(monkeypatch):
    source = (
        "# Heading & 🐦\n\n"
        "**Bold _italic_** and `code <&>`\n\n"
        "- First\n  - Nested\n\n    More\n- Last\n\n"
        "3. Three\n4. Four\n\n"
        "> Quote\n\n"
        "```text\n<b>code & only</b>\n```\n\n"
        "[Web](https://example.org/?a=1&b=2) [Mail](mailto:test@example.org)\n"
        "[Local](file:///tmp/private) [App](javascript:alert(1)) [Relative](./file)\n"
        '<b>Not HTML</b> <img src="https://example.org/pixel">\n'
        "![Alt](https://example.org/image.png)"
    )
    assert preview_markdown.render_markdown(source) == (
        '<span size="x-large" weight="bold">Heading &amp; 🐦</span>\n\n'
        '<b>Bold <i>italic</i></b> and <span font_family="monospace" '
        'background="#1c212a">code &lt;&amp;&gt;</span>\n\n'
        "• First\n  • Nested\n\n    More\n• Last\n\n"
        "3. Three\n4. Four\n\n"
        "│ Quote\n\n"
        '<span font_family="monospace" background="#1c212a">'
        "&lt;b&gt;code &amp; only&lt;/b&gt;</span>\n\n"
        '<a href="https://example.org/?a=1&amp;b=2"><span foreground="#8ab4f8">Web</span></a> '
        '<a href="mailto:test@example.org"><span foreground="#8ab4f8">Mail</span></a>\n'
        "[Local](file:///tmp/private) [App](javascript:alert(1)) Relative (./file)\n"
        "&lt;b&gt;Not HTML&lt;/b&gt; &lt;img src=&quot;https://example.org/pixel&quot;&gt;\n"
        "[Image: Alt]"
    )
    assert preview_markdown.render_markdown("Literal <b>& 🐦</b>\n\n\nText\twith tab") is None
    monkeypatch.setattr(preview_markdown, "MarkdownIt", None)
    assert preview_markdown.render_markdown(source) is None
