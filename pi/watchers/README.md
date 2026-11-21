# Pinote watchers

These scripts run on the **Pinote HTTP service host**, not in a Pi session or the Electron app. They live under `pi/` because the `pi-note` npm package ships both the service and the Pi extension.

The service discovers executable `.mjs` files in this directory. Bundled watchers are off by default; enable trusted scripts under **Settings → Footer fields → Watchers**. They run with the service user's permissions.

| Field watcher | Purpose |
| --- | --- |
| [GitHub PR](github-pr.mjs) | Check GitHub pull requests linked to a task. |
| [Forgejo PR](forgejo-pr.mjs) | Check pull requests on a trusted Forgejo instance. |

See the [field watcher contract](../mcp/FIELD_EVENTS.md) for inputs, outputs, configuration and testing. A field removal is **not** proof that a task was completed. For actions specific to Done, use Pinote's [task-completion events](../mcp/README.md#task-completion-events).
