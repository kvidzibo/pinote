# Development and validation

[Quickstart](../README.md) · [CLI and data](usage.md) · [Electron](electron.md) · [Development](development.md)

Run checkout-relative commands from the repository root.

## Development and tests

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run check && npm --prefix backend run build
npm --prefix backend test
xvfb-run -a npm --prefix backend run test:desktop
npm --prefix pi ci --ignore-scripts && npm --prefix pi test
(cd pi && npm pack --dry-run)
npm --prefix backend run test:package
```

Backend tests use temporary databases and
[frozen reference fixtures](../backend/tests/fixtures/reference/README.md)
for migrations (schemas 0–8) and bridge snapshots.

The Dunst test (`test:desktop`) needs `dunst`, `dunstify`, `dunstctl`,
`dbus-send`, `dbus-daemon`, `xvfb-run`, and `xauth`. It starts a private D-Bus
session and refuses to run outside `xvfb-run`.

### CI

The full suite runs once per pull request update, and once before publishing on
pushes to `main`.

| Job | Node | Runs |
| --- | --- | --- |
| `backend` | 22.19.0, 24 | Checks, build, unit and package tests |
| `desktop` | 24 | Real Dunst test |
| `pi` | 22.19.0, 24 | Type checks, package dry-run, tests in two shards |
| `electron` | 24 | E2E at 1280×900 and 800×600, in three concurrent parts |
| `macos` | 24 | Backend unit tests and two smoke tests |

To reproduce the `pi` shards (the long engine scenario, then everything else) in `pi/`:

```sh
node --test --experimental-strip-types tests/engine.test.ts
node --test --experimental-strip-types $(ls tests/*.test.ts test-load.ts | grep -vx tests/engine.test.ts)
```

Electron E2E parts each use their own Xvfb server and D-Bus session: `--part=1`
is lifecycle/recovery, `--part=2` the workflow checks and `--part=3` editor
autosave. CI runs `tests/images-e2e.mjs` before part 2 and
`tests/watchers-e2e.mjs` before part 3; the flags do not include them. Without
`--part`, `tests/e2e.mjs` runs all three parts in one application. Type/unit
checks run in the 800×600 job and packaged-app validation in the 1280×900 job.
Pass an unpacked app directory to `test:package` for relocation checks; CI tests
in place because copying its root-owned SUID sandbox helper would lose ownership.

### macOS

The `macos` job covers basic behavior only; the other suites run on Linux. It runs
the backend unit tests (skipping non-UTF-8 file-name checks, which macOS file
systems reject), `electron/tests/macos-smoke.mjs` (task list, composer and Start
in Kitty from a built app) and `backend/tests/desktop/kitty-macos.e2e.ts` (new
Kitty window, reuse, and a Kitty opened by Launch Services). Hosted runners lack
the OpenGL 3.3 Kitty needs, so CI installs `backend/tests/desktop/kitty-stub.mjs`
as `/Applications/kitty.app`; it implements only the remote-control commands
Pinote uses. Both tests start apps and refuse to run without `CI` set.

## Electron frontend

Use Node.js 22.19+ and Electron's runtime libraries: GTK 3 (`libgtk-3`), NSS,
ALSA, ATK/AT-SPI, CUPS, GBM/DRM, and X11 libraries. End-to-end tests also need
`xvfb-run`, `dbus-run-session`, `xauth`, `i3-wm`, `xdotool`, and ImageMagick's
`import` (`imagemagick` on Debian/Ubuntu). They make no model requests.

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix pi ci --ignore-scripts
npm --prefix electron ci --ignore-scripts
npm --prefix electron run setup
xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- sh -c 'npm --prefix electron run check && npm --prefix electron test && npm --prefix electron run test:e2e'
xvfb-run -a -s '-screen 0 800x600x24' dbus-run-session -- npm --prefix electron run test:e2e
# Focused saved-fields/session-ID preview check; prints its /tmp screenshot path:
xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- npm --prefix electron run test:e2e -- --handoff-only
npm --prefix electron run build
npm --prefix electron run package
xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- npm --prefix electron run test:package
```

`ci --ignore-scripts` installs locked npm packages without lifecycle scripts;
`setup` prepares the bundled backend and downloads Electron.

- Always use Xvfb and a private D-Bus session, never the actual desktop. The
  harness uses its own HOME/XDG directories and private i3 socket, and clears
  inherited i3/Kitty sockets.
- Test screenshots stay in temporary directories; do not commit them or attach
  them to PRs.
- **Sandboxing must stay enabled.** If Ubuntu AppArmor restricts unprivileged user
  namespaces, CI provisions `chrome-sandbox` as root-owned, mode 4755, on its
  **ephemeral runner**, including the packaged copy. This is not permission to use
  `--no-sandbox`, disable security sysctls, or modify a user's machine
  configuration as a test workaround.

## Architecture and integration

- `backend/` is the only CLI and backend implementation: Node/TypeScript on
  `node:sqlite`, bundled into self-contained ES modules. Its schema, migrations
  and history format are frozen: existing databases depend on them.
- Writers are serialized by an exclusive transaction on the empty SQLite file
  `display.lock`, which the OS releases on close or process death. CLI/bridge work
  runs in a worker thread so signals stay responsive during SQLite waits and
  large imports. A cancellation flag is checked before work and commit; no
  uncertain mutation is replayed.
- Electron bundles the Node bridge outside ASAR and uses a separately installed
  Node runtime.
- `pi/` is the independently versioned `pi-note` npm package. It reads and writes
  tasks through `note`, never SQLite directly; watcher scheduling only reads the
  database's change counter. Tests use the checkout's `backend/bin/note` and real
  Pi loading against temporary data. See its
  [release workflow](../pi/README.md#development-and-releases).
