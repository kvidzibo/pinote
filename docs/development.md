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
npm --prefix pi ci --ignore-scripts
npm --prefix pi test
(cd pi && npm pack --dry-run)
```

Dunst tests require `dunst`, `dunstify`, `dunstctl`, `xvfb-run`, `xauth`, and
`dbus-run-session`. GTK tests additionally require `xdotool` and the [GUI environment](gui.md#debian-installation-isolated-from-the-cli). Install `i3-wm` for the optional placement/resize regression; it starts a
private i3 with its own IPC socket inside Xvfb, never using your desktop's socket
or configuration. The restart-helper regression also uses that isolated setup to
check hidden-workspace recovery, environment preservation, and stopped GUIs.
Install development tools into the GUI environment and run its
interpreter directly (plain `uv run` would select the separate CLI environment):

```sh
uv pip install --python .venv-gui/bin/python -e '.[gui]' --group dev
xvfb-run -a -s '-screen 0 2560x1440x24' dbus-run-session -- .venv-gui/bin/python -m pytest -m gtk --run-gui
# Also cover placement on smaller displays:
xvfb-run -a dbus-run-session -- .venv-gui/bin/python -m pytest tests/test_gtk.py -k 'compact_ or i3_honors or single_instance_reopen or error_notice_keeps or manual_position' --run-gui
```

Always run GUI tests under `xvfb-run` with a private D-Bus session; the tests refuse
to use the real desktop. All tests use temporary storage. CI runs unit/CLI tests
on Python 3.11 and 3.13, isolated Dunst tests, and a separate system-Python GTK job
against the built wheel (including its bundled stylesheet and isolated i3 placement).
GTK regressions also exercise manual window moves during geometry synchronization.

On PRs, the standalone GTK job runs when the complete PR diff changes Python
source (`src/`), Python tests (`tests/`), scripts, `pyproject.toml`, `uv.lock`, or
GitHub configuration (`.github/`). Electron-, Pi-, and docs-only changes skip
that job. Deleted and renamed paths count. Release runs keep the full suite,
and Electron's GTK coexistence checks remain enabled.

## Electron frontend

The [experimental Electron guide](electron.md) covers installation, state,
recovery, packaging, and limitations. These checks supplement, not replace, all
Python, Dunst, GTK (including smaller-display and i3 regressions), and Pi checks
above. Keep the Python package and Pi package versions independent of Electron.

Use Node.js 22.12+ (CI uses Node 24), the locked local `.venv` backend, and Linux
Electron runtime libraries: GTK 3, NSS, ALSA, ATK/AT-SPI, CUPS, GBM/DRM, and X11
libraries. End-to-end tests additionally need `xvfb-run`, `dbus-run-session`,
`xauth`, `i3-wm`, `xdotool`, and ImageMagick's `import` command (`imagemagick`
on Debian/Ubuntu) for native-menu screenshots. System Python with `python3-gi` and
`gir1.2-gtk-3.0` is needed for GTK coexistence coverage. The Electron scenario
also uses the real Pi HTTP service/client without making model requests.

```sh
uv sync --locked
uv venv --python /usr/bin/python3 --system-site-packages .venv-gui
uv pip install --python .venv-gui/bin/python -e '.[gui]'
npm --prefix pi ci --ignore-scripts && npm --prefix pi run build:mcp
npm --prefix electron ci --ignore-scripts
npm --prefix electron run setup
export PINOTE_ELECTRON_BACKEND="$PWD/.venv/bin/pinote-electron-backend"
xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- sh -c 'npm --prefix electron run check && npm --prefix electron test && npm --prefix electron run test:e2e'
xvfb-run -a -s '-screen 0 800x600x24' dbus-run-session -- npm --prefix electron run test:e2e
npm --prefix electron run build
npm --prefix electron run package
xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- npm --prefix electron run test:package
```

`setup` explicitly downloads Electron; `ci --ignore-scripts` installs locked npm
packages (including esbuild's optional native binary) without lifecycle scripts.
The end-to-end harness uses its own HOME/XDG directories, private i3 configuration
and socket, and clears inherited real i3/Kitty sockets. Always use Xvfb and a
private D-Bus session, never the actual desktop. Test screenshots stay in temporary
artifact directories; do not commit them or attach them to PRs.

Sandboxing must stay enabled. If Ubuntu AppArmor restricts unprivileged user
namespaces, CI provisions the downloaded `chrome-sandbox` helper as root-owned,
mode 4755 on its **ephemeral runner**, including the packaged copy before its
smoke test. This is Chromium's SUID sandbox setup, not permission to use
`--no-sandbox` or disable security sysctls globally. Do not modify a user's
machine configuration as a test workaround.

## Architecture and integration

The package uses `src/pinote/` with `python -m pinote` support. Storage, Markdown,
notification rendering, and CLI parsing are separated for focused testing.
`gui/` contains the optional presentation and a GTK-free data adapter; GTK is
loaded only when launching the GUI. Schema upgrades run transactionally in the
shared store, so both frontends use the same progress states and history.

`pi/` is the independently versioned `pi-note` npm package. Its default extension
connects directly to the standalone Pinote HTTP service; only that service calls
`note`, never SQLite directly. The explicit local-only compatibility extension also
uses `note`. Tests need the checkout's own `.venv/bin/note` and exercise real Pi
loading and HTTP/stdio connections against temporary data. The full CI suite runs
once per pull request update. On pushes to `main`, the publish workflow calls that
same suite once before publishing; there is no
standalone push-triggered test run. The [package README](../pi/README.md#development-and-releases)
documents the one-time npm trusted-publisher setup and version-bump workflow.
