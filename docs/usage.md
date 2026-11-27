# CLI, reminders, and data

[Quickstart](../README.md) · [CLI and data](usage.md) · [Electron](electron.md) · [Development](development.md)

Run checkout-relative commands from the repository root.

## Install

Requires **Node.js 22.19+** and npm. From a checkout:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
./backend/bin/note --help
npm install -g ./backend   # optional global installation
```

- Use the checkout executable or keep npm's global bin directory on `PATH`. After
  source changes, rebuild, and reinstall a global copy.
- `(cd backend && npm pack)` produces a self-contained tarball for offline transfer.
- Dunst (`dunstify`), a graphical session and session D-Bus are needed only for
  desktop notifications. On macOS without Dunst, CLI changes skip the refresh silently.
- Local reminder times use Node's bundled IANA time zone data; `TZ`, if set, must
  name an IANA zone.
- Use UTF-8 for paths and filenames passed to the CLI; undecodable paths are rejected.
- Installation never changes desktop startup or existing reminders.

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

- IDs are permanent, never renumbered or reused.
- Repeating a transition to the current state is a no-op, not a history event.
- Restore a removed note before marking it done. Removing a completed note is allowed.
- In-progress tasks stay in the active list, marked **[in progress]**.
- Command names are reserved: use `note add "done"` for the literal text `done`,
  or `note add -- "--starts-with-a-dash"` for leading dashes. Quote shell
  metacharacters.
- Notes can contain Unicode, quotes, and newlines, up to 4096 characters. Empty
  notes and terminal control characters are rejected.

### Agent handoffs

`note agent` commands return JSON and never refresh Dunst. Fields belong to the
task, not a session.

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
note agent image HASH               # pasted image as {mime, data (base64)}, or null
note agent add --text "check backups" --tag pinote
note agent add --text "follow up" --tag pinote --cwd "$PWD"
note agent tag 2 --expected-updated-at 'REVISION' --tag Work
note agent tag 2 --expected-updated-at 'REVISION' --clear
```

Use the returned `updated_at` for guarded starts, updates, tagging, and
completion; a stale revision fails without changing anything.

- **`select`** stores one task per canonical working directory, for scripts. Pi
  sessions do not use it; each session remembers its own task. Completion,
  removal and scheduling clear selections; restoring does not reselect.
- **`start`** starts an active task without storing a selection, atomically with
  its revision check. An unchanged in-progress task is accepted without adding
  history. `--pi-session-id ID` (note 0.25.0+, up to 256 characters) also appends
  the ID to the task's `pi-sessions` array. Duplicates are ignored, and recording
  an ID alone changes neither `updated_at` nor history. The array appears in task
  JSON, survives edits, completion and restoration, is not an editable field, and
  is omitted from Markdown exports.
- **`add`** creates an active task and registers a new tag; `--cwd` also starts
  and selects it for that project.
- **`tag`** only changes active or in-progress tasks; `--clear` removes the tag.
  Tags reuse a case-insensitive match's saved spelling: `--tag pi` saves `Pi` if
  that tag exists. `tags` lists saved names.
- **`update`** merges label/Markdown-string pairs; it never overwrites task text
  or tag. Labels are trimmed, Unicode-normalized and case-sensitive (64
  characters maximum). Values follow task-text rules. Up to 64 fields / 32 KiB
  JSON per task. Empty values are rejected; use `--remove`. Conflicting
  set/remove labels are rejected.
- **`image`** (note 0.30.0+) reads an image pasted in Electron by the
  64-character hash in its `![image](pinote:sha256-HASH)` reference.

Fields are kept as history snapshots and shown under `## Agent` in terminal
listings and in Electron's preview, Archive and Scheduled reminders. Editing
task text leaves them intact. `list --json` does not include them; use `agent get`.

