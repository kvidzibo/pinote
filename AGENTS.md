# Target
- Electron is the default target. Make changes only for Electron unless the user explicitly specifies otherwise; do not update other clients by default.

# UI
- Prefer icons over text for action buttons; provide tooltips and accessible names.
- Keep UI icon assets in the repository and include them in the application package.

# Tests
- Tests that load Pi configuration must set and restore `PI_CODING_AGENT_DIR` as well as the XDG paths; an inherited `pi-note.json` loads personal handlers.
- Electron e2e: after enabling writes, wait for `#draft` to reach `aria-readonly="false"` before opening task actions; the late task render closes open action bars.
- Electron screenshots at a fixed size: write `pinote/electron/window.json` with `manualSize: true` into the temporary data directory before launch; `setBounds` after launch is undone by the content-height fit.
