# pinote

Pinned desktop reminders with a small `note` CLI, stable IDs, and durable history.
Linux/i3 first. The CLI has no Python runtime dependencies or background service.
Choose a persistent Dunst notification or the optional `pinote-gui` GTK checklist
with an inline task entry, completion checkboxes, remove controls, and an archive.
The GUI is a separate process, not a daemon.

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
The optional GUI additionally needs GTK 3 and its Python bindings; see below.
The uv CLI is optional for users and recommended for the development workflow
below. The package does not change your shell, desktop configuration, or
existing reminders. After local source changes, reinstall with your chosen
installer (for uv: `uv tool install --reinstall .` to rebuild the local source).

## Use

```sh
note "check backups"     # Add, save, then refresh/reopen the desktop reminder
note                     # List active notes in the terminal
note done 2              # Complete note 2
note rm 3                # Archive note 3; never erase it
note restore 3           # Reactivate a note, or clear its in-progress status
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
In-progress tasks remain in the active list, marked **[in progress]** in terminal
and notification output. `note done ID` still completes a task directly;
`note restore ID` also clears progress without completing it.

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
reminders.” Note text is rendered literally, including markup and backslash
escape sequences. Dunst's pause, fullscreen, placement, and display policies
still apply; pinote does not override your desktop preferences.

Data is committed **before** notification delivery. If Dunst is missing or
unavailable, mutations still succeed (exit 0) with a warning. `note show` returns
1 on notification failure. Validation/storage errors return 1; CLI syntax errors
return 2. Do not repeat an add just because desktop delivery failed.

## Optional GTK checklist

`pinote-gui` is a separate frontend inside the same package. It uses the same
SQLite database, stable IDs, history, and mutation lock as `note`. The CLI never
imports GTK, and Dunst does not need to be installed or running for the GUI.

### Debian installation, isolated from the CLI

GTK's Python bindings must match the interpreter. Keep the existing CLI
installation and create a second virtualenv using **Debian's `/usr/bin/python3`**
with access to Debian's GTK packages. A uv-managed Python cannot automatically
use those system bindings.

From this checkout:

```sh
# If these Debian packages are not already installed:
sudo apt install python3-gi gir1.2-gtk-3.0

