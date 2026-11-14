# Experimental Electron frontend

[Quickstart](../README.md) · [Development and tests](development.md#electron-frontend) · [GTK fallback](gui.md)

Electron is an **optional trial frontend**, not a replacement for GTK. GTK remains
the default and fallback; removing Python, deprecating GTK, or changing defaults
would require a later explicit decision. Only Linux/X11/i3 is a validation target.
Resource use is substantially higher than GTK. Trial it before considering a
default switch; local validation measurements are not performance guarantees.

## Install and launch from a checkout

Requires Python 3.11+, uv, Node.js **22.12.0+**, npm, and Linux desktop libraries
for Electron (including GTK 3). The Python package is 0.23.0; the independently
versioned `electron/` npm package is private, version 0.2.0.
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

- Add with **Enter**; **Shift+Enter** inserts a newline. The composer grows
  and shrinks with its text. Ordinary tasks use the available window height;
  in-progress tasks size to their contents above the composer (up to half the
  list when ordinary tasks are present) and scroll separately when needed.
  Manual window sizing is preserved.
- Click a task's play icon to start it, then its checkmark to complete it.
  Right-click task text, use its actions button, or focus task text and press
  **Shift+F10** or the **Menu** key to open an inline icon toolbar in the same
  row height. Actions include **Start/Reset**, **Complete**, archive, **Start in
  Kitty…**, **Copy**, **Edit**, **Reminder**, and **Tag**. Only one toolbar opens
  at a time. Use arrow keys or **Home/End** to navigate and **Enter/Space** to
  activate. **Close**, **Escape**, or clicking outside restores the task text;
  **Tab** out also dismisses the toolbar without closing Pinote.
  Right-click an in-progress task's checkmark to reset progress.
- **Menu → Task actions…** configures the inline right-click actions. Toggle
  **In menu** to show/hide items; drag a handle to reorder them, or focus the
  handle and use **↑/↓**. Choose one **Button** action to replace Start on task
  rows. The default Start button still becomes Complete in progress; other
  choices remain the selected action for all rows, even when hidden from the
  menu. Right-click row-button shortcuts remain unchanged.
  **Save** applies the settings to all rows; **Escape/Close** discards unsaved
  changes. **Restore defaults** resets the form; save to apply it. Selecting or
  reordering an action does not run it. These preferences affect Electron only.
- Edits are private revision-bound drafts until saved with **Ctrl+Enter**. The
  menu includes draft recovery; stale drafts must be copied/reconciled rather
  than silently overwriting a changed task.
- Search tag selectors and filters; create/manage saved tags and optional default
  Kitty folders. Tags with the newest associated tasks appear first, followed by
  unused tags and Untagged. Use arrow keys to move through tags and **Space** to
  toggle a focused filter. The highlighted funnel indicates a tag filter is active; its
  count includes all visible tasks, including in-progress tasks that remain
  visible regardless of tag filters.
- The bottom menu opens beside its button and provides scheduled reminders,
  Archive (including restore), tag management, task-action settings, and draft
  recovery. It remains a native popup menu, which can adjust its placement at screen edges and extend
  beyond the small window.
- The task row's eye opens a safe Markdown preview, including agent fields
  and unread updates. Raw HTML and remote images are not loaded. Supported links
  open externally only on explicit activation.
- Editors, previews, and searchable tag pickers are scrollable in-window dialogs;
  task actions use inline toolbars and the bottom menu uses a native popup menu,
  not centered panels.
  Folder selection and recovery confirmation can also use native dialogs.
  The eye is shown unless the row's action toolbar is open. These are deliberate
  differences, not a promise of pixel-for-pixel GTK parity.

Kitty launching uses the existing backend integration and its prerequisites;
see [GTK controls](gui.md). The frontend does not send Dunst notifications.
Due reminders activate on backend refresh, not through a new alarm service.

## Shared tasks, separate UI state, and recovery

GTK, CLI, Pi, and Electron share `notes.db` and the display lock and may run
alongside each other. Electron does not copy tasks into a separate frontend
database. Each frontend refreshes external changes; stale saves are refused. Roll back by closing Electron and reopening
GTK; task data needs no conversion.

With the default database location, Electron stores drafts, tag filters,
task-action preferences, and agent read cursors in
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
