# Target
- Electron is the default target. Make changes only for Electron unless the user explicitly specifies otherwise; do not update other clients by default.

# UI
- Prefer icons over text for action buttons; provide tooltips and accessible names.
- Keep UI icon assets in the repository and include them in the application package.

# Tests
- XDG paths do not isolate `pi-note.json`: tests that load it point `PI_CODING_AGENT_DIR` at a temporary directory and restore it, or personal handlers load.
- Electron e2e: after enabling writes, wait for `#draft` to reach `aria-readonly="false"` before opening task actions; the late task render closes open action bars.
- Fixed-size Electron screenshots: before launch, write `$XDG_DATA_HOME/pinote/electron/window.json` with the wanted `width` and `height`, which disables the content-height fit; an early `setBounds` is undone by it.
