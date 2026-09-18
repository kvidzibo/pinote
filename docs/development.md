# Development and validation

[Quickstart](../README.md) · [CLI and data](usage.md) · [GTK and desktop](gui.md) · [Development](development.md)

Run checkout-relative commands from the repository root.

## Development and tests

```sh
uv sync --locked
uv run ruff check . && uv run ruff format --check .
uv run pytest -m 'not gui'
xvfb-run -a dbus-run-session -- uv run pytest -m 'gui and not gtk' --run-gui
uv build
```

Dunst tests require `dunst`, `dunstify`, `dunstctl`, `xvfb-run`, `xauth`, and
`dbus-run-session`. GTK tests additionally require `xdotool` and the [GUI environment](gui.md#debian-installation-isolated-from-the-cli). Install `i3-wm` for the optional placement/resize regression; it starts a
private i3 with its own IPC socket inside Xvfb, never using your desktop's socket
or configuration. The restart-helper regression also uses that isolated setup to
check hidden-workspace recovery, environment preservation, and stopped GUIs.
Install development tools into the GUI environment and run its
interpreter directly (plain `uv run` would select the separate CLI environment):

```sh
uv pip install --python .venv-gui/bin/python -e . --group dev
xvfb-run -a -s '-screen 0 2560x1440x24' dbus-run-session -- .venv-gui/bin/python -m pytest -m gtk --run-gui
# Also cover placement on smaller displays:
xvfb-run -a dbus-run-session -- .venv-gui/bin/python -m pytest tests/test_gtk.py -k 'compact_ or i3_honors or single_instance_reopen or error_notice_keeps or manual_position' --run-gui
```

Always run GUI tests under `xvfb-run` with a private D-Bus session; the tests refuse
to use the real desktop. All tests use temporary storage. CI runs unit/CLI tests
on Python 3.11 and 3.13, isolated Dunst tests, and a separate system-Python GTK job
against the built wheel (including its bundled stylesheet and isolated i3 placement).
GTK regressions also exercise manual window moves during geometry synchronization.

The package uses `src/pinote/` with `python -m pinote` support. Storage, Markdown,
notification rendering, and CLI parsing are separated for focused testing.
`gui/` contains the optional presentation and a GTK-free data adapter; GTK is
loaded only when launching the GUI. Schema upgrades run transactionally in the
shared store, so both frontends use the same progress states and history.
