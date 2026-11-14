"""One-request, GTK-free JSON boundary for the optional Electron frontend."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from contextlib import redirect_stdout
from dataclasses import asdict
from pathlib import Path

from pinote import __version__
from pinote.gui.config import ConfigError, GuiConfig
from pinote.gui.kitty import start_in_kitty
from pinote.gui.model import ReminderModel
from pinote.logging_setup import LOGGER, configure_logging
from pinote.paths import Paths, display_lock
from pinote.reminders import parse_reminder_time
from pinote.store import NoteError, Store, validate_tag

PROTOCOL = 1
MAX_REQUEST = 1024 * 1024
MAX_ID = 9007199254740991
SOURCES = {
    "start": {"active"},
    "reset": {"in_progress"},
    "done": {"active", "in_progress"},
    "rm": {"active", "in_progress"},
    "restore": {"done", "removed", "scheduled"},
}
FIELDS = {
    "handshake": set(),
    "snapshot": {"view"},
    "add": {"text", "tag"},
    "edit": {"id", "revision", "text"},
    "transition": {"id", "revision", "state", "action"},
    "tag": {"id", "revision", "tag"},
    "schedule": {"id", "revision", "when"},
    "create_tag": {"name", "folder"},
    "rename_tag": {"name", "newName"},
    "delete_tag": {"name"},
    "tag_folder": {"name", "folder"},
    "completions": {"ids"},
    "kitty": {"id", "revision", "directory"},
}


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message


def invalid() -> None:
    raise BridgeError("invalid", "Invalid bridge request.")


def safe_id(value: object) -> bool:
    return type(value) is int and 1 <= value <= MAX_ID


def pairs(items: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            invalid()
        result[key] = value
    return result


def decode(data: bytes) -> dict:
    if len(data) > MAX_REQUEST:
        invalid()
    try:
        request = json.loads(
            data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=lambda _: invalid()
        )
        # Bound nesting independently of the interpreter's recursion limit.
        pending = [(request, 0)]
        while pending:
            value, depth = pending.pop()
            if depth > 16:
                invalid()
            if isinstance(value, dict):
                pending.extend((v, depth + 1) for v in value.values())
            elif isinstance(value, list):
                pending.extend((v, depth + 1) for v in value)
            elif isinstance(value, float):
                # No operation takes floating point values (including exponent overflow).
                invalid()
        return request
    except (ValueError, UnicodeError, RecursionError):
        invalid()


def validate(request: object) -> tuple[str, dict]:
    if not isinstance(request, dict) or set(request) != {"protocol", "operation", "params"}:
        invalid()
    if type(request["protocol"]) is not int or request["protocol"] != PROTOCOL:
        invalid()
    op, p = request["operation"], request["params"]
    if not isinstance(op, str) or op not in FIELDS or not isinstance(p, dict):
        invalid()
    fields = FIELDS[op]
    if op == "create_tag" and ("id" in p or "revision" in p):
        fields = fields | {"id", "revision"}
    if set(p) != fields:
        invalid()
    for key, value in p.items():
        if key == "id":
            if not safe_id(value):
                invalid()
        elif key == "ids":
            if not isinstance(value, list) or len(value) > 1000 or not all(map(safe_id, value)):
                invalid()
        elif value is None and key in {"tag", "folder"}:
            continue
        elif not isinstance(value, str):
            invalid()
        elif any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            invalid()
    if "revision" in p and (
        not p["revision"] or len(p["revision"]) > 128 or not p["revision"].isprintable()
    ):
        invalid()
    if op == "snapshot" and p["view"] not in {"active", "archive", "scheduled"}:
        invalid()
    if op == "transition" and (
        p["action"] not in SOURCES or p["state"] not in SOURCES[p["action"]]
    ):
        invalid()
    return op, p


def conflict() -> None:
    raise BridgeError("conflict", "This task changed elsewhere. Refresh before trying again.")


def folder_available(folder: str | None) -> bool:
    try:
        return bool(folder and Path(folder).is_dir() and os.access(folder, os.R_OK | os.X_OK))
    except OSError:
        return False


def dispatch(op: str, p: dict, paths: Paths) -> object:
    if op == "handshake":
        return {
            "version": __version__,
            "protocol": PROTOCOL,
            "database": str(paths.database.resolve()),
        }
    model = ReminderModel(paths)
    if op == "snapshot":
        config = GuiConfig.load()
        notes = {"active": model.notes, "archive": model.archive, "scheduled": model.reminders}[
            p["view"]
        ]()
        if any(not safe_id(n.id) or not 0 <= n.agent_event_id <= MAX_ID for n in notes):
            raise BridgeError("internal", "Database IDs exceed the supported range.")
        folders = model.tag_folders()
        return {
            "notes": [asdict(n) for n in notes],
            "tags": [
                {
                    "name": name,
                    "folder": folders.get(name),
                    "available": folder_available(folders.get(name)),
                }
                for name in model.tags()
            ],
            "config": {
                "maxVisibleNotes": config.max_visible_notes,
                "markdownPreview": config.markdown_preview,
                "kittyStartPrompt": config.kitty_start_prompt,
            },
        }
    if op == "completions":
        return sorted(model.completed_ids(set(p["ids"])))
    # All mutations use public Store methods, and never refresh after committing.
    with display_lock(paths, blocking=False), Store(paths.database, timeout=0.1) as store:
        target = {"id": p["id"]} if "id" in p else {}
        if op == "add":
            return {"changed": True, "id": store.add(p["text"], tag=p["tag"])}
        if op == "transition":
            changed = store.transition(
                p["id"],
                p["action"],
                expected_states={p["state"]},
                expected_updated_at=p["revision"],
            )
            if not changed:
                conflict()
        elif op == "edit":
            changed, revision = store.edit_with_revision(
                p["id"], p["text"], expected_updated_at=p["revision"]
            )
            return {"changed": changed, **target, "revision": revision}
        elif op == "tag":
            changed, revision = store.set_tag_with_revision(
                p["id"], p["tag"], expected_updated_at=p["revision"]
            )
            return {"changed": changed, **target, "revision": revision}
        elif op == "schedule":
            changed = store.schedule(
                p["id"], parse_reminder_time(p["when"]), expected_updated_at=p["revision"]
            )
        elif op == "create_tag":
            name = validate_tag(p["name"])
            if name is None:
                raise NoteError("Tag name cannot be empty.")
            if "id" not in p:
                return {"changed": True, "tag": store.create_tag(name, folder=p["folder"])}
            # Resolve canonical spelling before the atomic attach, under the display lock.
            tags = store.tags()
            saved = (
                name
                if name in tags
                else next((t for t in tags if t.casefold() == name.casefold()), name)
            )
            _, revision = store.set_tag_with_revision(
                p["id"], name, expected_updated_at=p["revision"], folder=p["folder"]
            )
            return {"changed": True, "id": p["id"], "tag": saved, "revision": revision}
        elif op == "rename_tag":
            changed = store.rename_tag(p["name"], p["newName"])
        elif op == "delete_tag":
            changed = store.delete_tag(p["name"])
        elif op == "tag_folder":
            changed = store.set_tag_folder(p["name"], p["folder"])
        elif op == "kitty":
            config = GuiConfig.load()
            note = store.get(p["id"])
            if note.updated_at != p["revision"] or note.state not in {"active", "in_progress"}:
                conflict()
            summary = note.text.splitlines()[0][:30]
            title = (f"[{note.tag}] {summary}" if note.tag else summary).strip()
            try:
                start_in_kitty(p["directory"], note, title, config.kitty_start_prompt)
            except Exception:
                raise BridgeError(
                    "unknown",
                    "Kitty launch outcome is uncertain. Check the tab "
                    "or new window before retrying.",
                ) from None
            changed = True
        else:
            invalid()
        return {"changed": changed, **target}


def respond(request: object, paths: Paths | None = None) -> dict:
    try:
        op, params = validate(request)
        result = dispatch(op, params, paths or Paths.discover())
        return {"protocol": PROTOCOL, "ok": True, "result": result}
    except BridgeError as exc:
        code, message = exc.code, exc.message
    except BlockingIOError:
        code, message = "busy", "Another frontend is busy. Try again shortly."
    except sqlite3.OperationalError as exc:
        code = (
            "busy"
            if exc.sqlite_errorcode in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}
            else "internal"
        )
        message = "Database is busy." if code == "busy" else "Database operation failed."
    except NoteError as exc:
        code = (
            "conflict"
            if str(exc).startswith(("This task changed", "No note with ID"))
            else "invalid"
        )
        # Existing validation messages contain no task text or credentials.
        message = str(exc)
    except ConfigError:
        code, message = "invalid", "Invalid GUI configuration. Check config.toml."
    except Exception:
        code, message = "internal", "Backend operation failed."
    return {"protocol": PROTOCOL, "ok": False, "error": {"code": code, "message": message}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.parse_args(argv)
    try:
        request = decode(sys.stdin.buffer.read(MAX_REQUEST + 1))
        op, _ = validate(request)
        paths = Paths.discover()
        if op != "handshake":
            # The existing logger has a stdout stream: redirect it to protocol-safe stderr.
            with redirect_stdout(sys.stderr):
                configure_logging(paths)
        response = respond(request, paths)
        if not response["ok"] and op != "handshake":
            LOGGER.warning("Electron bridge request failed (%s).", response["error"]["code"])
    except BridgeError as exc:
        response = {
            "protocol": PROTOCOL,
            "ok": False,
            "error": {"code": exc.code, "message": exc.message},
        }
    except Exception:
        response = {
            "protocol": PROTOCOL,
            "ok": False,
            "error": {"code": "internal", "message": "Backend operation failed."},
        }
    sys.stdout.buffer.write(
        (json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