uv venv --python /usr/bin/python3 --system-site-packages .venv-gui
uv pip install --python .venv-gui/bin/python -e .
.venv-gui/bin/pinote-gui
```

Without uv, install Debian's `python3-venv`, then use
`/usr/bin/python3 -m venv --system-site-packages .venv-gui` and
`.venv-gui/bin/python -m pip install -e .`. This is still an isolated environment;
it reads system GTK libraries but installs pinote locally, not into system Python.
Both environments use the same source code, not separate copies of the project.

Use the **GUI environment's** executable, not a `pinote-gui` installed alongside
a dependency-free `uv tool`/pipx CLI. `python -m pinote.gui` also works in that
environment. A graphical session and session D-Bus are required. Help/version
work without GTK or a desktop. Nothing changes your i3 configuration or startup.

### Restart after local changes (i3/X11)

```sh
./scripts/restart-pinote.sh
```

Use this helper after changing the GUI instead of writing a one-off restart command.
It works from any directory when invoked by its full path, uses this checkout's
`.venv-gui`, and requires `i3-msg` and `xdotool`. It gracefully closes a matching
running GUI, waits for submitted saves, then reopens it with its original environment
and workspace—even on a hidden workspace. If the GUI is stopped, it stays stopped.
Ambiguous instances and concurrent restarts are refused; it never force-kills a GUI.
As with a normal close, unsubmitted input is lost and the archive window closes.
Startup diagnostics go to the private `/tmp/pinote-gui-restart-*.log` path printed
by the script; normal application logging to `app.log` is unchanged. The helper
does not reinstall packages or change desktop configuration.

### Upgrading for progress support

Update **both** the CLI and GUI installations before reopening the GUI. For the
editable setup above, update the checkout and run `uv tool install --reinstall .`
for the separately installed CLI. Back up `notes.db` first (see below).
The first database open upgrades schema 1 to 2 atomically, retaining note IDs,
timestamps, history, and import markers. Older pinote versions cannot read schema 2.

### Behavior

- Compact, borderless dark popup: 420 px wide, 9 pt monospace text, no title/header
  bar, no tooltips, and one checkbox/text/trash row per note. Its bottom edge stays
  fixed while it grows upward as notes are added and shrinks as they are removed.
  The visible-note limit is configurable (default **10**); extra notes scroll.
- Add using the bottom **Add a task…** field: press **Enter** or click **+**.
  Failed saves keep your input. Successful saves clear only the submitted draft;
  edits made while saving stay in the field. List-refresh errors do not undo a
  saved task.
- Shows every active note, with full literal text and wrapping.
- Left-click note text or empty space in the popup to focus **Add a task…**.
  Drag to select text: releasing the mouse copies the selection to the clipboard,
  then focuses the input. A plain click leaves the clipboard unchanged. Buttons,
  scrollbars, and editing/selecting text inside the input keep their normal behavior.
- **Left-click the checkbox** to start a task: an amber row and a dash in the
  checkbox mean **In progress**. Left-click that checkbox again to **complete** it.
  **Right-click the checkbox** to clear progress without completing or removing it;
  right-clicking a task that has not started does nothing. Progress survives restarts.
  Clicking task text still focuses the input, even on an in-progress task.
- The **trash icon** archives a task, including one in progress. Neither completion
  nor removal erases history. Find IDs with `note list --all`; use `note restore ID`
  to recover a task or clear progress, and `note history ID` to inspect its
  `start`/`reset`/completion events. Failed saves restore the last saved checkbox
  state. Screen-reader names identify the checkbox's next action and note ID.
- The bottom **menu** beside **+** contains **Archive…** and **Close**. There is
  no Undo button. **Archive…** opens a separate, resizable, titlebar-free window.
  It lists all currently completed/deleted tasks, newest first, including previous
  sessions and CLI changes. Each row shows its full text, **Completed** or **Deleted**,
  the recorded date/time in your local timezone, and a **Restore** button.
  Imported completed tasks use their import date because the original completion
  date is unknown. Opening Archive again presents the same archive window.
  Its in-window **Close** button and **Esc** still close it.
- **Restore** returns that task to the active list, unchecked, just like
  `note restore ID`. It preserves the ID and history and removes the task from the
  archive. Failed saves can be retried; stale restore buttons cannot overwrite
  a task changed elsewhere. Both windows refresh CLI changes about once per second.
  Closing the archive leaves the checklist open; closing the checklist closes both
  windows, after finishing any already-submitted save.
- After a successful click, **Done** holds its green check/highlight for 200 ms,
  then fades and collapses over 200 ms. **Remove** keeps its 200 ms fade/collapse.
  Saving happens first, and other rows remain usable during the animation.
  GTK's disabled-animation preference skips the effect. CLI-only changes refresh
  without animation. A refresh that restores a row cancels its exit animation.
- Close with **menu → Close**, **Esc**, or the window manager. This only closes
  the window; it does not mark notes done. Unsubmitted input is not saved.
  With the menu open, **Esc** dismisses the menu instead of closing the checklist.
- Notices CLI changes about once per second. Unchanged rows are retained so
  polling does not reset text selection or scrolling.
- GUI saves use the existing lock and store off the GTK event thread.
  Busy/storage errors appear in the window and `app.log`; check `note` before
  retrying. Stale buttons cannot archive an already-completed note, complete a task
  whose progress was cleared, or restart a completed task.
- Launching it again presents the existing window for the same database.
  Closing the window exits the GUI after any already-submitted operation finishes;
  closing itself never changes notes.
- **GUI changes do not send or close Dunst notifications.** CLI notification
  behavior is unchanged. For GUI-only reminders, add tasks in the window or use
  `note --no-notify "text"` and `note done ID --no-notify`. An existing Dunst
  reminder does not follow GUI changes; use `note show` to refresh it, or dismiss
  it and use the checklist.

The window requests floating/keep-above behavior at **x=25**, with its bottom edge
**25 px above the monitor's usable bottom edge**. It keeps the original monitor
choice: the monitor containing (or nearest to) desktop point `(25, 1300)`, independent
of keyboard focus. Wrapped notes and error notices grow upward; the list scrolls
earlier if needed to keep the input and controls on-screen. Manual moves establish
a new bottom anchor for that instance and survive remapping/reactivation. Reopening
after closing restores the default placement. The window manager has the final say
(Wayland may ignore positioning).

### GUI configuration

Read from `$XDG_CONFIG_HOME/pinote/config.toml` (default
`~/.config/pinote/config.toml`):

```toml
[gui]
max_visible_notes = 10
```

The limit must be a positive integer. The viewport fits the first N wrapped note
rows, capped by available screen space; all remaining notes stay accessible by
scrolling. An empty list stays compact. Missing configuration uses the defaults;
invalid configuration reports an error without changing notes. The GUI never
creates or overwrites this file. **Close and reopen the GUI** after changing it.

### i3 setup

For i3, put this rule **after** any general floating-window border rules so they
cannot restore the titlebar:

```i3
for_window [window_role="^pinote-reminders$"] floating enable, border none
```

To start the checklist at desktop login after boot, replace the old reminder's
startup command (`note show` or `login-reminder.sh`) with the absolute checkout
path, keeping only one reminder launcher:

```i3
exec --no-startup-id /home/your-user/AI/pinote/.venv-gui/bin/pinote-gui
```

Use `exec`, not `exec_always`, to avoid relaunching it on i3 restarts. Reload i3
after editing its configuration; the startup command runs at the next login.
Setup is manual; installing pinote never edits desktop rules.
The bundled `src/pinote/gui/style.css` uses a Dunst-inspired palette (`#232832`
background, `#f3f5f8` text, `#4b5563` frame), 6 px corners, and Hack Nerd Font Mono
with a monospace fallback. The window requests 96% opacity; transparency needs a
compositor. These are bundled defaults, not a live import of Dunst configuration.
Restart the GUI after editing the stylesheet in an editable checkout.

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
change pinote. Export is a readable snapshot, **not** a backup of IDs/history.

