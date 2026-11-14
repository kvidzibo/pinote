# Field-event handler

pi-note **0.38.0+** with **note 0.24.0+** can run one executable for all task-field
changes. This is opt-in, on the **HTTP service machine**. No extra daemon or Pi-local
watcher is installed. The local-only extension and stdio service do not run handlers.

## Enable

Create a trusted executable with a shebang, then add its absolute path to the
service's `pi-note.json`, preserving existing settings:

```json
{
  "fieldHandler": "/absolute/path/field-events.mjs"
}
```

Restart the existing Pinote HTTP service; update clients and `/reload` Pi for alerts
and footer styling. Removing the setting or setting it to `null`, then restarting,
disables execution and hides automation results without modifying task fields.
Scripts and settings are never installed or enabled automatically.

The bundled [`examples/field-events.mjs`](../examples/field-events.mjs) handles `PR`
and ignores other fields. Copy it to a user-owned location before customization,
make it executable (`chmod u+x`), and ensure authenticated `gh` and Node are on the
**service's** PATH. It accepts a GitHub PR URL or Markdown link, checks once, and
requests another check in 60 seconds. It warns on failing checks/conflicts and
strikes through merged PRs while keeping their links. Closed/merged PRs stop
polling; merging never completes the Pinote task. Passing means reported checks
passed, not that every review/branch-protection requirement is satisfied.

To support another field, add another branch to this same file. No registry or
plugin package is needed.

## Script contract

Pinote executes the file directly, **without a shell**, from its containing
directory. It sends one JSON object on stdin, closes stdin, and expects one JSON
object on stdout. Diagnostics belong on stderr. All values and external responses
are untrusted data; never interpolate them into shell commands.

```json
{
  "version": 1,
  "eventId": "123:PR",
  "event": "added",
  "taskId": 402,
  "field": "PR",
  "value": "https://github.com/owner/repo/pull/123",
  "previousValue": null
}
```

- `added`, `changed`, `removed`: effective field-value changes from committed task
  history, including CLI/GUI/other-client writes. Completing, removing or scheduling
  a task removes its effective fields; restoring/reactivating adds them again.
  Editing a global footer definition does **not** emit a task-field event.
- `check`: a requested scheduled check. `eventId` and `previousValue` still identify
  the originating change; `previousResult` contains the last stored result, if any.
- A removed field has `value: null`. Its handler result cannot style, notify or
  reschedule it. Removed/replaced inputs invalidate old results and alerts.

Return `{}` for an ignored field, or:

```json
{
  "state": "failed",
  "summary": "PR #123 checks failed",
  "display": { "color": "warning", "strikethrough": false },
  "notification": { "key": "head-sha:failed-check-fingerprint", "message": "PR checks failed" },
  "recheckAfterSeconds": 60
}
```

All result properties are optional. Unknown properties are rejected.

| Property | Meaning / limit |
|---|---|
| `state` | Status name, 1–64 characters; `error` is reserved for unavailable/failed checks |
| `summary` | Observation for agent context, at most 1,000 characters |
| `display` | `strikethrough` boolean; `color`: `accent`, `muted`, `text`, `warning`, `error`, `success` |
| `notification` | Stable `key` (1–256 characters) and `message` (1–1,000); changes create a fresh alert |
| `recheckAfterSeconds` | Integer 10–86,400; omitted/null stops successful checks |

Results replace previous results, not the original field value. Omitting a
notification clears the current alert. Identical notification key/message pairs
are deduplicated; a resolved condition followed by another failure alerts again.

## Delivery and reliability

- The service stores its history cursor, scheduled checks, results and alert owner
  under `$XDG_STATE_HOME/pinote/field-events/<database-path-hash>/state.db` (default
  state home: `~/.local/state`). Keep this private and local, like `notes.db`.
  It uses Node's built-in SQLite API; Node 22 may print its experimental warning.
- Monitoring continues without an open Pi session while the HTTP service runs.
  Deadlines survive restarts. A lease prevents overlapping normal execution by
  competing service processes; run one service/configuration per notes database.
- Initial activation reconstructs fields from durable history. Intake scans at
  most 25 history rows per tick and coalesces superseded pending changes before
  execution. This is a **current-field automation API**, not a lossless audit hook:
  intermediate values may never reach the script. Old migrated history without
  field snapshots cannot be reconstructed.
- One handler runs at a time. Each invocation has a 30-second deadline and a
  combined 64 KiB stdout/stderr limit. On Unix, cancellation kills its process
  group. Scripts must not detach child processes. Invalid JSON/schema, nonzero
  exit, timeout or `state: "error"` preserve the last good result as stale and
  retry with exponential backoff (30 seconds to one hour, or a longer requested
  retry). First-check failure appears as unavailable. Stale results don't alert.
- Results are discarded if the task changed during execution, including
  remove/re-add of the same value. Durable intake then reconciles new input.
  Handler invocations are **at least once** after crashes: use `eventId` and
  idempotent logic for external side effects; exactly-once execution is not promised.
- Alerts belong to the conversation that last explicitly selected or updated the
  task. For an unowned task, the first selected-task view claims alerts. Other
  sessions still see shared field status. Explicitly selecting the task reclaims
  ownership. No alert is delivered while that conversation has another task selected.
- Pi shows an alert once and persists receipts across reload/resume (latest 4,096
  IDs per branch). Current results reach the next agent run through fresh,
  task-scoped context. Duplicate field values are not repeated; results exceeding
  the context budget are omitted with a count, preserving the complete task first.
  **No prompt submission, model wake-up, task selection or
  completion is authorized by a handler result.**
- Only the latest current alert per field is retained, not an offline alert log.
  If a failure resolves while Pi is closed, it is not delivered later as a stale
  failure. Network recovery remains explicit through `/pinote` or a tool call.
- Changing the configured handler path resets automation state and reconstructs
  history; editing the same file affects its next invocation, not stopped checks.
  Restoring an older notes backup can invalidate the cursor: stop the service and
  deliberately back up/reset its corresponding automation state before restarting.

Handlers run with the service user's permissions and inherited environment,
including available credentials. They are trusted code, **not sandboxed**. The
remote UI and agent tools cannot configure executable paths. Service logs report
failures generically; script output and stderr are not copied into logs. Run the
script manually with synthetic input when debugging; don't put secrets in results,
which may be displayed and sent to the configured model.

## Read field history locally

`note field-events [--after CURSOR] [--limit N]` is read-only. Without `--after`, it
returns the current tail and an empty array. An explicit cursor (including `0`)
scans up to N durable rows, advancing even across unrelated events. Limits are
1–1,000 rows, default 256; several field changes can share one event-row ID:

```json
{"cursor":123,"events":[{"id":123,"taskId":402,"field":"PR","event":"added","value":"https://github.com/owner/repo/pull/123","previousValue":null}]}
```

Persist the **returned cursor**, not just the last emitted field ID. Cursors must
be nonnegative safe integers and cannot be ahead of current history. This command
does not execute handlers or change the existing completion-only `/events` stream.
