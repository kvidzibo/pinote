# CLI, reminders, and data

[Quickstart](../README.md) · [CLI and data](usage.md) · [Electron](electron.md) · [Development](development.md)

Run checkout-relative commands from the repository root.

## Install

Requires **Node.js 22.19+**, npm, Linux `flock` (util-linux), and GNU `/usr/bin/date` with system timezone data for local reminders.
Use UTF-8 for profile paths, launcher paths, and filenames passed to the CLI.
Pinote rejects undecodable paths rather than using a different file with a similar name.
Dunst (`dunstify`) is needed only for desktop notifications.
The notifier uses portable short options and a stack-tag hint to support older
distribution packages as well as current Dunst releases.
Terminal commands work without Dunst. Install Dunst using your distribution's
package manager; a graphical session and session D-Bus are needed to display
reminders.

From a checkout:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
./backend/bin/note --help
# Optional global installation:
npm install -g ./backend
```

Use the checkout executable directly or keep npm's global bin directory on `PATH`.
After source changes, rebuild; reinstall if using the global copy. For an offline
transfer, `(cd backend && npm pack)` produces a tarball containing the CLI and
bundled backend. No Python runtime or database conversion is needed. Installation
never changes desktop startup or existing reminders.

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
note agent start 2 --expected-updated-at 'REVISION_FROM_GET' # no project selection
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

`agent start` starts an active task without storing a project selection. It also
accepts an unchanged in-progress task without adding history. Its revision check
and transition are atomic; use it for a task selected by another UI.
With note 0.25.0+, optional `--pi-session-id ID` also appends that Pi
session ID (up to 256 characters) atomically to the task's `pi-sessions` array. Duplicate IDs are ignored;
recording session metadata alone does not change `updated_at` or add history events.
`agent get` and other task JSON responses include the array (initially `[]`). It
survives edits, completion and restoration, is not an editable handoff field, and
is omitted from Markdown exports. Remote Pi selection supplies the ID automatically.

Use the returned `updated_at` for guarded starts, updates, tagging, and completion; a stale revision fails
without changing anything. Fields are retained as history snapshots and displayed
under `## Agent` in terminal listings and in the Agent section of Electron's
preview and expanded Archive and Scheduled reminders entries. Editing task text
leaves fields intact; use **Agent fields** to edit them separately in Electron.
Completion, removal and scheduling clear project selections; restoring does not
silently reselect tasks.

