# Pinote Node backend

Provides the `note` CLI used by Pi and a one-request JSON bridge for Electron.
Requires Node.js 22.19+ on Linux or macOS; Dunst is optional for notifications.

From the repository root:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
./backend/bin/note --help
npm install -g ./backend      # optional global CLI
(cd backend && npm pack)      # or a self-contained tarball
```

Builds bundle dependencies and license notices; the tarball has no runtime npm
dependencies. Installation never changes live services or desktop configuration.
Use documented full option names rather than abbreviated long options.

See [CLI usage](../docs/usage.md), [Electron setup](../docs/electron.md), and the
[development guide](../docs/development.md#development-and-tests) for tests.
