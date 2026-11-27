# README images

These are real Linux/X11 captures with synthetic tasks. The Electron screenshots
use pinote-electron 0.30.0 and Pinote 0.29.0. `pi-integration.png` combines separate
GTK and Pi captures using Pinote 0.7.0 and pi-note 0.11.0. The example PR is fictitious.
Pi used an offline demo model configuration, and no prompt was submitted to a provider.

- `electron-checklist.png`: 560×460 window with the default row actions, all tags
  shown, a light hover on “Add screenshots to the README”, and an unread agent
  update on “Polish the task list”.
- `electron-actions.png`: 420×460 window with the inline action toolbar open.
- `electron-editor.png`: 560×460 task editor with Markdown source and an agent field.

The Electron images were captured from the running app under isolated Xvfb,
private D-Bus/i3, and temporary HOME/XDG data; no personal tasks or desktop were
used. These are documentation captures, separate from the temporary
regression-test artifacts.
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
