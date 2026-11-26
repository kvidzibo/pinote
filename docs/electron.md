# Electron desktop frontend

[Quickstart](../README.md) · [CLI and data](usage.md) · [Electron](electron.md) · [Development](development.md)

Electron is Pinote's desktop frontend. It uses the Node backend; Python is not
required. Only Linux/X11/i3 is a validation target; local validation is not a
performance guarantee. [macOS](#macos-experimental) support is experimental.

## Install and launch from a checkout

Requires Node.js **22.19.0+**, npm, Linux `flock` (util-linux), GNU `/usr/bin/date`
for local reminders, and Electron's desktop runtime libraries, including GTK 3 (`libgtk-3`).
The private `electron/` package (0.23.0) bundles the matching Node backend;
editor autosave does not require Python.
Run from the repository root:

```sh
npm --prefix electron ci --ignore-scripts
npm --prefix electron run setup
npm --prefix electron start
```

`setup` installs the locked backend and `pi/` watcher build dependencies, builds
the backend bundles, and explicitly downloads the locked Electron 45 binary;
there is no Electron postinstall download in this version. Dependencies have
their own `electron/package-lock.json`. `start` rebuilds before launching.
See [Electron tests](development.md#electron-frontend) for development checks;
they are not required to launch.
The build includes the backend bundle. At runtime it uses external `node` from
absolute PATH directories, or a **trusted absolute Node executable** in `PINOTE_NODE`.
Relative PATH entries are ignored; unsupported Node versions fail at startup.
Node/Electron injection environment flags are cleared in backend children.
`PINOTE_ELECTRON_BACKEND` remains an explicit trusted absolute executable override
for compatibility and diagnostics; there is no automatic Python fallback.
Installation does not change desktop login startup, i3 rules, or user configuration.

### macOS (experimental)

Install Homebrew `flock` (`brew install flock`) and start Pinote from a terminal
with the commands above, so `PATH` contains `node` and `flock`. Reminders need GNU
`/usr/bin/date` and are unavailable. Only Start in Kitty has macOS-specific
handling; macOS is not a validation target.

## Field watchers

Electron 0.15.0+ runs [field watchers](../pi/FIELD_EVENTS.md) for exactly as long
as the desktop is open; it no longer hosts an HTTP service. Pi sessions read tasks
directly and pick up watcher results and alerts from the shared watcher state.
Closing Electron stops running watchers; tasks changed meanwhile are picked up
from the database on the next start.

Watchers use the desktop's environment: `PINOTE_NOTE_COMMAND` (default `note` on
`PATH`; it must use the desktop's database) and any tokens they need. Start and
stop lines are written to the desktop's `app.log`; failed checks are detailed in
`watchers.log` beside the watcher state. If watchers cannot start, the reason is
logged and the desktop stays usable.

A standalone `pinote.service` from earlier versions is no longer used. Since
Electron 0.16.0 the [backend switch](#switch-an-existing-installation) neither
inspects nor changes that unit. If a switch started by an earlier version is
still pending, first let that version finish its recovery. Then stop and disable
the unit and remove its leftover `pinote.service.d/90-node-backend.conf` drop-in.

Since Electron 0.19.0, **Menu → Watchers…** edits them: add a script, choose
the task and field events it listens for, name its fields and fill in the
[parameters it declares](../pi/FIELD_EVENTS.md#watcher-settings). Saving asks for
confirmation, naming each enabled script and Forgejo instance, and applies to the
next check. Settings that differ from a script's defaults need pi-note 0.48.0+ in Pi. The bundled **Worktree cleanup**
watcher removes a completed task's clean Git worktree. Task events need the Node
`note` 0.27.0+ CLI; with an older one they are skipped and field watchers keep running.

Watchers can also be enabled in Pi's `/pinote` settings, which list the pi-note package's
own `watchers/` as **Bundled**; the desktop lists its own copies as **Bundled**,
hides one when a saved entry is a copy of it, and runs whichever executable path is
saved. Entries saved by Electron 0.14 point at the copies inside the application:
they keep running with the same grouped PR alerts and are listed as **Custom**.
After switching entries, still failing checks can alert once more. With more
than 30 stored watchers, first remove unused paths from `pi-note.json` (keep a
backup): the two package entries would exceed the 32-watcher limit and stop
watchers loading.

The window is a compact, always-on-top utility window. Its utility type is the
intended automatic-floating mechanism in i3, without additional rules. Although
`start` requests `--class=pinote-electron`, native development `WM_CLASS` can be
`electron`; do not rely on that requested class as an observed window identity.
Icons are bundled rather than taken from the host icon theme.

## Switch an existing installation

After updating/building this Electron version, open **Menu (cog) → Switch to Node backend…**
and use **Switch to Node backend** (play icon). The menu item is hidden once
the desktop uses Node and the matching user CLI is installed. A native confirmation defaults to
Cancel. The operation saves pending edits and drafts, verifies external Node and
the bundled CLI/bridge against the same database, then:

- Backs up SQLite, Electron drafts/geometry, and the replaced configuration.
- Replaces `~/.local/bin/note` with a launcher for this application's bundled CLI.
  An existing command is first checked to use the same database. Standard
  direct-Python uv and pip/pipx entry points are recognized when their shebang
  selects a trusted native Python installation. Interpreter shims, shell wrappers
  (including long-shebang shims), and runtime injection require a manual switch:
  `LD_PRELOAD` and other `LD_*` loader settings, `PYTHON*`, `NODE_OPTIONS`,
  `GCONV_PATH` or `GLIBC_TUNABLES` in the desktop environment block this check,
  and the error names the variable. `LD_LIBRARY_PATH` (for example from a CUDA
  profile) and other `NODE_*` or `ELECTRON_*` settings do not.
  Launcher checks do not authenticate Python installations or their installed
  packages. PATH must contain only absolute entries and resolve `flock` to the
  system utility. PATH entries and home/XDG paths used for switching must not
  contain `..`; HOME must be absolute. Startup also rejects parent components in
  HOME, XDG_CONFIG_HOME and XDG_STATE_HOME before reading preferences or recovery
  data.
- Saves an explicit Node preference and relaunches Electron.

No downloads, administrator access, model requests or database conversion occur
when clicking Switch. Normal desktop updates must first install this app version;
its `setup` now also prepares the backend for the existing desktop updater.
Keep the installed application's directory stable: the CLI launcher follows its
bundled resources, so subsequent updates replace both runtimes together.
**Refresh backend settings** checks the saved desktop preference and the installed
user CLI.

The preference lives in `$XDG_CONFIG_HOME/pinote/backend.json` (default
`~/.config/pinote/backend.json`). It overrides only the exact backend override
replaced during confirmation, including the old Python-forcing desktop launcher;
a different explicit diagnostic override still works.

Backups and interrupted-switch recovery are under
`$XDG_STATE_HOME/pinote/backend-switch` (default `~/.local/state/pinote/backend-switch`).
On failure, rollback restores configuration. Task data is **never** automatically
restored or converted. Interrupted rollback is recovered on the next launch; one
started by Electron 0.15 or earlier with a `pinote.service` present must be
finished with that version. Concurrent configuration edits are not overwritten:
if recovery cannot finish, preserve `pending.json` and the private backups for repair.
Original configuration inodes are also kept beside their paths as hidden
`.NAME.pinote-switch-*.previous` files; interrupted rollback can retain matching
`.rollback` files. Do not delete these while reconciling a concurrent editor's changes.
Deleted targets are not recreated. If a previously existing target disappears
after publication intent, recovery stops for manual repair rather than guessing.
An originally absent target that is absent again already matches its backup;
rollback leaves it absent without requiring repair.
A busy updater, unsafe paths, or an existing CLI on a different database blocks
the switch rather than guessing.

## Controls

Task rows stay single-line and compact. Subtle separators span the text/tag area;
a light hover highlight follows the whole row without moving it or replacing
progress, deletion-mark, or keyboard-focus styling. Row action order is unchanged.

- Add with **Enter**; **Shift+Enter** inserts a newline. The composer grows
  and shrinks with its text, with a roomier minimum input height. Ordinary tasks
  use the available window height;
  in-progress tasks size to their contents above the composer (up to half the
  list when ordinary tasks are present) and scroll separately when needed.
  Window size, position, collapsed state, and list scroll positions survive restarts.
- Composer and task editors show live Markdown **source** styling for headings,
  bold, italic and code. Markers stay visible; load, paste, save and copy preserve
  source. On the first explicit newline after a plain single-line task, it becomes
  `# Task` followed by `- `. Newlines after headings and bullets continue `- `;
  an empty bullet ends the list. **Tab** on a `-` bullet indents it by two spaces.
  **Backspace** at the start of its text removes one indentation level; at the
  top level it removes the bullet prefix. Elsewhere Backspace deletes normally.
  **Shift+Tab**, or Tab on a non-bullet line, moves focus between controls.
  Compact row/archive titles omit a leading heading marker, not stored text.
- **Menu → New task editor… → Start as Markdown** starts new drafts with `# `
  and live heading formatting. It defaults off, preserving the current behavior.
  Existing draft text is not rewritten; the preference survives restarts.
- Click a task's play icon to start it, then its checkmark to complete it.
  Right-click task text, use its actions button, or focus task text and press
  **Shift+F10** or the **Menu** key to open an inline icon toolbar in the same
  row height. Actions include **Start/Reset**, **Complete**, archive, **Start in
  Kitty…**, **Copy**, **Edit**, **Reminder**, and **Tag**. Only one toolbar opens
  at a time. Use arrow keys or **Home/End** to navigate and **Enter/Space** to
  activate. **Close**, **Escape**, or clicking outside restores the task text;
  **Tab** out also dismisses the toolbar without closing Pinote.
  Right-click an in-progress task's checkmark to reset progress.
  State styling and controls update immediately, but existing rows keep their
  order and section while the pointer is inside the window. Moving to another
  row or losing keyboard focus does not release them; leaving the window does.
  Completed, archived, and filtered-out tasks still disappear normally.
- **Menu → Task actions…** configures the entire task row, separately for
  **Not started**, **In progress**, and **Marked for deletion** tasks.
  Drag row elements or focus a handle and use **↑/↓**; the list's top-to-bottom
  order becomes the row's left-to-right order, shown in a live preview.
  **Tag** and **Task text** are required but movable; untagged tasks show
  **Untagged**. Other elements, including **Preview** and **Actions**, can be
  removed or placed on either side of the text. Each existing action can appear
  once in the row; custom actions are not supported.
- **Add actions / configure menu** adds row buttons and independently controls
  action-menu order and **In menu** visibility. Drag its handles or use **↑/↓**
  to reorder menu actions. The row can contain actions hidden from the menu.
  On narrow rows, text shortens first; excess buttons move under **Actions**,
  even if hidden from the regular menu. An overflow Actions button appears when
  needed if you removed it. Right-click task text still opens the menu.
  Reminder timing remains in the task-text tooltip and the configured reminder
  button's tooltip; no extra reminder button is inserted outside your layout.
- Use **←/→** or **Home/End** to switch focused state tabs. Default rows begin
  with **Start**, **Complete**, or **Cancel deletion mark** (safe undo), followed
  by tag, text, Preview, and Actions. Right-click a row action (other than Preview)
  to mark an unstarted task, reset progress, or delete a marked task.
  **Save** applies all tabs, including to existing tasks. **Escape/Close** on
  the main settings dialog discards changes; closing the action picker returns
  to the unsaved layout. **Restore defaults** resets only the selected tab.
  Editing settings and the preview never runs an action. Older shared or
  per-state settings migrate their button choices, menu order, and visibility;
  shared Start→Complete behavior and safe marked-task undo are preserved.
  These preferences affect Electron only.
- The task editor fills the available window with one Markdown source area.
  Text **autosaves after a 650 ms typing pause**; the footer shows unsaved,
  saving, saved, or paused status. **Ctrl+Enter** saves immediately and closes
  after success. **Escape/Close** dismisses the editor while its pending save
  finishes; closing the app also drains pending edits before exiting.
- The editor's header **tag button** opens the searchable tag picker. Choose,
  create, or clear a tag without leaving the editor; selection saves immediately,
  serialized with pending text edits. Creating a tag commits its folder and task
  assignment together, even when closing during the save. **Undo** (or **Ctrl+Z**)
  reverts text edits within the open editor and autosaves the result; it does not
  undo tag changes.
  Copy remains available when saving is paused.
- Below the text, **Agent fields** lists the task's saved handoff fields plus
  those configured in Pi's field settings (`pi-note.json`), even when unset or
  disabled. Edits autosave like text, one revision-bound write at a time;
  clearing a value removes the field. History records them as agent-field
  changes, but your own edit does not mark the task as an unread agent update.
- Local text and pending tag selections (including new-tag folders and tag
  clears) are cached before each write. Failed saves pause autosave and offer
  an explicit retry; unknown outcomes require the recovery acknowledgement first.
  External revision changes make the editor read-only rather than overwriting
  another client's work. Close and use **Menu → Recover edit drafts…**
  to copy/discard stale text, then reopen the latest task to reconcile it.
  Recovered drafts show any pending tag and agent field values and never autosave merely because they
  are opened: review and explicitly retry both text and tag changes. Opening an
  editor does not create a write or history entry.
- Search tag selectors and filters; create/manage saved tags and optional default
  Kitty folders. Tags with the newest associated tasks appear first, followed by
  unused tags and Untagged. Use arrow keys to move through tags and **Space** to
  toggle a focused filter. The highlighted funnel indicates a tag filter is active; its
  count includes all visible tasks, including in-progress tasks that remain
  visible regardless of tag filters.
- **Menu → Manage tags…** opens a searchable saved-tag list beside a separate
  editor (stacked in narrow windows). Select a tag, edit its name, and use the
  save icon to rename it across tasks. Folder icons choose or clear its default
  Kitty folder immediately. The **+** creates a tag; the separated delete icon
  asks for confirmation and keeps tasks and history. Polling preserves an
  unfinished name edit while updating the selected tag's folder.
- The bottom cog menu opens beside its button and groups scheduled reminders
  and Archive (including restore); tag management, task-action, new-task editor,
  watcher, Kitty tab, window and backend-switch settings; draft recovery; and **Quit Pinote**. Filtering
  stays on the toolbar's filter button. It remains a native popup menu, which can adjust its placement at screen edges and extend
  beyond the small window.
- The task row's eye opens a floating Markdown preview about 10 px from the
  click, including all saved agent fields, full Pi session IDs, and unread updates.
  Fields remain visible here even when disabled in Pi's field settings. Session
  IDs are recorded by the Pi integration and wrap as literal text, not Markdown.
  The preview may overlap or extend
  beyond the checklist without resizing it. Placement flips at screen edges;
  moving the pointer or receiving updates does not move the open preview.
  Keyboard activation anchors to the focused button. **Escape**, **Close**, or
  losing focus dismisses only the preview; **Edit** returns to the checklist's
  editor. Raw HTML and remote images are not loaded. Supported links
  open externally only on explicit activation.
- Editors and searchable tag pickers are scrollable in-window dialogs;
  task actions use inline toolbars and the bottom menu uses a native popup menu,
  not centered panels.
  Folder selection and recovery confirmation can also use native dialogs.
- **Set reminder…** opens a local date-time picker preset to the current minute, or
  to the existing reminder time. Daylight-saving times that are skipped or repeated
  are rejected; choose another time or use `note schedule` with an explicit offset.
  Due reminders activate on backend refresh, not through a new alarm service.
  Electron does not send Dunst notifications.

### Start in Kitty

**Start in Kitty…** uses the tag's default folder if available, or opens a directory
chooser. Cancelling changes nothing. Electron saves the task as in progress and
updates its row before launching; on failure, progress is retained. Errors name
the cause, such as a missing `kitty` or `pi` with the searched `PATH`, or Kitty's
remote-control error. If Kitty may already have opened a tab or window, the error
says the outcome is uncertain: check for a new tab or window before retrying.

The Node backend requires `kitty` and `pi` in absolute `PATH` directories. To
reuse Kitty, enable socket remote control (`allow_remote_control socket-only`)
and point `KITTY_LISTEN_ON` at its socket. Without that variable, Pinote searches
for same-user Kitty instances on the same X11 display at `unix:@mykitty-<pid>`
(`listen_on unix:@mykitty`). If the explicit address is unreachable, launch fails.
If discovery finds no reachable instance, Pinote opens a new window without
restoring saved tabs. **Menu → Kitty tabs…** sets the tab name; the default
`{tag}{title:30}` gives a `[tag] ` prefix if tagged, then the task's first line
without a leading Markdown heading marker, cut to 30 characters. `{title}` keeps
the whole line and `{id}` adds the task number; other text is literal. The name is
saved with Electron's working state, not in `pi-note.json`. Saved text and tags are unchanged.

On macOS, Pinote also looks for `kitty` in `/Applications/kitty.app` and
`~/Applications/kitty.app`, for `pi` in `~/.pi/agent/bin`, and for both in
`/opt/homebrew/bin` and `/usr/local/bin`. Without `KITTY_LISTEN_ON`, it reuses
same-user Kitty sockets named `mykitty-<pid>` in the private per-user `$TMPDIR`;
configure `allow_remote_control socket-only` and `listen_on unix:mykitty`. New
windows also listen in `$TMPDIR`; a shared one, such as `/tmp`, is refused.
Pi tabs get Pinote's `PATH`, because Kitty opened from the Dock lacks `node`.

**Kitty tabs…** in the menu sets **One task per tab**, shared with Pi's settings
in `pi-note.json`. When on, selecting a task in Pi moves a split pane whose tab
already shows another task to a new tab beside it; see the
[pi-note README](../pi/README.md).

Pi needs the [pi-note extension](../pi/README.md) and a `note` CLI using the same
database. The launch passes the task ID, revision, and an optional editor draft.
Pi does not select the task if the revision no longer matches. Launching does
not submit a prompt or complete the task.

## Configuration

The Node backend reads `$XDG_CONFIG_HOME/pinote/config.toml` (default
`~/.config/pinote/config.toml`). The defaults are:

```toml
[gui]
max_visible_notes = 10
markdown_preview = true
kitty_start_prompt = "is task clear?"
```

- `max_visible_notes` is a positive integer. It caps the row count used to
  calculate the checklist's automatic height, with a cap of at least two rows.
  It does not hide tasks or override a manually sized window.
- `markdown_preview` is a boolean. Set it to `false` to show task text and agent
  field values literally in the floating preview and expanded Archive and Scheduled
  reminders entries. It does not change saved text or editor styling.
- `kitty_start_prompt` is an editable draft for an empty Pi input, not a submitted
  prompt. Set it to `""` to disable prefilling. It accepts up to 4000 characters;
  tabs and newlines are allowed, but other terminal controls are not.

Missing configuration uses the defaults. Invalid configuration reports an error;
Pinote does not create or overwrite the file.

## Shared tasks, separate UI state, and recovery

Electron, the CLI, and Pi share `notes.db` and the display lock. Electron refreshes
external changes and refuses stale saves. There is no separate desktop database
or data conversion.

Restarting restores the new-task tag (including Untagged), tag filters, composer
and private edit drafts, collapsed state, list scroll positions, saved task-action
preferences, the add-task input preference, the Kitty tab name, and agent read cursors. A deleted or
externally renamed new-task tag falls back to Untagged; renaming it inside Electron updates the selection.
Dialogs, search text within menus, unsaved settings, and pending deletion marks
are temporary. Private edit drafts remain available through draft recovery.
Window position and size are restored within the available display area.
**Menu → Window…** can instead start Pinote at a fixed position (desktop
coordinates) and/or size (at least 280×120). **Remember last** restores the last
one. These apply on every start and are kept on screen; a tiling window manager
may still place the window itself. They are saved in `window.json`, not the database.

With the default database location, Electron stores that working state in
`<data>/pinote/electron/state.json`, and window geometry in
`<data>/pinote/electron/window.json`. These live in an `electron/` directory beside the discovered database; there
is no renderer-selected database path. Electron's runtime profile/single-instance lock lives in `<data>/pinote/electron/profile/`.
Session data and `app.log` live under `<state>/pinote/electron/<databasehash>/`;
early startup errors use `<state>/pinote/electron/app.log`. `<data>` and `<state>` use
absolute XDG overrides or the usual `~/.local/share` and `~/.local/state` defaults.
Draft content is capped at 1 MiB, with separate bounded space for recovery warnings.
Drafts and logs are local, **not encrypted**. Include Electron state in
[database backups](usage.md#data-privacy-and-backup), with Electron closed and writes stopped.

Unreadable/corrupt draft state opens read-only and is not overwritten. Close
Electron, back up the original `electron/state.json`, and repair it while
preserving recoverable drafts; do not discard it as a generic reset.
An uncertain write blocks further writes and is **never automatically retried**.
Inspect saved tasks and any new Kitty tab first, then use the explicit
“I checked saved tasks; enable writes” action and confirmation to acknowledge it.
Acknowledgement does not replay the operation. If the renderer fails and recovery
cannot be saved, a native dialog keeps the app alive to retry or copy recovered
state; quitting without saving requires an explicit choice.

## Unpacked Linux application

```sh
npm --prefix electron run package
electron/out/pinote-electron-linux-x64/pinote-electron
```

On x64 Linux this creates `electron/out/pinote-electron-linux-x64/`, an unpacked
application, not an installer. Packaging follows the host architecture. The
backend and its dependency notices are bundled outside ASAR; source files and
checkout dependencies are not needed on the target. External Node.js 22.19+ and
`flock` are required; local reminders use GNU `/usr/bin/date` and system timezone data. Python is not required. There is no auto-updater or public publishing flow.

The renderer uses a custom secure protocol, restrictive CSP, sandboxing,
context isolation, and a narrow isolated preload API. Packaged native fuses
disable Node/debug-inspect entrypoints; these are not intended as packaged
runtime debugging interfaces. Keep Chromium's sandbox enabled: never launch
with `--no-sandbox`. See the development guide for ephemeral CI sandbox setup.
