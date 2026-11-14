# Pinote Node backend

Shared `note` CLI and one-request JSON bridge for Electron and the Pi service.
Uses the existing SQLite database and schema 8 unchanged; no data conversion.
Legacy Python/GTK can coexist through the same display lock.

Requires Linux, Node.js 22.19+, and util-linux `flock` on an absolute PATH.
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
dependencies. Use `backend/bin/note` as the service's `PINOTE_NOTE_COMMAND`.
Data remains in the same XDG directories; installation never changes live services
or desktop configuration. See [CLI usage](../docs/usage.md) and
[Electron setup](../docs/electron.md).

## Test

```sh
uv sync --locked                 # legacy Python reference, not runtime
npm --prefix backend run check
npm --prefix backend test
```

Tests use temporary databases and the checkout's own `.venv` for cross-language
parity. Help layout differs from argparse; use documented full option names
rather than abbreviated long options. Full integration and isolated UI validation:
[development guide](../docs/development.md).
