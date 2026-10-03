# CLI, reminders, and data

[Quickstart](../README.md) · [CLI and data](usage.md) · [GTK and desktop](gui.md) · [Development](development.md)

Run checkout-relative commands from the repository root.

## Install

Requires **Python 3.11+** and Dunst (`dunstify`) for desktop notifications.
The notifier uses portable short options and a stack-tag hint to support older
distribution packages as well as current Dunst releases.
Terminal commands work without Dunst. Install Dunst using your distribution's
package manager; a graphical session and session D-Bus are needed to display
reminders.

From a checkout, choose one installer:

```sh
uv tool install .        # recommended, if you use uv
# or:
pipx install .           # no uv CLI required

note --help
```

Ensure your installer's tool bin directory (usually `~/.local/bin`) is on `PATH`.
Alternatively, use standard Python tooling without uv or pipx:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/note --help
```

Activate that virtual environment to invoke `note` without its full path.
The core package has no Python runtime dependencies; `uv_build` is a build-time
backend that pip installs automatically in an isolated build environment.
The optional GUI additionally needs GTK 3 and its Python bindings; see [GUI setup](gui.md).
The uv CLI is optional for users and recommended for the [development workflow](development.md). The package does not change your shell, desktop configuration, or
existing reminders. After local source changes, reinstall with your chosen
installer (for uv: `uv tool install --reinstall .` to rebuild the local source).

## Use

```sh
note "check backups"     # Add, save, then refresh/reopen the desktop reminder
note                     # List active notes in the terminal
note done 2              # Complete note 2
note rm 3                # Archive note 3; never erase it
note restore 3           # Reactivate a note, clear progress, or bring a reminder back early
note schedule 2 "2030-09-18 14:30" # Move note 2 to reminders until this local date/time
note reminders           # List scheduled reminders, earliest first
note history             # All timestamped events, oldest first (UTC)
note history 3           # Activity for one note
note list --all          # Include done, removed, and scheduled notes
note list --json         # JSON array of {id, text, state, tag} objects
note start 2             # Mark a task in progress
note show                # Show/reopen the persistent desktop notification
note --no-notify "later" # Save without refreshing the desktop
note export              # Active notes as Markdown on stdout
note export --all        # Active and done notes; removed/scheduled notes remain in the DB
```

IDs are permanent, never renumbered or reused. Repeating a transition to the
current state is a harmless no-op, not another history event. Restore a removed
note before marking it done. Removing a completed note is allowed.
In-progress tasks remain in the active list, marked **[in progress]** in terminal
and notification output. `note done ID` still completes a task directly;
`note restore ID` also clears progress without completing it.

Command names are reserved: use `note add "done"` to add the literal text `done`,
or `note add -- "--starts-with-a-dash"` for leading dashes. Quote shell
metacharacters. Notes can contain Unicode, quotes, and newlines, up to 4096
characters; empty notes and terminal control characters are rejected.

### Agent handoffs

`note agent` commands return JSON and never refresh Dunst. `agent select` stores
one task per canonical working directory for scripts. Pi sessions do not use that
row; each session remembers its own task. Fields belong to the task, not a session.

```sh
note agent select 2 --cwd "$PWD"    # start and select atomically
note agent selected --cwd "$PWD"    # task or null
note agent get 2                    # task, Markdown, fields, updated_at revision
note agent update 2 --expected-updated-at 'REVISION_FROM_GET' \
  --set-json '{"PR":"[Fix #42](https://github.com/org/repo/pull/42)","Next":"Review"}'
