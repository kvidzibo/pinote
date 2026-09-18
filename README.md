# pinote

Pinned desktop reminders with a small `note` CLI, stable IDs, and durable history.
Linux/i3 first: use a persistent Dunst notification or the optional GTK checklist
for editing, tags, progress, scheduled reminders, and archived tasks. The CLI has
no Python runtime dependencies; the GUI is a separate process, not a service.

## Install

Requires **Python 3.11+**. From a checkout:

```sh
uv tool install .              # or: pipx install .
note --help
```

Keep your installer's tool bin directory (usually `~/.local/bin`) on `PATH`.
Dunst (`dunstify`), a graphical session, and session D-Bus are needed only for
notifications; terminal commands work without Dunst. Installation never changes
your shell, desktop configuration, or existing reminders.

For installation without uv/pipx and local upgrades, see the [CLI guide](docs/usage.md#install).

### Optional GTK checklist

On Debian, use a separate environment with the system GTK bindings, not the
isolated CLI interpreter. Run from the checkout:

```sh
sudo apt install python3-gi gir1.2-gtk-3.0  # only if missing
uv venv --python /usr/bin/python3 --system-site-packages .venv-gui
uv pip install --python .venv-gui/bin/python -e .
.venv-gui/bin/pinote-gui
```

The GUI and CLI share the same database. [GUI setup and controls](docs/gui.md)
cover non-uv installation, i3 login startup, filtering, editing, and configuration.
After GUI source changes, use `./scripts/restart-pinote.sh`; it preserves the
running instance's workspace and leaves a stopped GUI stopped.

## Use

```sh
note "check backups"                     # save and refresh the Dunst reminder
note                                    # list active notes
note done 2                             # complete a task
note rm 3                               # archive, never erase
note restore 3                          # restore a task or clear its progress
note schedule 2 "2030-09-18 14:30"        # use a future local date/time
note reminders                          # list scheduled tasks
note history 3                          # inspect retained history
note --no-notify "GUI-only reminder"     # save without refreshing Dunst
```

In the GUI, add with **Enter** or **+**; right-click task text to edit, tag, or
schedule it. The bottom menu opens reminders and the archive. Full commands,
Markdown import/export, and scheduling rules: [CLI and data guide](docs/usage.md).

## Important constraints

- **Reminders are not wake-up alarms.** Due tasks return while the GUI is open,
  when it next opens/resumes, or when a `note` command runs. There is no timer
  service or automatic Dunst notification. GUI changes do not refresh Dunst.
- IDs and history are retained. Completion/deletion is recoverable; closing the
  checklist does not complete tasks. Its default filter is **Untagged**, so tagged
  tasks may be hidden until you change the filter.
- Data is saved before notification delivery. Do not repeat an add just because
  Dunst failed. Quote shell metacharacters; use `note add "done"` for reserved names.
- Notes default to `~/.local/share/pinote/notes.db`; logs to
  `~/.local/state/pinote/app.log` (XDG overrides supported). Data stays local but
  is **not encrypted**, and desktop notifications may remain in Dunst history.
- Markdown exports are **not backups**: they omit IDs, tags, schedules, and history.
  Close the GUI and stop CLI writes before copying `notes.db` and `gui-draft.txt`.
  [Backup and upgrade details](docs/usage.md#data-privacy-and-backup).
- Back up before upgrading; update both CLI and GUI installations together.
  Older versions cannot read schema 4. [Upgrade guide](docs/gui.md#upgrading-for-scheduled-reminders).

## Validation

From the repository root:

```sh
uv sync --locked
uv run ruff check . && uv run ruff format --check .
uv run pytest -m 'not gui'
xvfb-run -a dbus-run-session -- uv run pytest -m 'gui and not gtk' --run-gui
uv build
```

GUI tests require the documented desktop tools and always run under Xvfb with a
private D-Bus session. [Development guide](docs/development.md) includes GTK tests,
prerequisites, and the smaller-display checks. Tests use temporary storage.

## License

[MIT](LICENSE).
