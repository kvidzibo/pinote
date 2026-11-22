# README images

These are real Linux/X11 captures with synthetic tasks. The Electron screenshots
use pinote-electron 0.10.1 and Pinote 0.25.1. `pi-integration.png` combines separate
GTK and Pi captures using Pinote 0.7.0 and pi-note 0.11.0. The example PR is fictitious.
Pi used an offline demo model configuration, and no prompt was submitted to a provider.

- `electron-checklist.png`: 880×560 Electron window with customized Kitty/Edit
  buttons, right-aligned tags, single-line rows, inset separators, and a light
  hover on “Add screenshots to the README”. In-progress rows use Complete/Edit.
- `electron-compact.png`: 420×460 Electron window with the default row actions
  and the same hover treatment. Both Electron images were captured from the
  running app under isolated Xvfb, private D-Bus/i3, and temporary HOME/XDG data;
  no personal tasks or desktop were used. These are documentation captures,
  separate from the temporary regression-test artifacts.
- `pi-integration.png`: selected-task menu/footer and the same task's Agent preview.
- `pi-task-suggestion.png` and `pi-task-selected.png`: pi-note 0.15.1 bold controls
  and compact selected-task spacing, cropped from isolated Kitty captures with
  synthetic data and no model request.
- `pi-task-replacement.png`: pi-note 0.17.0 after replacing an unaccepted
  suggestion, cropped from isolated Kitty with temporary app data and no model request.

When refreshing these assets, use the [Electron development setup](../development.md#electron-frontend)
and an isolated Xvfb display, private D-Bus and private i3 socket. Use temporary
HOME, XDG and `PI_CODING_AGENT_DIR` directories with sample data only; do not
capture a live desktop or reuse personal Pi credentials. Set `LANG=C.UTF-8`
and make the configured font available to fontconfig. Disable PR polling with
`PINOTE_PR_POLL_SECONDS=0`; selecting a demo task needs no model request.
Keep native text readable and include complete controls.