note agent update 2 --expected-updated-at 'LATEST_REVISION' --remove Next
note agent done 2 --expected-updated-at 'LATEST_REVISION'
note agent tags
note agent add --text "check backups" --tag pinote
note agent add --text "follow up" --tag pinote --cwd "$PWD"
note agent tag 2 --expected-updated-at 'REVISION' --tag Work
note agent tag 2 --expected-updated-at 'REVISION' --clear
```

`add` creates an active task and registers a new tag. `--cwd` also starts and
selects it for that project. `tag` requires the current revision and only changes
active or in-progress tasks; `--clear` removes the tag. `tags` lists saved names.
Adding or assigning a tag reuses a case-insensitive match's saved spelling:
`--tag pi` saves `Pi` if that tag already exists.
These commands do not refresh Dunst.

Update merges arbitrary label/Markdown-string pairs; it never overwrites task
text or its tag. Labels are trimmed, Unicode-normalized and case-sensitive (64 characters
maximum). Values use the same 4096-character/control-character rules as task
text. Up to 64 fields / 32 KiB JSON can be saved per task. Empty values are
rejected; use `--remove` instead. Conflicting set/remove labels are rejected.

Use the returned `updated_at` for updates, tagging, and completion; a stale revision fails
without changing anything. Fields are retained as history snapshots and displayed
under `## Agent` in terminal listings and the GTK Markdown preview. The task editor
edits only task text, leaving agent fields intact. Fields also remain visible as
literal text in the archive/reminders. Completion, removal and scheduling clear
project selections; restoring does not silently reselect tasks.

The existing `list --json` format is unchanged; use `agent get` for handoff data.
A valid `PR` field is shown in the Pi footer. `Bar`, one field label per line, shows
those fields as Markdown text; links in them are clickable. Other fields stay on the task only.
See the [Pi extension](../pi/README.md) for `/pi-note`, Settings actions, footer status, and tools.
New sessions can continue locally; there is no automatic cross-machine sync.

### Scheduled reminders

Add a note normally, then schedule it for a **future local date and time**. It leaves
the active list and stays in the separate reminders list until due. Reminders are
one-shot: when due they return as unchecked active tasks with the same ID, text,
tag, and history. Scheduling an in-progress task clears its progress.

In the GUI, use **right-click note text → Set reminder…**, choose a calendar date
and 24-hour time, then click **Set reminder**. **Bottom menu → Reminders…** shows
scheduled notes, earliest first, with their full text and local trigger time.
**Change time…** reschedules a reminder; **Move to main** cancels its timer and
returns it immediately. Closing the reminders window does not stop timers.
The main list's tag filter still applies when a reminder returns. Due reminders show
an **amber bell** on the main list, including after restarting the GUI. Hover over it
to see how long ago it was due, such as **Due 2 hours ago** (or **Due just now**).
This updates automatically and uses the original due time, even if delivered late.
The bell stays through edits and progress changes, until the task is completed,
deleted, or scheduled again. **Move to main** cancels the timer without adding a bell.

While the GUI is open, due reminders return on its next poll (about one second).
If pinote is closed or the computer is asleep, missed reminders return when the
GUI next opens/resumes or a `note` command runs. There is **no new background
service, wake-up alarm, or automatic Dunst notification** for timers; keep the GUI
open for automatic delivery to the main list. GUI-triggered changes do not refresh Dunst.

CLI equivalents: `note schedule ID "YYYY-MM-DD HH:MM"`, `note reminders`, and
`note restore ID` to bring one back early. `note rm ID` archives a scheduled note
and cancels its timer. Times are stored in UTC; input without an offset uses the
current local timezone. ISO times with an explicit offset are also accepted, e.g.
`2030-09-18T14:30:00+02:00`. Ambiguous or nonexistent local times at daylight-saving
changes are rejected; choose another time or use an explicit offset. All reminder
changes and automatic activations are recorded in `note history ID`.

### Desktop behavior

Add, start, schedule, done, remove, restore, and import automatically refresh **one** persistent
Dunst notification. A dismissed notification reopens on the next mutation or
`note show`. Closing it never changes the notes. `note` by itself only lists in
the terminal. `--no-notify` suppresses automatic refresh, not an explicit `show`.

The notification previews the first 10 active notes, up to 180 characters each;
`note` always shows the full text and list. When none remain it says “No active
reminders.” Note text is rendered literally, including markup and backslash
escape sequences. Dunst's pause, fullscreen, placement, and display policies
still apply; pinote does not override your desktop preferences.

