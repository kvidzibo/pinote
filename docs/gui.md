# GTK checklist and desktop integration

[Quickstart](../README.md) · [CLI and data](usage.md) · [GTK and desktop](gui.md) · [Development](development.md)

Run checkout-relative commands from the repository root.

Scheduling, including due-reminder bells and time-zone rules: [scheduled reminders](usage.md#scheduled-reminders).

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
uv pip install --python .venv-gui/bin/python -e '.[gui]'
.venv-gui/bin/pinote-gui
```

Without uv, install Debian's `python3-venv`, then use
`/usr/bin/python3 -m venv --system-site-packages .venv-gui` and
`.venv-gui/bin/python -m pip install -e '.[gui]'`. This is still an isolated environment;
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
As with a normal close, unfinished input is saved and restored; child windows close.
Startup diagnostics go to the private `/tmp/pinote-gui-restart-*.log` path printed
by the script; normal application logging to `app.log` is unchanged. The helper
does not reinstall packages or change desktop configuration.

### Upgrading for scheduled reminders

Update **both** the CLI and GUI installations before reopening the GUI. For the
editable setup above, update the checkout and run `uv tool install --reinstall .`
for the separately installed CLI. Back up `notes.db` first ([backup instructions](usage.md#data-privacy-and-backup)).
The first database open upgrades schema 1, 2, or 3 to **4** atomically, retaining note IDs,
timestamps, tags, history, and import markers. Existing tasks have no scheduled time;
schema 1/2 tasks start untagged. Older pinote versions cannot read schema 4.
Edits and tag changes retain the task ID and record old/new values in history;
`note history ID` shows them. Historical text is preserved, not replaced when a task is edited.

### Behavior

- Compact, borderless dark popup: 420 px wide, 9 pt monospace text, no title/header
  bar, and one checkbox/text row per note—no trash button. Only reminder bells have
  tooltips (for example, **Due 2 hours ago**). The bottom edge stays fixed while the window grows
  upward as notes are added and shrinks as they are removed. The visible-note limit is
  configurable (default **10**); extra notes scroll. In-progress tasks have a separate
  pinned section just above the input, so scrolling ordinary tasks never hides them.
  Each scrollbar has its own space, with a gap beside the row icons.
- Add using the bottom **Add a task…** field: press **Enter** or click **+**.
  **Shift+Enter** inserts a newline; pasting preserves newlines. The editor grows
  to a few lines, then scrolls. It keeps its expanded height while you edit, including
  when you shorten or replace text, and collapses when the draft is cleared (including
  after a successful save). Unfinished input is cached locally as you type and
  restored on reopening, including newlines and whitespace. Closing flushes the
  latest draft after any submitted save finishes. Clearing the field or successfully
  adding that draft removes its cache; newer edits made while saving are kept.
  **Tab** moves focus to the controls.
  Failed saves keep your input. Successful saves clear only the submitted draft;
  edits made while saving stay in the field. The list scrolls to the newly saved
  task once it loads. List-refresh errors do not undo a saved task.
- Shows each matching active note's **first line**, with literal text and wrapping for
  long first lines. Multiline notes have an **eye/preview button** on the right;
  single-line notes do not. Preview opens a scrollable, read-only popup with the
  full text with basic Markdown: headings, bold/italic, lists, quotes, inline/fenced
  code, and web/email links. Line breaks and blank lines are retained. Select text
  and press **Ctrl+C** to copy the displayed text. Editing and list rows stay literal.
  HTML stays literal, images show alt text without loading, and only explicit
  HTTP/HTTPS/mailto links can open external applications. There is no syntax highlighting.
  **Esc** or clicking outside dismisses the preview without closing the checklist.
  Preview never changes the task or its history; it closes if the task leaves the list.
  Set `markdown_preview = false` below to restore the original plain-text preview.
  Markdown uses the optional `gui` install extra; without its parser, previews stay plain text.
- Right-clicking note text outlines that row while its context menu or tag submenu
  is open. Dismissing the menu clears the outline without changing the task's state.
- **Right-click note text → Edit…** opens a full multiline editor. Click **Save**
  or press **Ctrl+Enter** to save; **Enter** inserts a newline. **Cancel** or **Esc**
  discards unsaved edits. Editing keeps the task's ID, tag, and progress state.
  Failed saves keep the editor's input; a task changed elsewhere cannot be overwritten
  by a stale editor. Unsaved edits are not cached like the new-task draft.
- **Right-click note text → Tag →** choose a tag, **New tag…**, or **Untagged** to
  clear it. Each task has at most one tag. Names are case-sensitive, trimmed, Unicode
  normalized, and limited to 64 characters on one line. Tags in use on active,
  scheduled, or archived tasks are available for reuse; there is no separate tag registry.
  Both tag menus show active-note counts, including in-progress tasks, for example
  **#Work (3)**. Counts cover all active tasks regardless of the current filter;
  scheduled-only and archived-only tags show **(0)**. Counts use the latest loaded list.
- **Bottom menu → Filter by tag →** selects **Untagged**, **All**, or a named tag.
  **Untagged is the default every time the checklist reopens.** Filtering only hides
  rows; it never archives or changes tasks. Assigning a different tag can immediately
  hide a task from the current view. New tasks added under a named filter inherit that
  tag; under All/Untagged they are untagged. The new-task draft is kept when switching
  filters. Archive and CLI/Dunst listings remain unfiltered, and restored tasks retain
  their tags, so they may be hidden by the checklist's current filter.
- Left-click note text or empty space in the checklist to focus **Add a task…**.
  Drag to select text: releasing the mouse copies the selection to the clipboard,
  then focuses the input. A plain click leaves the clipboard unchanged. Buttons,
  scrollbars, and editing/selecting text inside the input keep their normal behavior.
- The checkbox has three states: **Empty**, **In progress** (amber dash), and
  **Marked for deletion** (red dash):

  | State | Left-click | Right-click |
  | --- | --- | --- |
  | Empty | Start → In progress | Mark for deletion |
  | In progress | Complete | Reset → Empty |
  | Marked for deletion | Cancel → Empty | Delete |

  Progress survives restarts. Clicking task text still focuses the input.
- Newly started tasks stay in place until focus leaves pinote, then move into the
  pinned in-progress section. Moving focus into pinote's menus, previews, or other
  windows does not trigger the move. Already-started tasks open in the pinned section.
  Both sections retain creation order: new tasks append to the ordinary section,
  **above** in-progress tasks; clearing progress returns a task to its original place.
  Tag filters apply to both sections. Marking for deletion does not change ordering.
  Large in-progress sets scroll independently within their own height limit.
- Marking for deletion alone saves nothing; the mark survives unchanged refreshes
  but clears when the task changes elsewhere or the checklist closes. Cancelling
  the mark leaves the checkbox empty, never in progress. Failed deletions keep the
  mark so you can retry or cancel.
- Neither completion nor deletion erases history. Deleted tasks remain recoverable
  in **Archive…**. Find IDs with `note list --all`; use `note restore ID` to recover
  a task or clear progress, and `note history ID` to inspect its events. Failed
  start/reset/complete saves restore the last saved checkbox state. Screen-reader names
  and descriptions identify the checkbox's actions and note ID.
- The bottom **menu** beside **+** contains **Filter by tag**, **Reminders…**,
  **Archive…**, and **Close**. There is no Undo button. **Archive…** opens a separate, resizable,
  titlebar-free window.
  It lists all currently completed/deleted tasks, newest first, including previous
  sessions and CLI changes. Each row shows its full text, **Completed** or **Deleted**,
  the recorded date/time in your local timezone, and a **Restore** button.
  Imported completed tasks use their import date because the original completion
  date is unknown. Opening Archive again presents the same archive window.
  Its in-window **Close** button and **Esc** still close it.
- **Restore** returns that task to the active list, unchecked, just like
  `note restore ID`. It preserves the ID and history and removes the task from the
  archive. Failed saves can be retried; stale restore buttons cannot overwrite
  a task changed elsewhere. All lists refresh CLI changes about once per second.
  Closing the archive or reminders list leaves the checklist open; closing the checklist
  closes all its windows, after finishing any already-submitted save.
- After a successful click, **Done** holds its green check/highlight for 200 ms,
  then fades and collapses over 200 ms. Confirmed deletion fades/collapses over 200 ms.
  Saving happens first, and other rows remain usable during the animation.
  GTK's disabled-animation preference skips the effect. CLI-only changes refresh
  without animation. A refresh that restores a row cancels its exit animation.
- Close with **menu → Close**, **Esc**, or the window manager. This only closes
  the window; it does not mark notes done. Unsubmitted input returns on reopening
  without becoming a task.
  With the menu or a preview open, **Esc** dismisses it instead of closing the checklist.
- Notices CLI changes about once per second. Unchanged rows are retained so
  polling does not reset text selection or scrolling. Background additions do not
  scroll the list; only a successful add from the GUI does.
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
of keyboard focus. Wrapped first lines, multiline input, and error notices grow
upward; the list scrolls earlier if needed to keep the input and controls on-screen. Manual moves establish
a new bottom anchor for that instance and survive remapping/reactivation. Reopening
after closing restores the default placement. The window manager has the final say
(Wayland may ignore positioning).

### GUI configuration

Read from `$XDG_CONFIG_HOME/pinote/config.toml` (default
`~/.config/pinote/config.toml`):

```toml
[gui]
max_visible_notes = 10
markdown_preview = true
```

The limit must be a positive integer. Both sections share this visible-row budget,
with at least one row per nonempty section. While ordinary tasks remain, in-progress
rows use up to half the budget and half the available list height; the ordinary
section gets the remaining row budget. With only in-progress tasks, their section
can use the whole budget. Wrapped lines and available screen space also constrain
height; all matching tasks remain accessible through each section's scrollbar.
An empty view stays compact. `markdown_preview` must be a boolean; set it to `false`
to disable formatting without changing or converting any notes.
Missing configuration uses the defaults;
invalid configuration reports an error without changing notes. The GUI never
creates or overwrites this file. **Close and reopen the GUI** after changing it.

### i3 setup

For i3, put this rule **after** any general floating-window border rules so they
cannot restore the titlebar. It covers the checklist, Edit, New tag, Set reminder,
Reminders, and Archive windows; replace any older rule matching only `^pinote-reminders$`.

```i3
for_window [window_role="^pinote-"] floating enable, border none
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

## Desktop login

For the GTK checklist, use the startup command in [i3 setup](#i3-setup).
For a Dunst notification instead, replace any old reminder startup command with:

```i3
exec --no-startup-id /home/your-user/.local/bin/note show
```

Use the actual absolute path from `command -v note`. Choose either pinote or the
old reminder startup, not both. This package does not edit i3 configuration.
