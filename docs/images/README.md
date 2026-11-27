# README images

Real Linux/X11 captures with synthetic tasks, taken under isolated Xvfb, private
D-Bus/i3, and temporary HOME/XDG data. No personal tasks, live desktop, or model
request was used; the example PR is fictitious.

| Image | Content | Versions |
| --- | --- | --- |
| `electron-checklist.png` | 560×460, default row actions, all tags, light hover, one unread agent update | pinote-electron 0.30.0, Pinote 0.29.0 |
| `electron-actions.png` | 420×460, inline action toolbar open | same |
| `electron-editor.png` | 560×460, task editor with Markdown source and an agent field | same |
| `pi-integration.png` | Selected-task menu/footer beside the task's Agent preview (separate GTK and Pi captures) | Pinote 0.7.0, pi-note 0.11.0 |
| `pi-task-suggestion.png`, `pi-task-selected.png` | Bold controls and compact selected-task spacing, cropped from Kitty | pi-note 0.15.1 |
| `pi-task-replacement.png` | After replacing an unaccepted suggestion, cropped from Kitty | pi-note 0.17.0 |

## Refreshing

- Use the [Electron development setup](../development.md#electron-frontend) with an
  isolated Xvfb display, private D-Bus and private i3 socket.
- Use temporary HOME, XDG and `PI_CODING_AGENT_DIR` directories with sample data
  only; never capture a live desktop or reuse personal Pi credentials.
- Set `LANG=C.UTF-8`, make the configured font available to fontconfig, and
  disable PR polling with `PINOTE_PR_POLL_SECONDS=0`.
- Keep native text readable and include complete controls.
