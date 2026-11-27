# Pinote Node backend

Provides the `note` CLI used by Pi and a one-request JSON bridge for Electron.
Preserves the schema-8 database and history of the earlier Python implementation;
no data conversion is needed.

Requires Node.js 22.19+ on Linux or macOS. Local reminder times use Node's bundled
IANA time zone data.
Dunst is optional for notifications. Electron bundles the bridge but requires
external Node; there is no automatic Python fallback.

From the repository root:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
./backend/bin/note --help
# Optional global CLI, or transfer the self-contained tarball:
npm install -g ./backend
(cd backend && npm pack)
```

Builds bundle dependencies and license notices; the tarball has no runtime npm
dependencies. Use `backend/bin/note` directly or install it on `PATH`.
Data remains in the same XDG directories; installation never changes live services
or desktop configuration. See [CLI usage](../docs/usage.md) and
[Electron setup](../docs/electron.md).

## Test

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run check && npm --prefix backend run build
npm --prefix backend test
xvfb-run -a npm --prefix backend run test:desktop
npm --prefix backend run test:package
```

Tests use temporary databases. Use documented full option names rather than
abbreviated long options. See the [development guide](../docs/development.md#development-and-tests)
for fixtures, desktop prerequisites, and integration checks.