Two field names have meaning in the Pi footer: `PRs` (one GitHub or Forgejo URL
or Markdown link per line, with CI/merge status when that provider's watcher is
enabled; legacy `PR` values remain readable, see
[multiple PRs](../pi/README.md#multiple-prs)) and `Bar` (one field label per
line, shown as Markdown text).

See the [Pi extension](../pi/README.md) for `/pinote`, settings, footer status and
tools, and [field watchers](../pi/FIELD_EVENTS.md) for trusted executables that
run while the desktop is open. `note field-events` and `note task-events` expose
bounded, read-only field and task history. There is no cross-machine sync.

### Scheduled reminders

Schedule a note for a **future local date and time**. It leaves the active list
for the reminders list until due. Reminders are one-shot: when due they return
as unchecked active tasks with the same ID, text, tag, and history. Scheduling
an in-progress task clears its progress.

Due reminders return when Electron refreshes, including after it next opens or
resumes, or when a `note` command runs. There is **no background service,
wake-up alarm, or automatic Dunst notification** for timers.

- **CLI:** `note schedule ID "YYYY-MM-DD HH:MM"`, `note reminders`, and
  `note restore ID` to bring one back early. `note rm ID` archives a scheduled
  note and cancels its timer.
- **Electron:** **Set reminder…** in a task's actions; **Menu → Scheduled
  reminders** lists, reschedules and releases them. The tag filter still applies
  when a reminder returns.
- **Time zones:** times are stored in UTC. Input without an offset uses the system
  timezone or an installed IANA zone such as `America/New_York`. If `TZ` is an
  unsupported POSIX rule or a custom zone file, give an explicit offset, such as
  `2030-09-18T14:30:00+02:00`; reminders then display in UTC.
- Ambiguous or nonexistent local times at daylight-saving changes are rejected;
  choose another time or use an explicit offset.
- Reminder changes and automatic activations are recorded in `note history ID`.

### Desktop behavior

Add, start, schedule, done, remove, restore, and import refresh **one** persistent
Dunst notification. Electron changes do not.

- A dismissed notification reopens on the next mutation or `note show`. Closing
  it never changes the notes. `--no-notify` suppresses the automatic refresh, not
  an explicit `show`.
- It previews the first 10 active notes, up to 180 characters each, as literal
  text. Dunst's pause, fullscreen, placement, and display policies still apply.
- Data is committed **before** notification delivery. If Dunst is missing or
  unavailable, mutations still succeed (exit 0) with a warning. Do not repeat an
  add just because delivery failed.
- Exit codes: `note show` returns 1 on notification failure; validation/storage
  errors return 1; CLI syntax errors return 2.

To show the reminder at i3 login, use the absolute path from `command -v note`.
Pinote does not edit i3 configuration.

```i3
exec --no-startup-id /home/your-user/.local/bin/note show
```

## Import existing reminders

```sh
note import ~/Documents/reminders.md
```

Import is explicit, never runs during installation, and only reads the file. Use
top-level bullets for untagged notes, or a plain parent bullet for a tag with
indented child notes:

```markdown
- untagged note
- Work
  - prepare report
  - [x] send invoice
```

- Missing tags are created; existing tags are reused case-insensitively.
- Headings, blank lines, and other non-list text are ignored. Only one child-list
  level is supported, and code blocks are not.
- Checkbox bullets are always notes: `- [ ]` active, `- [x]` done, `- [~]` in
  progress. Their continuation lines, indented four spaces beyond the bullet,
  keep literal multiline text. Export uses this format.
- Each canonical source path is imported at most once, atomically, even if the
  file later changes. An empty import does not mark the source as imported; a
  copy at another path is a separate source.
- SQLite becomes the source of truth; editing the old file does not change pinote.

Export is a readable snapshot, **not** a backup: it omits IDs, tags, scheduled
notes and times (even with `--all`), agent fields, project selections, and history.

## Data, privacy, and backup

| Data | Location |
| --- | --- |
| Notes, history, agent fields, selections, pasted images | `$XDG_DATA_HOME/pinote/notes.db` (default `~/.local/share/pinote/notes.db`) |
| Electron drafts and UI state; window geometry | `electron/state.json` and `electron/window.json` beside `notes.db` ([details](electron.md#shared-tasks-separate-ui-state-and-recovery)) |
| Logs, warnings, unexpected failures | stdout and `$XDG_STATE_HOME/pinote/app.log` (default `~/.local/state/pinote/app.log`) |

- Logs rotate at 1 MB, keeping three backups. Note text is not routinely logged.
- The display lock lives in the data directory; it serializes mutations and
  notifications. Relative XDG paths are ignored. App directories and new files are private to
  the current user.
- There is no hard-delete command: done and removed notes remain recoverable.
- A pasted image typically adds 50–300 KB. An image that no task text or Electron
  draft uses is deleted, so history may refer to deleted images. The file only
  shrinks after SQLite `VACUUM`.
- Data stays local: no network calls or telemetry. The database and exports are
  **not encrypted**, and notifications may remain in Dunst's history, so avoid
  secrets in notes.
- Uninstalling the tool does not delete data.

**Backup:** close Electron, stop running `note` commands, then copy `notes.db`
plus the `electron/` directory beside it. Never copy a live database mid-write.
Restore while pinote is stopped.

Keep personal data out of Git. The checkout ignores `exports/`, `backups/`,
databases, draft caches, logs, local `MEMORY.md`/`REMINDER.md`, environment files
and key files; inspect staged files before publishing anything else.

### Upgrading for scheduled reminders

Back up `notes.db` first, then update every installation that opens the database
(Electron and the CLI used by Pi) together, and restart Electron.

- `note` versions before 0.25.0 cannot read schema 8.
- Since 0.28.0 the write lock no longer uses `flock` and does not exclude older
  versions; do not mix them.
- The first database open upgrades schema 1–7 to **8** atomically, keeping note
  IDs, timestamps, tags, reminders, history, and import markers. Tasks from
  schema 1 or 2 start untagged.
- Edits and tag changes keep the task ID and record old/new values in history.

`pinote-gui` and the Python `note` CLI are no longer provided. An installed Python
`note` still works with the schema-8 database but receives no updates: run
`npm install -g ./backend` after building, then check that `note` resolves to the
Node CLI. Electron does not read GTK's unsaved input or edit drafts
(`gui-draft.txt`, `gui-edit-drafts/` beside `notes.db`); save unfinished edits
before upgrading, or copy their text from those files.
