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
[frozen Python-reference fixtures](../backend/tests/fixtures/python-reference/README.md)
to check migrations (schemas 0–8), a mutation sequence, a Python-written database,
and bridge snapshots without running Python. Reminder time-zone checks use fixed
past dates, which do not depend on the tzdb version bundled with Node.

The real Dunst test runs the Node CLI with temporary storage. It requires `dunst`,
`dunstify`, `dunstctl`, `dbus-send`, `dbus-daemon`, `xvfb-run`, and `xauth`.
Each test starts its own private D-Bus session and refuses to run outside `xvfb-run`.

In CI, `backend` runs checks, builds, and tests (including the package test) on
Node 22.19.0 and 24. `desktop` runs the real Dunst test on Node 24.

The `pi` job runs two shards on each Node version (22.19.0 and 24): shard 1
runs the long `tests/engine.test.ts` scenario alone; shard 2 runs every other unit
and real-loader test. Type checks run on both, and the package dry-run runs once per
Node version. To reproduce them in `pi/`:

```sh
node --test --experimental-strip-types tests/engine.test.ts
node --test --experimental-strip-types $(ls tests/*.test.ts test-load.ts | grep -vx tests/engine.test.ts)
```

The `electron` job runs on Node 24 at 1280×900 and 800×600 in parallel. Each job
runs the E2E scenario as three concurrent parts on separate Xvfb servers and
D-Bus sessions: `--part=1` is the lifecycle/recovery sequence; `--part=2` holds
the self-contained workflow checks; `--part=3` is
the editor autosave sequence, after the Watchers settings check. Without `--part`,
`tests/e2e.mjs` runs everything in one application.
Type/unit checks run once in the 800×600 job; packaged-app validation runs once in
the 1280×900 job. The packaged smoke test runs from a
temporary working directory with a private PATH and no Python executable.
Pass an unpacked app directory to `test:package` for relocation checks; copying
CI's root-owned SUID sandbox helper would lose its ownership, so CI tests it in place. No tests or display sizes are dropped;
parallel jobs trade additional runner setup for shorter elapsed CI time.

### macOS

The `macos` job checks basic macOS behavior on a disposable runner session; the
remaining suites, including the platform-neutral Pi unit tests, run only on Linux.
It runs the backend unit tests (skipping the non-UTF-8 file-name checks, which
macOS file systems reject), `electron/tests/macos-smoke.mjs` (task list, composer and Start in
Kitty from a built app) and `backend/tests/desktop/kitty-macos.e2e.ts` (new Kitty
window, reuse, and a Kitty opened by Launch Services). Hosted runners lack the
OpenGL 3.3 Kitty needs, so CI installs `backend/tests/desktop/kitty-stub.mjs` as
`/Applications/kitty.app`: it implements only the remote-control commands Pinote
uses. Both tests start apps and refuse to run without `CI` set.

## Electron frontend

The [Electron guide](electron.md) covers installation, state, recovery, packaging,
and limitations. These checks supplement the backend, Dunst, and Pi checks above.

Use Node.js 22.19+ (CI uses Node 24) and Electron runtime libraries:
GTK 3 (`libgtk-3`), NSS, ALSA, ATK/AT-SPI, CUPS, GBM/DRM, and X11 libraries.
End-to-end tests additionally need `xvfb-run`, `dbus-run-session`, `xauth`, `i3-wm`,
`xdotool`, and ImageMagick's `import` command (`imagemagick` on Debian/Ubuntu) for
native-menu screenshots. The Electron scenario saves
agent updates through the real CLI without making model requests.

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

`setup` prepares the bundled backend and explicitly downloads Electron;
`ci --ignore-scripts` installs locked npm packages (including esbuild's optional
native binary) without lifecycle scripts.
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

`backend/` is the only CLI and backend implementation. It uses Node/TypeScript and
`node:sqlite`, preserving the schema and history of the earlier Python
implementation. Build-time dependencies are bundled into
self-contained ES modules. An exclusive transaction on the empty SQLite file
`display.lock` serializes writers; the OS releases it on close or process death. CLI/bridge work runs in a worker thread in the same process,
without a writer supervisor, keeping signal handling responsive during SQLite
waits and large imports. A shared cancellation flag is checked before work and
commit; exclusive write transactions acquire reader exclusion up front, avoiding
a cancellable wait inside commit. No uncertain mutation is replayed.

Electron bundles the Node bridge outside ASAR and uses a separately installed
supported Node runtime.

`pi/` is the independently versioned `pi-note` npm package. Its extension
reads and writes tasks in-process through `note`, never SQLite directly; watcher
scheduling only reads the database's change counter. Tests use the checkout's own
`backend/bin/note` and exercise real Pi loading against temporary data. The full CI suite runs
once per pull request update. On pushes to `main`, the publish workflow calls that
same suite once before publishing; there is no
standalone push-triggered test run. The [package README](../pi/README.md#development-and-releases)
documents the one-time npm trusted-publisher setup and version-bump workflow.
