# Pinote watchers

The Electron desktop runs these scripts while open. Pi and the HTTP service can observe results but do not execute scripts. Electron packages executable copies outside its application archive.

Pinote discovers executable `.mjs` files in this directory. Bundled watchers are off by default; enable trusted scripts under **Settings → Footer fields → Watchers**. They run with the desktop user's permissions.

| Field watcher | Purpose |
| --- | --- |
| [GitHub PR](github-pr.mjs) | Check GitHub pull requests linked to a task. |
| [Forgejo PR](forgejo-pr.mjs) | Check pull requests on a trusted Forgejo instance. |

See the [field watcher contract](../pi/mcp/FIELD_EVENTS.md) for inputs, outputs, configuration and testing. A field removal is **not** proof that a task was completed. For actions specific to Done, use Pinote's [task-completion events](../pi/mcp/README.md#task-completion-events).
