from pinote import markdown
from pinote.store import Note


def note(text, state="active", note_id=1):
    return Note(note_id, text, state, "now", "now")


def test_import_reminder_format():
    text = "# Title\n\n- [ ] next\n* [x] finished\n+ plain\n## Heading\nfree text\n"
    assert markdown.parse(text) == [
        ("next", "active"),
        ("finished", "done"),
        ("plain", "active"),
        ("free text", "active"),
    ]


def test_export_omits_removed_and_preserves_unicode():
    notes = [note("<&> 🐦"), note("done", "done", 2), note("gone", "removed", 3)]
    assert markdown.export(notes) == "# Reminders\n\n- [ ] <&> 🐦\n- [x] done\n"


def test_multiline_roundtrip_including_blank_lines_and_headings():
    text = "first\n\n# literal heading\n- literal bullet\n    indented\nlast"
    assert markdown.parse(markdown.export([note(text)])) == [(text, "active")]


def test_unicode_line_separators_do_not_split_one_note_into_many():
    text = "first\u2028second\u2029third"
    assert markdown.parse(markdown.export([note(text)])) == [(text, "active")]


def test_blank_file_and_headings_only():
    assert markdown.parse("\n# Title\n\n## Heading\n") == []
