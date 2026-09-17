"""Command-line interface. Database commits always precede desktop rendering."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from contextlib import nullcontext
from pathlib import Path

from pinote import __version__, markdown, notify
from pinote.logging_setup import LOGGER, configure_logging
from pinote.paths import Paths, display_lock
from pinote.reminders import local_reminder_time, parse_reminder_time
from pinote.store import NoteError, Store

COMMANDS = {
    "add",
    "list",
    "done",
    "rm",
    "restore",
    "history",
    "show",
    "import",
    "export",
    "schedule",
    "reminders",
}
MUTATIONS = {"add", "done", "rm", "restore", "import", "schedule"}


def positive_id(value: str) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("ID must be a positive integer") from exc
    if result < 1 or result > 9223372036854775807:
        raise argparse.ArgumentTypeError("ID must be a positive SQLite integer")
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="note",
        description="Pinned desktop reminders with stable IDs and durable history.",
        epilog='Shortcuts: note lists active notes; note "some text" adds a note. '
        'Use note add "done" for text matching a command name.',
    )
    result.add_argument("--version", action="version", version=f"pinote {__version__}")
    result.add_argument("--no-notify", action="store_true", help="skip automatic desktop refresh")
    subs = result.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("add", "add a note (also the default for text arguments)"),
        ("list", "list active notes"),
        ("done", "mark a note done"),
        ("rm", "archive a note without erasing history"),
        ("restore", "return an archived/scheduled note to active, or clear progress"),
        ("history", "show timestamped activity, optionally for one note"),
        ("show", "show or reopen the desktop reminder"),
        ("import", "import a Markdown file once, without changing it"),
        ("export", "write active notes as Markdown to stdout"),
        ("schedule", "schedule a reminder for a note"),
        ("reminders", "list scheduled reminders"),
    ):
        sub = subs.add_parser(name, help=help_text)
        sub.add_argument(
            "--no-notify",
            action="store_true",
            default=argparse.SUPPRESS,
            help="skip automatic desktop refresh",
        )
        if name == "add":
            sub.add_argument("text", nargs="+", help="note text; quote shell metacharacters")
        elif name in {"done", "rm", "restore", "history"}:
            kwargs = {"nargs": "?"} if name == "history" else {}
            sub.add_argument("id", type=positive_id, **kwargs)
        elif name == "schedule":
            sub.add_argument("id", type=positive_id)
            sub.add_argument("when", help='local time or ISO time, e.g. "2030-01-02 09:30"')
        elif name in {"list", "export"}:
            sub.add_argument(
                "--all",
                action="store_true",
                help="include all states (export includes only active/in-progress/done notes)",
            )
        elif name == "import":
            sub.add_argument("path", type=Path)
    return result


def arguments(argv: list[str]) -> argparse.Namespace:
    prefix = []
    while argv and argv[0] == "--no-notify":
        prefix.append(argv[0])
        argv = argv[1:]
    if not argv:
        argv = ["list"]
    elif argv[0] not in COMMANDS and argv[0] not in {"-h", "--help", "--version"}:
        argv = ["add", *argv]
    return parser().parse_args([*prefix, *argv])


def execute(args: argparse.Namespace, paths: Paths) -> int:
    refresh = args.command in MUTATIONS and not args.no_notify
    scheduled_when = parse_reminder_time(args.when) if args.command == "schedule" else None
    needs_lock = args.command in MUTATIONS | {"show"}
    lock = display_lock(paths) if needs_lock else nullcontext()
    with lock, Store(paths.database) as store:
        # No nested lock, and ordinary reads stay lock-free unless a timer is due.
        if needs_lock:
            store.activate_due()
        elif store.has_due():
            with display_lock(paths):
                store.activate_due()
        if args.command == "add":
            note_id = store.add(" ".join(args.text))
            print(f"Added note {note_id}.")
        elif args.command == "schedule":
            changed = store.schedule(args.id, scheduled_when)
            when = local_reminder_time(scheduled_when.isoformat())
            status = "scheduled" if changed else "already scheduled"
            print(f"Note {args.id} {status} for {when}.")
        elif args.command == "reminders":
            notes = store.scheduled_notes()
            for note in notes:
                text = note.text.replace("\n", "\n    ")
                print(f"{note.id}. {local_reminder_time(note.remind_at)} {text}")
            if not notes:
                print("No scheduled reminders.")
        elif args.command in {"done", "rm", "restore"}:
            changed = store.transition(args.id, args.command)
            state = {"done": "done", "rm": "removed", "restore": "active"}[args.command]
            print(f"Note {args.id}: {state}." if changed else f"Note {args.id} is already {state}.")
        elif args.command == "list":
            notes = store.notes(all_states=args.all)
            for note in notes:
                state = (
                    f"[{note.state.replace('_', ' ')}] "
                    if args.all or note.state == "in_progress"
                    else ""
                )
                text = note.text.replace("\n", "\n    ")
                scheduled = f" ({local_reminder_time(note.remind_at)})" if note.remind_at else ""
                print(f"{note.id}. {state}{text}{scheduled}")
            if not notes:
                print("No notes." if args.all else "No active notes.")
        elif args.command == "history":
            events = store.history(args.id)
            for event in events:
                previous = event["previous_state"] or "new"
                text = event["text"].replace("\n", "\\n")
                if event["remind_at"] or event["previous_remind_at"]:
                    old, new = (
                        local_reminder_time(value) if value else "none"
                        for value in (event["previous_remind_at"], event["remind_at"])
                    )
                    text = f"reminder {old} -> {new}  {text}"
                elif event["action"] == "edit":
                    text = f"{event['previous_text']!r} -> {event['text']!r}"
                elif event["action"] == "tag":
                    old = repr(event["previous_tag"]) if event["previous_tag"] else "Untagged"
                    new = repr(event["tag"]) if event["tag"] else "Untagged"
                    text = f"tag {old} -> {new}  {text}"
                print(
                    f"{event['occurred_at']}  #{event['note_id']}  {event['action']}  "
                    f"{previous} -> {event['state']}  {text}"
                )
            if not events:
                print("No history.")
        elif args.command == "import":
            source = args.path.expanduser().resolve(strict=True)
            entries = markdown.parse(source.read_text(encoding="utf-8"))
            count = store.import_notes(str(source), entries)
            print(
                "Source already imported; nothing added."
                if count is None
                else f"Imported {count} notes."
            )
        elif args.command == "export":
            print(markdown.export(store.notes(all_states=args.all)), end="")
        if refresh or args.command == "show":
            try:
                notify.show(store.notes())
            except notify.NotificationError as exc:
                if args.command == "show":
                    LOGGER.error("%s", exc)
                    return 1
                LOGGER.warning("Notes saved, but desktop refresh failed: %s", exc)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = arguments(list(sys.argv[1:] if argv is None else argv))
    paths = Paths.discover()
    try:
        configure_logging(paths)
        return execute(args, paths)
    except (NoteError, OSError, sqlite3.Error, UnicodeError) as exc:
        LOGGER.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        LOGGER.warning("Interrupted. Run note to check the saved state.")
        return 130
    except Exception:
        LOGGER.exception("Unexpected failure. Run note to check the saved state.")
        return 1