The existing `list --json` format is unchanged; use `agent get` for handoff data.
`PRs` shows multiple GitHub or Forgejo PR links in the Pi footer, one URL or
Markdown link per line, with independent CI/merge status colours when the
corresponding provider's watcher is enabled. Legacy `PR` values remain readable; see
[multiple PRs](../pi/README.md#multiple-prs).
`Bar`, one field label per line, shows those fields as Markdown text; links in them
are clickable. Other fields stay on the task only.
See the [Pi extension](../pi/README.md) for `/pinote`, Settings actions, footer status, and tools.
Optional [field watchers](../pi/FIELD_EVENTS.md) run trusted executables
while the desktop is open; `note field-events` and `note task-events` expose bounded, read-only field and task history.
New sessions can continue locally; there is no automatic cross-machine sync.

### Scheduled reminders

Add a note normally, then schedule it for a **future local date and time**. It leaves
the active list and stays in the separate reminders list until due. Reminders are
one-shot: when due they return as unchecked active tasks with the same ID, text,
tag, and history. Scheduling an in-progress task clears its progress.

In Electron, use **Set reminder…** from a task's actions to choose a local date
and time. **Menu → Scheduled reminders** lists scheduled tasks and their trigger
times. Use **Change reminder time** to reschedule or **Release reminder now** to
return a task early. The checklist's tag filter still applies when a reminder returns.

Due reminders return when Electron refreshes, including after it next opens or
resumes, or when a `note` command runs. There is **no background service,
wake-up alarm, or automatic Dunst notification** for timers. Electron changes
do not refresh Dunst.

CLI equivalents: `note schedule ID "YYYY-MM-DD HH:MM"`, `note reminders`, and
`note restore ID` to bring one back early. `note rm ID` archives a scheduled note
and cancels its timer. Times are stored in UTC; input without an offset uses the
system timezone or an installed IANA zone such as `America/New_York`. If `TZ`
is an unsupported POSIX rule or uses a custom zone file, provide an explicit
UTC offset; reminders then display in UTC. Offset example:
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

#### Desktop login

To show the Dunst reminder at i3 login, replace any old reminder startup command with:

```i3
exec --no-startup-id /home/your-user/.local/bin/note show
```

Use the actual absolute path from `command -v note`. Pinote does not edit i3
configuration. See the [Electron launch guide](electron.md#install-and-launch-from-a-checkout).

## Import existing reminders

```sh
note import ~/Documents/reminders.md
```

This is explicit and never runs during installation. The source file is read
only. Use top-level bullets for untagged notes, or a plain parent bullet for a
tag with indented child notes:

```markdown
- untagged note
- Work
  - prepare report
  - [x] send invoice
```

Missing tags are created; existing tags are reused case-insensitively. The summary
reports notes imported and tags created. Headings, blank lines, and other non-list
text are ignored. Only one child-list level is supported; this is a small reminder
format, not a full Markdown parser (code blocks are not supported).

Checkbox bullets always represent notes: `- [ ]` is active, `- [x]` is done,
and `- [~]` is in progress. For these notes, continuation lines indented four
spaces beyond the bullet's indentation preserve literal multiline text, including
headings and bullets. Export uses this format to preserve text and progress.

Each canonical source path is imported at most once, atomically. Re-running the
import does not duplicate notes, even if the file changes. An empty import does
not mark the source as imported. A copy at another path is a separate source.
SQLite becomes the source of truth; editing the old Markdown file does not
change pinote. Export omits tag metadata.
Scheduled notes are excluded from Markdown exports, even with `--all`; use
`note reminders` to list them. Export is a readable snapshot, **not** a backup of
IDs, tags, scheduled times, agent fields, project selections, or history.

## Data, privacy, and backup

- Notes/history, agent fields and per-directory selections: `$XDG_DATA_HOME/pinote/notes.db`
  (default `~/.local/share/pinote/notes.db`).
- Electron drafts and UI state: `electron/state.json` beside `notes.db`; window
  geometry: `electron/window.json`. See [Electron state and recovery](electron.md#shared-tasks-separate-ui-state-and-recovery).
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

For a complete task and desktop state backup, close Electron, stop running `note`
commands, and copy `notes.db` plus the `electron/` directory beside it if present.
Restore them while pinote is stopped.
Do not copy a live database mid-write. Keep personal data and exports out of Git.
If storing copies inside a checkout, use its ignored `exports/` and `backups/`
directories. Databases, draft caches, logs, local `MEMORY.md`/`REMINDER.md`,
environment files, and key files are also ignored.
Arbitrarily named exports elsewhere are not automatically protected; inspect
staged files before publishing. Uninstalling the tool does not delete data.

### Upgrading for scheduled reminders

Back up `notes.db` first. Update every installation that opens the database,
including Electron and the CLI used by Pi. `note` versions before 0.25.0 cannot read
schema 8.

The first database open upgrades schema 1–7 to **8** atomically, retaining note
IDs, timestamps, tags, reminders, history, and import markers. Tasks from schema
1 or 2 start untagged. Schema 5 stores tags separately, including unused tags.
Schema 6 adds agent fields (initially empty), history snapshots, and per-directory
Pi task selections. Schema 7 adds optional tag folders (initially unset), and
schema 8 adds persistent Pi session IDs (initially empty).

Edits and tag changes retain the task ID and record old/new values in history;
`note history ID` shows them. Editing a task does not replace historical text.

`pinote-gui` and the Python `note` CLI are no longer provided. An installed Python
`note` keeps working with the same schema-8 database but receives no updates.
Replace it: build and run `npm install -g ./backend`, then check that `note`
resolves to the Node CLI. Electron uses the same database but does not read GTK's unsaved input
or edit drafts (`gui-draft.txt`, `gui-edit-drafts/` beside `notes.db`): save
unfinished edits before upgrading, or copy their text from those files.
