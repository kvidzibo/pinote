# README images

These are real Linux/X11 captures of Pinote 0.7.0 and pi-note 0.11.0 with
synthetic tasks. `pi-integration.png` combines separate Pi and GTK captures;
the example PR is fictitious. Pi used an offline demo model configuration,
and no prompt was submitted to a provider.

- `linux-checklist.png`: tags, the pinned in-progress section, input and filters.
- `workflow.gif`: nine-second add → start → edit → complete demo; captions sit
  outside the captured UI. The checklist and editor are cropped separately.
- `workflow-still.png`: static alternative showing the edited, in-progress task.
- `pi-integration.png`: selected-task menu/footer and the same task's Agent preview.

When refreshing these assets, use the [GUI development environment](../development.md)
and an isolated Xvfb display, private D-Bus and private i3 socket. Use temporary
HOME, XDG and `PI_CODING_AGENT_DIR` directories with sample data only; do not
capture a live desktop or reuse personal Pi credentials. Set `LANG=C.UTF-8`
and make the configured GUI font available to fontconfig. Disable PR polling with
`PINOTE_PR_POLL_SECONDS=0`; selecting a demo task needs no model request.
Keep native text readable, include complete controls, and check every animation
stage for clipping before replacing the images. Keep the still alternative in sync.
