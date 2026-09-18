from pinote.gui import preview_markdown


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
