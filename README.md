# pinote

Pinned desktop reminders with a small `note` CLI, stable IDs, and durable history.
Linux/i3 and Dunst first. No Python runtime dependencies, custom GUI, or background
Python service. The desktop display is a persistent notification, not a draggable
sticky-note window.

## Install

Requires **Python 3.11+** and Dunst (`dunstify`) for desktop notifications.
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
The package has no Python runtime dependencies; `uv_build` is a build-time
backend that pip installs automatically in an isolated build environment.
The uv CLI is optional for users and recommended for the development workflow
below. The package does not change your shell, desktop configuration, or
existing reminders. After local source changes, reinstall with your chosen
installer (for uv: `uv tool install --force .`).

## Use

```sh
note "check backups"     # Add, save, then refresh/reopen the desktop reminder
note                     # List active notes in the terminal
note done 2              # Complete note 2
note rm 3                # Archive note 3; never erase it
note restore 3           # Make a done/removed note active again
note history             # All timestamped events, oldest first (UTC)
note history 3           # Activity for one note
note list --all          # Include done and removed notes
note show                # Show/reopen the persistent desktop notification
note --no-notify "later" # Save without refreshing the desktop
note export              # Active notes as Markdown on stdout
note export --all        # Active and done notes; removed notes remain in the DB
```

IDs are permanent, never renumbered or reused. Repeating a transition to the
current state is a harmless no-op, not another history event. Restore a removed
note before marking it done. Removing a completed note is allowed.

Command names are reserved: use `note add "done"` to add the literal text `done`,
or `note add -- "--starts-with-a-dash"` for leading dashes. Quote shell
metacharacters. Notes can contain Unicode, quotes, and newlines, up to 4096
characters; empty notes and terminal control characters are rejected.

### Desktop behavior

Add, done, remove, restore, and import automatically refresh **one** persistent
Dunst notification. A dismissed notification reopens on the next mutation or
`note show`. Closing it never changes the notes. `note` by itself only lists in
the terminal. `--no-notify` suppresses automatic refresh, not an explicit `show`.

The notification previews the first 10 active notes, up to 180 characters each;
`note` always shows the full text and list. When none remain it says “No active
reminders.” Dunst's pause, fullscreen, placement, and display policies still
apply; pinote does not override your desktop preferences.

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
and `- [x]` entries import as done. Four-space-indented continuation lines belong
to the preceding note. This is a small reminder format, not a full Markdown
parser (nested lists and code blocks are not supported).

Each canonical source path is imported at most once, atomically. Re-running the
import does not duplicate notes, even if the file changes. An empty import does
not mark the source as imported. A copy at another path is a separate source.
SQLite becomes the source of truth; editing the old Markdown file does not
change pinote. Export is a readable snapshot, **not** a backup of IDs/history.

## Desktop login

After installation and import, replace any old reminder startup command with:

```i3
exec --no-startup-id /home/your-user/.local/bin/note show
```

Use the actual absolute path from `command -v note`. Choose either pinote or the
old reminder startup, not both. This package does not edit i3 configuration.

## Data, privacy, and backup

- Notes/history: `$XDG_DATA_HOME/pinote/notes.db`
  (default `~/.local/share/pinote/notes.db`).
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

For a complete backup, stop running `note` commands and copy `notes.db`; restore
it while no commands are running. Do not copy a live database mid-write. Keep
personal data and exports out of Git. If storing copies inside a checkout, use
its ignored `exports/` and `backups/` directories. Databases, logs, local
`MEMORY.md`/`REMINDER.md`, environment files, and key files are also ignored.
Arbitrarily named exports elsewhere are not automatically protected; inspect
staged files before publishing. Uninstalling the tool does not delete data.

## Development and tests

```sh
uv sync --locked
uv run ruff check .
uv run pytest -m 'not gui'
xvfb-run -a dbus-run-session -- uv run pytest -m gui --run-gui
uv build
```

GUI tests require `dunst`, `dunstify`, `dunstctl`, `xvfb-run`, `xauth`, and
`dbus-run-session`. Always run them under `xvfb-run` with a private D-Bus session;
the tests refuse to use an existing desktop daemon. All tests use temporary
storage. CI runs unit/CLI tests on Python 3.11 and 3.13 and the isolated Dunst
tests on Linux.

The package uses `src/pinote/` with `python -m pinote` support. Storage, Markdown,
notification rendering, and CLI parsing are separated for focused testing.

## License

[MIT](LICENSE).
