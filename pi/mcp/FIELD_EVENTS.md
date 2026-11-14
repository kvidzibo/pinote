# Field watchers

pi-note **0.40.0+** with **note 0.24.0+** runs independently enabled executables for
task-field changes on the **HTTP service machine**. No extra daemon or Pi-local
watcher is installed. The local-only extension and stdio service do not run watchers.

## Enable

Open **Settings → Footer fields → Watchers**. The fixed package `watchers/` folder
is scanned for executable `.mjs` files; discovery never executes or enables them.
Enable **GitHub PR**, or add a custom absolute executable path on the service
machine and enable it separately. Every change requires review and confirmation.
Watchers are trusted code, not sandboxed; enabling authorizes their alerts to
trigger the owning worker to investigate and fix the task within existing permissions.

The corresponding service `pi-note.json` setting is:

```json
{
  "fieldWatchers": [
    { "path": "/absolute/path/watcher.mjs", "enabled": true }
  ]
}
```

Update/restart the existing HTTP service and `/reload` Pi once after upgrading.
Subsequent watcher changes apply live. Disable a watcher to stop checks and hide
its results without changing task fields. Custom entries can also be removed;
the file is retained. At most 32 watchers may be configured. For overlapping
results, the first nonempty watcher result in configuration order supplies the
footer style; alerts remain independent.

`fieldHandler` is replaced, not run alongside the list. An old handler appears
disabled until explicitly enabled because the previous setting authorized only
notifications, not automatic worker actions. Saving watchers removes the old key.

The bundled [`watchers/github-pr.mjs`](../watchers/github-pr.mjs) handles `PR`
and ignores other fields. Copy it to a user-owned location before customization,
make it executable (`chmod u+x`), and ensure authenticated `gh` and Node are on the
**service's** PATH. For systemd, follow the [service PATH setup](README.md#run-continuously);
using an absolute Node path in `ExecStart` alone is insufficient for the watcher's
`#!/usr/bin/env node` interpreter. It accepts a GitHub PR URL or Markdown link, checks once, and
requests another check in 60 seconds. It warns on failing checks/conflicts and
strikes through merged PRs while keeping their links. Closed/merged PRs stop
polling; merging never completes the Pinote task. Passing means reported checks
passed, not that every review/branch-protection requirement is satisfied.

To support another field, add another executable using the contract below. Each
watcher receives all field events and returns `{}` for fields it does not handle.

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
  Watcher cursors, jobs and notices are independent; alert ownership is shared.
  It uses Node's built-in SQLite API; Node 22 may print its experimental warning.
- Monitoring continues without an open Pi session while the HTTP service runs.
  Deadlines survive restarts. A lease prevents overlapping normal execution by
  competing service processes; run one service/configuration per notes database.
- Initial activation reconstructs fields from durable history. Intake scans at
  most 25 history rows per tick and coalesces superseded pending changes before
  execution. This is a **current-field automation API**, not a lossless audit hook:
  intermediate values may never reach the script. Old migrated history without
  field snapshots cannot be reconstructed.
- In Pi's interactive terminal, execution failures produce one grouped notice:
  `Pinote watchers failing: GitHub PR [PR], Deploy [Build, URL].`
  It points to the actual service log on the **service machine**. Health is
  service-wide, grouped by watcher and affected field across tasks; long field
  lists show an additional count. Notices appear on connection and when the
  failure set changes, not on every retry. A final notice clears the failure set
  after recovery, disabling a watcher or removing its failing fields. Disconnects
  and older services are not treated as recovery. These notices use native Pi
  notifications only: no model turn, transcript entry, or model-context diagnostics.
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
- Pi triggers a worker turn once per current alert and persists receipts across
  reload/resume (latest 4,096 IDs per branch). Receipts accompany view reads so
  bounded 64-alert pages advance past delivered failures even if they persist.
  Busy workers defer delivery until
  idle, then refresh to verify ownership, selection and current status. An aborted
  run does not immediately drain deferred alerts. There is no launch of a closed
  Pi process; current alerts are delivered when its owning conversation reconnects.
  Older clients/services retain notification-only behavior until both are updated.
- Worker messages use fixed instructions plus explicitly untrusted observations;
  the worker must verify fresh task context and obey existing scope and approvals.
  Enabling never authorizes task selection/completion, PR merging or bypassing
  approvals. Current results reach each agent run through fresh task-scoped
  context; stale/unavailable checks are excluded. Oversized current results are
  omitted with a count, preserving the task first. Actionable results such as PR
  CI failures still use the separately enabled worker-alert behavior above.
- Only the latest current alert per field is retained, not an offline alert log.
  If a failure resolves while Pi is closed, it is not delivered later as a stale
  failure. Network recovery remains explicit through `/pinote` or a tool call.
- Newly enabled watchers reconstruct current fields from history independently.
  Disabling/removing clears their automation state; enabling again checks afresh.
  Editing the same file affects its next invocation, not stopped checks.
  Restoring an older notes backup can invalidate the cursor: stop the service and
  deliberately back up/reset its corresponding automation state before restarting.

Handlers run with the service user's permissions and inherited environment,
including available credentials. They are trusted code, **not sandboxed**. The
human-confirmed Watchers UI can configure executable paths; agent tools cannot.
The existing service log records each failed invocation with timestamp, watcher
name/ID, task ID, field name, a fixed safe reason, last successful check and next
retry. Reasons distinguish missing executables/interpreters, permissions, exit
failures (including interpreter/PATH exit 127), timeouts, output limits, invalid
results and reported unavailable data. No field values, raw exceptions, script
stdout/stderr or credentials are copied into diagnostics. Run the
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