## Desktop login

For the GTK checklist, use the startup command in **Optional GTK checklist** above.
For a Dunst notification instead, replace any old reminder startup command with:

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
uv run ruff check . && uv run ruff format --check .
uv run pytest -m 'not gui'
xvfb-run -a dbus-run-session -- uv run pytest -m 'gui and not gtk' --run-gui
uv build
```

Dunst tests require `dunst`, `dunstify`, `dunstctl`, `xvfb-run`, `xauth`, and
`dbus-run-session`. GTK tests additionally require `xdotool` and the GUI environment
above. Install `i3-wm` for the optional placement/resize regression; it starts a
private i3 with its own IPC socket inside Xvfb, never using your desktop's socket
or configuration. The restart-helper regression also uses that isolated setup to
check hidden-workspace recovery, environment preservation, and stopped GUIs.
Install development tools into the GUI environment and run its
interpreter directly (plain `uv run` would select the separate CLI environment):

```sh
uv pip install --python .venv-gui/bin/python -e . --group dev
xvfb-run -a -s '-screen 0 2560x1440x24' dbus-run-session -- .venv-gui/bin/python -m pytest -m gtk --run-gui
# Also cover placement on smaller displays:
xvfb-run -a dbus-run-session -- .venv-gui/bin/python -m pytest tests/test_gtk.py -k 'compact_ or i3_honors or single_instance_reopen or error_notice_keeps or manual_position' --run-gui
```

Always run GUI tests under `xvfb-run` with a private D-Bus session; the tests refuse
to use the real desktop. All tests use temporary storage. CI runs unit/CLI tests
on Python 3.11 and 3.13, isolated Dunst tests, and a separate system-Python GTK job
against the built wheel (including its bundled stylesheet and isolated i3 placement).

The package uses `src/pinote/` with `python -m pinote` support. Storage, Markdown,
notification rendering, and CLI parsing are separated for focused testing.
`gui/` contains the optional presentation and a GTK-free data adapter; GTK is
loaded only when launching the GUI. Schema upgrades run transactionally in the
shared store, so both frontends use the same progress states and history.

## License

[MIT](LICENSE).
