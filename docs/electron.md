# Electron desktop frontend

[Quickstart](../README.md) · [CLI and data](usage.md) · [Electron](electron.md) · [Development](development.md)

Electron is Pinote's desktop frontend on the Node backend. Only Linux/X11/i3 is a
validation target; [macOS](#macos-experimental) support is experimental.

## Install and launch from a checkout

Requires Node.js **22.19.0+**, npm, and on Linux Electron's desktop runtime
libraries, including GTK 3 (`libgtk-3`). From the repository root:

```sh
npm --prefix electron ci --ignore-scripts
npm --prefix electron run setup
npm --prefix electron start
```

`setup` installs the locked backend and `pi/` watcher build dependencies, builds
the backend bundles, and downloads the locked Electron 45 binary. `start`
rebuilds before launching. Installation does not change desktop login startup, i3
rules, or user configuration. [Development checks](development.md#electron-frontend)
are not required to launch.

Runtime environment:

- `node` is found in absolute `PATH` directories, or set `PINOTE_NODE` to a
  **trusted absolute Node executable**. Relative `PATH` entries are ignored and
  unsupported Node versions fail at startup.
- `PINOTE_BRIDGE_COMMAND` is a trusted absolute bridge executable override for
  diagnostics and tests.
- `HOME` must be absolute; `HOME`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` must not
  contain `..`.

The window is a compact, always-on-top utility window, which i3 floats without
additional rules. Native development `WM_CLASS` can be `electron` despite the
requested `--class=pinote-electron`; do not rely on it as window identity.

### macOS (experimental)

Start Pinote from a terminal with the commands above, so `PATH` contains `node`.
Dunst notifications are unavailable; the desktop window shows the reminders. CI
runs only a [basic macOS check](development.md#macos), with Start in Kitty
checked against a Kitty stand-in, not real Kitty.

## Field watchers

Electron runs [field watchers](../pi/FIELD_EVENTS.md) for exactly as long as the
desktop is open. Tasks changed while it is closed are picked up on the next start.
Pi sessions read watcher results and alerts from the shared watcher state.

- **Environment:** watchers use the desktop's, including any tokens they need and
  `PINOTE_NOTE_COMMAND` (default `note` on `PATH`; it must use the desktop's database).
- **Logs:** start and stop lines go to the desktop's `app.log`; failed checks to
  `watchers.log` beside the watcher state. If watchers cannot start, the desktop
  stays usable.
- **Menu → Watchers…** adds a script, chooses the app, task and field events it
  listens for, names its fields, fills in the
  [parameters it declares](../pi/FIELD_EVENTS.md#watcher-settings), and sets its
  time limit and cooldown under **Limits**. The **startup** app event runs a
  watcher once per desktop start. Up to four watchers run at once.
- **Saving** asks for confirmation, naming each enabled script and Forgejo
  instance, and applies to the next check.
- **Bundled watchers:** **Worktree cleanup** removes a completed task's clean Git
  worktrees (the `Worktrees` field). **Run command** runs a configured command at
  startup and after task completions, merging completions held by its cooldown
  into one run.
- Pi's `/pinote` settings can also enable watchers. Each side lists its own
  copies as **Bundled**; the desktop hides one when a saved entry is a copy of it
  and runs whichever executable path is saved.

Version requirements: task events need `note` 0.27.0+ (otherwise they are skipped
and field watchers keep running); non-default settings need pi-note 0.48.0+ in
Pi; app events, time limits and cooldowns need pi-note 0.53.0+.

Upgrading from older versions:

- A standalone `pinote.service` is no longer used: stop and disable it, and
  remove any leftover `pinote.service.d/90-node-backend.conf` drop-in.
- Entries saved by Electron 0.14 point at copies inside the application. They keep
  running and are listed as **Custom**; after switching entries, still failing
  checks can alert once more.

## Controls

Rows are single-line. Click a task's play icon to start it, then its checkmark to
complete it. The bottom cog menu (**Menu**) holds scheduled reminders, Archive
(with restore), settings, draft recovery and **Quit Pinote**.

### Composer and editor

- **Enter** adds a task; **Shift+Enter** inserts a newline.
- Both style Markdown **source** live (headings, bold, italic, code); markers
  stay visible and stored text is never rewritten by styling.
- The first newline after a plain single-line task turns it into `# Task`
  followed by `- `. Newlines after headings and bullets continue `- `; an empty
  bullet ends the list.
- **Tab** indents a `-` bullet by two spaces. **Backspace** at the start of its
  text removes one level, then the bullet prefix. **Shift+Tab**, or Tab on a
  non-bullet line, moves focus.
- **Menu → New task editor… → Start as Markdown** (default off) starts new drafts
  with `# `.
- The editor **autosaves after a 650 ms typing pause** and shows its status in the
  footer. **Ctrl+Enter** saves and closes. **Escape/Close** dismisses the editor
  while the pending save finishes; closing the app also drains pending edits.
- The header **tag button** chooses, creates or clears a tag; the change saves
  immediately. **Undo** (**Ctrl+Z**) reverts text edits in the open editor, not
  tag changes.
- **Agent fields**, below the text, lists the task's saved handoff fields plus
  those configured in Pi's field settings (`pi-note.json`). Edits autosave;
  clearing a value removes the field. Your own edit does not mark the task as an
  unread agent update.
- **Failed saves** pause autosave and offer an explicit retry; unknown outcomes
  need the [recovery acknowledgement](#shared-tasks-separate-ui-state-and-recovery)
  first. If another client changed the task, the editor becomes read-only: close
  it, use **Menu → Recover edit drafts…** to copy or discard your text, then
  reopen the task. Recovered drafts never autosave merely because they are opened.

### Images

Paste (**Ctrl+V**) or drop an image into the composer or editor. It is saved at
once and shown on its own line; the text keeps a short
`![image](pinote:sha256-…)` reference, which is what the CLI, Dunst and Pi show.

- **Conversion:** PNG, BMP and WebP become lossless WebP (quality 90 only if
  lossless exceeds 4 MiB). JPEG becomes WebP at quality 85, dropping camera and
  GPS metadata. Sides over 2560 px are scaled down. GIFs are kept as they are (up
  to 2560 px). Stored images are limited to 4 MiB.
- **Editing:** the picture behaves as one character: **Backspace** or **Delete**
  removes it and **Undo** restores it while the editor stays open.
- **Deletion:** an image is deleted from the database when no task or draft uses
  it. Archived tasks keep their images; task history does not, so older text may
  show **Image unavailable**.
- **Viewing:** click a picture in a preview or expanded archive row, or
  double-click it in an editor. **Menu → Window… → Open images in** chooses
  **Image window** (default, full size scaled to the screen), **This window**, or
  **System viewer** (a temporary copy, removed when Pinote quits). A click or
  **Escape** closes Pinote's own views. Pictures inside links open the link.

### Task actions

- Right-click task text, use its Actions button, or press **Shift+F10** or the
  **Menu** key to open an inline toolbar: **Start/Reset**, **Complete**, archive,
  **Start in Kitty…**, **Copy**, **Edit**, **Reminder**, and **Tag**. Navigate
  with arrow keys or **Home/End**, activate with **Enter/Space**, and dismiss
  with **Close**, **Escape**, **Tab** or a click outside.
- Right-click a row action (other than Preview): on an unstarted task it marks
  the task for deletion, on an in-progress task it resets progress, and on a
  marked task it deletes (archives) the task.
- While the pointer is inside the window, rows keep their order and section even
  after a state change. Completed, archived and filtered-out tasks still disappear.
- **Menu → Task actions…** configures the row separately for **Not started**,
  **In progress** and **Marked for deletion** tasks. Drag elements or use
  **↑/↓**; top-to-bottom order becomes left-to-right, shown in a live preview.
  **Tag** and **Task text** are required but movable; other elements can be
  removed. Custom actions are not supported.
- **Add actions / configure menu** adds row buttons and separately sets the
  action menu's order and **In menu** visibility. On narrow rows, text shortens
  first, then excess buttons move under **Actions**.
- **Save** applies all tabs; **Escape/Close** discards changes; **Restore
  defaults** resets only the selected tab. Editing settings never runs an action.
  These preferences affect Electron only.
- **Set reminder…** opens a local date-time picker. Skipped or repeated
  daylight-saving times are rejected; choose another time or use `note schedule`
  with an explicit offset. See [scheduled reminders](usage.md#scheduled-reminders).

### Tags and filters

- Tag selectors and filters are searchable. Tags with the newest tasks come
  first, then unused tags and Untagged. A highlighted funnel means a filter is
  active; in-progress tasks stay visible regardless of filters.
- **Menu → Manage tags…** renames a tag across its tasks, sets or clears its
  default Kitty folder, creates tags, and deletes them after confirmation
  (keeping tasks and history).
- **Base folder** prefills each new tag's folder with `<base folder>/<tag>` (`/`
  in the name becomes `-`). Creating the tag creates that folder; if that fails,
  the tag is not created. Existing tags and renames keep their folders.

### Preview

A row's eye opens a floating Markdown preview with all saved agent fields
(including those disabled in Pi's field settings), full Pi session IDs, and
unread updates. **Escape**, **Close** or losing focus dismisses it; **Edit**
opens the editor. Raw HTML and remote images are not loaded, and links open
externally only on explicit activation.

### Start in Kitty

**Start in Kitty…** uses the tag's default folder, or opens a directory chooser.
Electron marks the task in progress before launching; on failure, progress is
retained and the error names the cause. If the error says the outcome is
uncertain, check for a new Kitty tab or window before retrying.

Requirements:

- `kitty` and `pi` in absolute `PATH` directories, the
  [pi-note extension](../pi/README.md), and a `note` CLI using the same database.
- To reuse Kitty, enable `allow_remote_control socket-only` and point
  `KITTY_LISTEN_ON` at its socket; if that address is unreachable, launch fails.
- Without `KITTY_LISTEN_ON`, Pinote searches same-user Kitty instances on the same
  X11 display at `unix:@mykitty-<pid>` (`listen_on unix:@mykitty`). If none is
  reachable, it opens a new window without restoring saved tabs.

The launch passes the task ID, revision and an optional editor draft. Pi does not
select the task if the revision no longer matches. Launching never submits a
prompt or completes the task. A tab keeps its task: starting Pi again in it, or
`/new`, selects the task unless another Pi pane in the tab already holds it.

**Menu → Kitty…** sets:

| Setting | Behavior |
| --- | --- |
| Tab name | Default `{tag}{title:30}`: a `[tag] ` prefix if tagged, then the first line without a heading marker, cut to 30 characters. `{title}` keeps the whole line; `{id}` adds the task number. Cut to 1024 characters. |
| Start prompt | Default `is task clear?`. Placed in Pi's empty editor as a draft, never submitted; empty disables it. Up to 4000 characters; tabs and newlines allowed, other terminal controls not. |
| One task per tab | Selecting a task in Pi moves a split pane whose tab already shows another task to a new tab beside it. |
| When a task is completed in Pi | **Keep Pi open**, **Close Pi** (default; also closes a Start in Kitty tab) or **Close Pi and its pane** (also ends the shell Pi ran in). |

The first two are saved with Electron's working state; the last two are shared
with Pi through `pi-note.json`.

On macOS, Pinote also looks for `kitty` in `/Applications/kitty.app` and
`~/Applications/kitty.app`, for `pi` in `~/.pi/agent/bin`, and for both in
`/opt/homebrew/bin` and `/usr/local/bin`. Without `KITTY_LISTEN_ON`, it reuses
same-user Kitty sockets named `mykitty-<pid>` in the private per-user `$TMPDIR`;
configure `allow_remote_control socket-only` and `listen_on unix:mykitty`. New
windows also listen in `$TMPDIR`; a shared one, such as `/tmp`, is refused.
Pi tabs get Pinote's `PATH`, because Kitty opened from the Dock lacks `node`.

## Configuration

The Node backend reads `$XDG_CONFIG_HOME/pinote/config.toml` (default
`~/.config/pinote/config.toml`). The defaults are:

```toml
[gui]
max_visible_notes = 10
markdown_preview = true
```

- `max_visible_notes` (positive integer) caps the rows used to calculate the
  checklist's automatic height, at no fewer than two rows. It does not hide tasks or override
  a manually sized window.
- `markdown_preview = false` shows task text and agent field values literally in
  the preview and expanded Archive and Scheduled reminders entries.

Invalid configuration reports an error; Pinote never creates or overwrites the file.

## Shared tasks, separate UI state, and recovery

Electron, the CLI, and Pi share `notes.db` and the display lock. Electron refreshes
external changes and refuses stale saves.

Restarting restores the new-task tag, tag filters, composer and edit drafts,
collapsed state, scroll positions, task-action and editor preferences, Kitty
settings, the tag base folder, agent read cursors, and window position and size.
Dialogs, menu search text, unsaved settings, and pending deletion marks are not kept.

**Menu → Window…** can instead start Pinote at a fixed position and/or size (at
least 280×120), kept on screen; **Remember last** restores the previous ones. A
tiling window manager may still place the window itself.

| State | Location |
| --- | --- |
| Working state and drafts | `electron/state.json` beside `notes.db` |
| Window geometry | `electron/window.json` beside `notes.db` |
| Runtime profile, single-instance lock | `electron/profile/` beside `notes.db` |
| Session data and `app.log` | `<state>/pinote/electron/<databasehash>/` |
| Early startup errors | `<state>/pinote/electron/app.log` |

`<state>` is an absolute `XDG_STATE_HOME` or `~/.local/state`. Draft content is capped at 1 MiB. Drafts and logs are local and
**not encrypted**. Include Electron state in
[database backups](usage.md#data-privacy-and-backup).

Recovery:

- **Unreadable or corrupt draft state** opens read-only and is not overwritten.
  Close Electron, back up the original `electron/state.json`, and repair it while
  preserving recoverable drafts; do not discard it as a generic reset.
- **An uncertain write** blocks further writes and is **never automatically
  retried**. Inspect saved tasks and any new Kitty tab first, then use
  “I checked saved tasks; enable writes” and confirm. Acknowledgement does not
  replay the operation.
- If the renderer fails and recovery cannot be saved, a native dialog keeps the
  app alive to retry or copy recovered state; quitting without saving requires an
  explicit choice.

## Unpacked Linux application

```sh
npm --prefix electron run package
electron/out/pinote-electron-linux-x64/pinote-electron
```

This creates an unpacked application for the host architecture, not an
installer. The backend is bundled, so the target needs no source files or
checkout dependencies, but still the [runtime requirements](#install-and-launch-from-a-checkout)
above, including external Node.js 22.19+. There is no auto-updater or
public publishing flow.

The renderer uses a custom secure protocol, restrictive CSP, sandboxing, context
isolation, and a narrow preload API. Packaged fuses disable Node/debug-inspect
entrypoints. Keep Chromium's sandbox enabled: **never launch with `--no-sandbox`**.
See the [development guide](development.md#electron-frontend) for CI sandbox setup.
