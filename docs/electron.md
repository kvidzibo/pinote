# Experimental Electron frontend

[Quickstart](../README.md) · [Development and tests](development.md#electron-frontend) · [GTK fallback](gui.md)

Electron is an **optional trial frontend**, not a replacement for GTK. GTK remains
the default and fallback; removing Python, deprecating GTK, or changing defaults
would require a later explicit decision. Only Linux/X11/i3 is a validation target.
Resource use is substantially higher than GTK. Trial it before considering a
default switch; local validation measurements are not performance guarantees.

## Install and launch from a checkout

Requires Python 3.11+, uv, Node.js **22.12.0+**, npm, and Linux desktop libraries
for Electron (including GTK 3). The independently versioned `electron/` npm
package is private, version 0.10.1. Editor autosave requires the matching
Python backend (0.25.1+); update both from this checkout.
Run from the repository root:

```sh
uv sync --locked
npm --prefix electron ci --ignore-scripts
npm --prefix electron run setup
npm --prefix electron run check
npm --prefix electron test
npm --prefix electron run build
PINOTE_ELECTRON_BACKEND="$PWD/.venv/bin/pinote-electron-backend" npm --prefix electron start
```

`setup` explicitly downloads the locked Electron 45 binary; there is no Electron
postinstall download in this version. Dependencies have their own
`electron/package-lock.json`. `start` rebuilds before launching.
The dependency-free `pinote-electron-backend` console entrypoint comes from the
Python installation. Use a **trusted absolute executable path** for
`PINOTE_ELECTRON_BACKEND`, or install that entrypoint in an absolute `PATH`
directory; relative PATH entries are not searched. No service or network listener
is started. Installation does not alter GTK startup, i3 rules, or user configuration.

The window is a compact, always-on-top utility window. Its utility type is the
intended automatic-floating mechanism in i3, without additional rules. Although
`start` requests `--class=pinote-electron`, native development `WM_CLASS` can be
`electron`; do not rely on that requested class as an observed window identity.
Icons are bundled rather than taken from the host icon theme.

## Controls and deliberate differences

Task rows stay single-line and compact. Subtle separators span the text/tag area;
a light hover highlight follows the whole row without moving it or replacing
progress, deletion-mark, or keyboard-focus styling. Row action order is unchanged.

- Add with **Enter**; **Shift+Enter** inserts a newline. The composer grows
  and shrinks with its text. Ordinary tasks use the available window height;
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
- Click a task's play icon to start it, then its checkmark to complete it.
  Right-click task text, use its actions button, or focus task text and press
  **Shift+F10** or the **Menu** key to open an inline icon toolbar in the same
  row height. Actions include **Start/Reset**, **Complete**, archive, **Start in
  Kitty…**, **Copy**, **Edit**, **Reminder**, and **Tag**. Only one toolbar opens
  at a time. Use arrow keys or **Home/End** to navigate and **Enter/Space** to
  activate. **Close**, **Escape**, or clicking outside restores the task text;
  **Tab** out also dismisses the toolbar without closing Pinote.
  Right-click an in-progress task's checkmark to reset progress.
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
- Local text and pending tag selections (including new-tag folders and tag
  clears) are cached before each write. Failed saves pause autosave and offer
  an explicit retry; unknown outcomes require the recovery acknowledgement first.
  External revision changes make the editor read-only rather than overwriting
  another client's work. Close and use **Menu → Recover private edit drafts**
  to copy/discard stale text, then reopen the latest task to reconcile it.
  Recovered drafts show any pending tag and never autosave merely because they
  are opened: review and explicitly retry both text and tag changes. Opening an
  editor does not create a write or history entry.
- Search tag selectors and filters; create/manage saved tags and optional default
  Kitty folders. Tags with the newest associated tasks appear first, followed by
  unused tags and Untagged. Use arrow keys to move through tags and **Space** to
  toggle a focused filter. The highlighted funnel indicates a tag filter is active; its
  count includes all visible tasks, including in-progress tasks that remain
  visible regardless of tag filters.
- **Menu → Manage tags** opens a searchable saved-tag list beside a separate
  editor (stacked in narrow windows). Select a tag, edit its name, and use the
  save icon to rename it across tasks. Folder icons choose or clear its default
  Kitty folder immediately. The **+** creates a tag; the separated delete icon
  asks for confirmation and keeps tasks and history. Polling preserves an
  unfinished name edit while updating the selected tag's folder.
- The bottom menu opens beside its button and provides scheduled reminders,
  Archive (including restore), tag management, task-action settings, and draft
  recovery. It remains a native popup menu, which can adjust its placement at screen edges and extend
  beyond the small window.
- The task row's eye opens a floating Markdown preview about 10 px from the
  click, including agent fields and unread updates. It may overlap or extend
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
  The eye is a configurable Preview action. These are deliberate differences,
  not a promise of pixel-for-pixel GTK parity.

Kitty launching uses the existing backend integration and its prerequisites;
see [GTK controls](gui.md). With Python backend 0.25.2+, tab titles omit leading
Markdown heading markers (`# ` through `###### `) before the 30-character limit;
tags and saved task text stay unchanged. The frontend does not send Dunst notifications.
Due reminders activate on backend refresh, not through a new alarm service.

## Shared tasks, separate UI state, and recovery

GTK, CLI, Pi, and Electron share `notes.db` and the display lock and may run
alongside each other. Electron does not copy tasks into a separate frontend
database. Each frontend refreshes external changes; stale saves are refused. Roll back by closing Electron and reopening
GTK; task data needs no conversion.

Restarting restores the new-task tag (including Untagged), tag filters, composer
and private edit drafts, collapsed state, list scroll positions, saved task-action
preferences, and agent read cursors. A deleted or externally renamed new-task tag
falls back to Untagged; renaming it inside Electron updates the selection.
Dialogs, search text within menus, unsaved settings, and pending deletion marks
are temporary. Private edit drafts remain available through draft recovery.
Window position and size are restored within the available display area.

With the default database location, Electron stores that working state in
`<data>/pinote/electron/state.json`, and window geometry in
`<data>/pinote/electron/window.json`. These live in an `electron/` directory beside the discovered database; there
is no renderer-selected database path. Electron's runtime profile/single-instance lock lives in `<data>/pinote/electron/profile/`.
Session data and `app.log` live under `<state>/pinote/electron/<databasehash>/`;
early startup errors use `<state>/pinote/electron/app.log`. `<data>` and `<state>` use
absolute XDG overrides or the usual `~/.local/share` and `~/.local/state` defaults.
Draft content is capped at 1 MiB, with separate bounded space for recovery warnings.
Drafts and logs are local, **not encrypted**. Include Electron state in backups
alongside the [existing database/GTK backup files](usage.md#data-privacy-and-backup),
with GUIs closed and writes stopped.

Unreadable/corrupt draft state opens read-only and is not overwritten. Close
Electron, back up the original `electron/state.json`, and repair it while
preserving recoverable drafts; do not discard it as a generic reset. GTK remains
available. An uncertain write blocks further writes and is **never automatically
retried**. Inspect saved tasks and any new Kitty tab first, then use the explicit
“I checked saved tasks; enable writes” action and confirmation to acknowledge it.
Acknowledgement does not replay the operation. If the renderer fails and recovery
cannot be saved, a native dialog keeps the app alive to retry or copy recovered
state; quitting without saving requires an explicit choice.

## Unpacked Linux application

```sh
npm --prefix electron run package
PINOTE_ELECTRON_BACKEND="$PWD/.venv/bin/pinote-electron-backend" \
  electron/out/pinote-electron-linux-x64/pinote-electron
```

On x64 Linux this creates `electron/out/pinote-electron-linux-x64/`, an unpacked
application, not an installer. Packaging follows the host architecture. Python
is **not bundled**: the target machine still needs a separately installed
compatible backend, found via the trusted absolute override or absolute PATH
entries. There is no auto-updater or public publishing flow.

The renderer uses a custom secure protocol, restrictive CSP, sandboxing,
context isolation, and a narrow isolated preload API. Packaged native fuses
disable Node/debug-inspect entrypoints; these are not intended as packaged
runtime debugging interfaces. Keep Chromium's sandbox enabled: never launch
with `--no-sandbox`. See the development guide for ephemeral CI sandbox setup.