Data is committed **before** notification delivery. If Dunst is missing or
unavailable, mutations still succeed (exit 0) with a warning. `note show` returns
1 on notification failure. Validation/storage errors return 1; CLI syntax errors
return 2. Do not repeat an add just because desktop delivery failed.

## Import existing reminders

```sh
note import ~/Documents/reminders.md
```

This is explicit and never runs during installation. The source file is read
only; headings/blank lines are ignored, bullets and plain lines become notes,
`- [x]` entries import as done, and `- [~]` entries import as in progress.
Export uses the same markers to preserve progress. Four-space-indented continuation lines belong
to the preceding note. This is a small reminder format, not a full Markdown
parser (nested lists and code blocks are not supported).

Each canonical source path is imported at most once, atomically. Re-running the
import does not duplicate notes, even if the file changes. An empty import does
not mark the source as imported. A copy at another path is a separate source.
SQLite becomes the source of truth; editing the old Markdown file does not
change pinote. Import creates untagged tasks; export omits tag metadata.
Scheduled notes are excluded from Markdown exports, even with `--all`; use
`note reminders` to list them. Export is a readable snapshot, **not** a backup of
IDs, tags, scheduled times, agent fields, project selections, or history.

## Data, privacy, and backup

- Notes/history, agent fields and per-directory selections: `$XDG_DATA_HOME/pinote/notes.db`
  (default `~/.local/share/pinote/notes.db`).
- Unfinished GUI input: `gui-draft.txt` beside `notes.db`, private to the current
  user and separate from tasks/history. It is saved about every 250 ms while editing
  and flushed on normal close; an abrupt termination may lose the latest edits.
  Draft read/write errors appear in the GUI and log. Drafts are plain text, not encrypted.
- Existing-task edit drafts: `gui-edit-drafts/ID.json` beside `notes.db`, private to
  the current user. They retain the original task revision and edited text, separately
  from tasks/history. Saved about every 250 ms and flushed on close; Save or Discard
  clears that task's draft. Restarting preserves drafts, including empty text and
  whitespace; abrupt termination may lose the latest edits. Drafts are not encrypted.
- GUI tag filter: `gui-filter.json` beside `notes.db`, private to the current user.
  Saved when changed and flushed on close; this is separate from the new-task tag selection.
- Viewed agent updates: `gui-agent-read.json` beside `notes.db`, private to the current
  user. It stores viewed event IDs, not task content, and is saved after viewing and
  flushed on close. Losing this file makes existing agent updates unread again.
- Display lock: the same data directory. Mutations and notifications are
  serialized so an older process cannot overwrite a newer display.
- Logs/warnings/unexpected failures: stdout and
  `$XDG_STATE_HOME/pinote/app.log` (default `~/.local/state/pinote/app.log`).
  Logs rotate at 1 MB, keeping three backups. Note text is not routinely logged.
- Relative XDG paths are ignored as required by the XDG specification.
- App directories and new data/log files are private to the current user.
- SQLite transactions keep note state and history consistent; no hard-delete
  command is provided. Done and removed notes remain recoverable.

Data stays local; pinote has no network calls or telemetry. Notifications are
sent to your desktop daemon and may also remain in Dunst's own history, so avoid
secrets in notes. Database and exports are not encrypted.

For a complete backup, close the GUI, stop running `note` commands, and copy
`notes.db` plus `gui-draft.txt`, `gui-edit-drafts/`, `gui-filter.json`, and
`gui-agent-read.json` if present;
restore them while pinote is stopped.
Do not copy a live database mid-write. Keep personal data and exports out of Git.
If storing copies inside a checkout, use its ignored `exports/` and `backups/`
directories. Databases, draft caches, logs, local `MEMORY.md`/`REMINDER.md`,
environment files, and key files are also ignored.
Arbitrarily named exports elsewhere are not automatically protected; inspect
staged files before publishing. Uninstalling the tool does not delete data.
