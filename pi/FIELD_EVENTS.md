# Field watchers

Independently enabled executables run for task-field and task changes. Since pi-note
**0.47.0**, the [Pinote desktop](../docs/electron.md#field-watchers) runs them while
it is open; Pi sessions read the saved results and receive the alerts. Pi itself
never runs watchers, and no extra daemon is installed. Requires **note 0.25.0+**
(task events: **0.27.0+**).

## Enable

In the desktop (Electron 0.19.0+), open **Menu → Watchers…**: choose a script,
tick the app, task and field events it listens for, name its fields, set its time
limit and cooldown, and fill in the parameters it declares. See [Watcher settings](#watcher-settings).

In Pi, open **Settings → Footer fields → Watchers** to enable, add or remove
watchers; events, fields and parameters are edited in the desktop only. The fixed package `watchers/` folder
is scanned for executable `.mjs` files; discovery never executes or enables them.
Enable **GitHub PR** or **Forgejo PR**, or add a custom absolute executable path
and enable it separately. Every change requires review and confirmation.
Watchers are trusted code, not sandboxed; enabling authorizes their alerts to
trigger the owning worker to investigate and fix the task within existing permissions.

The corresponding `pi-note.json` setting is:

```json
{
  "fieldWatchers": [
    { "path": "/absolute/path/watcher.mjs", "enabled": true }
  ]
}
```

Entries can also carry `appEvents`, `taskEvents`, `fieldEvents`, `fields`,
`timeoutSeconds`, `cooldownSeconds` and `params`; see [Watcher settings](#watcher-settings).

Restart the desktop and `/reload` Pi once after upgrading.
Subsequent watcher changes apply live. Disable a watcher to stop checks and hide
its results without changing task fields. Custom entries can also be removed;
the file is retained. At most 32 watchers may be configured. For overlapping
results, the first nonempty watcher result in configuration order supplies the
footer style; alerts remain independent.

`fieldHandler` is replaced, not run alongside the list. An old handler appears
disabled until explicitly enabled because the previous setting authorized only
notifications, not automatic worker actions. Saving watchers removes the old key.

The bundled [`watchers/github-pr.mjs`](watchers/github-pr.mjs) handles `PRs`
and legacy `PR`, ignoring other fields. Keep it in its package directory so its
shared parser remains available; add a separate executable for custom behavior.
If customizing a copy of the package, make the watcher executable
(`chmod u+x`), and ensure authenticated `gh` and Node 22.19+ are on the
**desktop's** PATH: the watcher's `#!/usr/bin/env node` interpreter is resolved there. `PRs` accepts one GitHub or Forgejo PR URL or Markdown link
per line (optional `- ` bullets), deduplicating up to 64 valid links. Each number
keeps its own link and status: green passing, red failed/conflicting, amber pending,
accent merged (default purple), or neutral closed/unavailable. Invalid lines are
ignored. Legacy `PR` accepts one URL/link and retains its single-result contract.

Batch checks run at most four `gh` calls at once, within a 25-second deadline.
Unavailable entries do not erase successful results or retrigger workers on
outage/recovery; they appear in grouped watcher diagnostics and retry. Each PR
has its own durable acknowledgement, shared across the built-in legacy/plural
aliases. New failures and confirmed recovery followed by failure alert again;
adding/removing other URLs does not repeat acknowledged failures. Edited fields
still require fresh checks. Legacy-only custom watchers keep independent alerts.
Alerts are grouped only when every included PR fits the message budget. PRs alerts include
PR numbers and URLs, within the notification budget. Checks repeat at the
watcher's [check interval](#forgejo-prs) (60 seconds by default) until all
entries are closed/merged; merging never completes the task.
Passing means reported checks passed, not that all review/protection rules passed.

## Watcher settings

Each watcher entry in `pi-note.json` can hold its own settings. Missing keys use
the script's declared defaults; the desktop writes only settings that differ from
them. Entries with these keys need pi-note 0.48.0+ and Electron 0.19.0+: earlier
versions reject them and stop loading watchers, so update both before changing
settings.

```json
{
  "path": "/absolute/path/deploy-status.mjs",
  "enabled": true,
  "appEvents": ["startup"],
  "taskEvents": ["completed"],
  "fieldEvents": ["changed"],
  "fields": ["Deploy"],
  "timeoutSeconds": 60,
  "cooldownSeconds": 300,
  "params": { "environment": "production", "timeout": 30 }
}
```

- `appEvents`: `startup` runs the script once each time the desktop starts; see
  [Startup event](#startup-event). Default: none.
- `taskEvents`: any of `created`, `edited`, `tagged`, `started`, `completed`,
  `removed`, `restored`, `scheduled`. Default: none.
- `fieldEvents`: any of `added`, `changed`, `removed`. Default: all three for a
  script without a parameter file, otherwise what the file declares.
- `fields`: for field events, the only fields that start the script; for task
  events, the task must have at least one of them. Empty means every field and task.
  The desktop suggests the configured footer fields; any name is accepted.
- `params`: values for the parameters the script declares, sent as `params` with
  every event.
- `timeoutSeconds`: each invocation's time limit, 1–600. Default: 30.
- `cooldownSeconds`: the least time between the starts of two invocations of this
  watcher, 0–86,400; 0 means none. Events and checks due meanwhile wait and run
  when it ends (field changes coalesce to the current value). Counted from the
  desktop's own invocations: a restart starts without one. Default: 0.

`appEvents`, `timeoutSeconds` and `cooldownSeconds` need pi-note 0.53.0+ and
Electron 0.26.0+; earlier versions reject entries that contain them. They are
written only when they differ from the script's defaults. Changing the time limit
or cooldown keeps saved results and applies to the next invocation.

Changing `fieldEvents`, `fields` or `params` checks that watcher's current fields
afresh, like disabling and enabling it; still failing checks can alert once more.

### Parameter file

A script declares its name, description, defaults and parameters in `<script name>.params.json`
beside it (`deploy-status.mjs` → `deploy-status.params.json`). The file is read,
never executed. All keys are optional:

```json
{
  "name": "Deploy status",
  "description": "Reports the deployment state of a task.",
  "appEvents": ["startup"],
  "timeoutSeconds": 60,
  "cooldownSeconds": 0,
  "taskEvents": ["completed"],
  "coalesceTaskEvents": false,
  "fieldEvents": ["changed"],
  "fields": ["Deploy"],
  "params": [
    { "key": "environment", "label": "Environment", "type": "select",
      "options": ["staging", "production"], "required": true },
    { "key": "timeout", "label": "Timeout seconds", "type": "number", "default": 30 },
    { "key": "recovery", "label": "Notify on recovery", "type": "boolean", "default": true }
  ]
}
```

Parameter `type` is `string`, `number`, `boolean`, `select` (with `options`),
`directory` (an absolute path) or `list` (rows of text `columns`, each with a
`key` and `label`). `help` adds a hint. The `description` is shown in the
desktop and in Pi's confirmation before enabling. A watcher with a missing `required`
parameter or an invalid parameter file cannot be enabled and does not run. At
most 32 parameters; the file is limited to 64 KiB. A custom script cannot take
the name of a bundled PR watcher.

`coalesceTaskEvents: true` (pi-note 0.55.0+; earlier versions reject the file) is
declared by the script only, not saved per entry. Task events queued behind the
cooldown or a running invocation then reach the script as one invocation with the
newest event. Events not yet read from history are not queued: history is read 25
events per second, so a larger burst can cause further invocations, as many as the
cooldown allows meanwhile. Use it when the script acts on current state, not on each
event.

### Task events

Task events are delivered once, only for changes made while the desktop is
running and the watcher is enabled. Earlier history is never replayed: a task
completed while the desktop was closed triggers nothing later. A failed
invocation is logged and not retried, and its result is not shown or sent to Pi;
the script does its work itself. The input replaces `field`, `value` and
`previousValue` with the task's handoff fields as they were just before the event:

```json
{
  "version": 1,
  "scope": "task",
  "eventId": "9123",
  "event": "completed",
  "taskId": 505,
  "fields": { "Worktrees": "/tmp/pinote-505-watchers" },
  "params": { "dir": "/tmp" }
}
```

### Startup event

A watcher with `appEvents: ["startup"]` runs once each time the desktop starts,
without a task. Enabling it while the desktop runs does not run it; the next start
does. Like task events, a failure is logged and not retried, and the result is not
shown or sent to Pi. `eventId` differs on each start:

```json
{ "version": 1, "scope": "app", "eventId": "startup:4f0c…", "event": "startup", "params": {} }
```

### Worktree cleanup

The bundled **Worktree cleanup** watcher runs when a task is completed in Pi, the
desktop or the CLI, for tasks that have a `Worktrees` field (one path per line;
pi-note 0.54.0+ — earlier versions read a single-path `Worktree` field). It runs
`git worktree remove` on each path that lies inside the **Worktrees directory**
parameter (default `/tmp`). Git refuses changed or untracked files, locked
worktrees and the main working tree; nothing is forced, no branch is deleted and
the directory is never scanned. **Ignored files are deleted with the worktree**:
dependencies and build output, but also a local `.env` or ignored backups. Keep
anything you need outside the worktree, or lock it with `git worktree lock`. Each recorded path is used exactly as saved. All paths share one
invocation time limit (default 120 seconds); a worktree not reached in time is kept. It is
disabled until you enable it and needs `git` on the desktop's `PATH`.

### Run command

The bundled **Run command** watcher (pi-note 0.55.0+, Electron 0.28.0+) runs one
trusted executable, without a shell, when the desktop starts and when a task is
completed. Set **Command** to its absolute path and add **Arguments**, one per row,
passed exactly as written. It runs from the command's directory with the desktop's
environment; its output is discarded and a nonzero exit is logged in `watchers.log`.
Defaults: 300-second time limit and 60-second cooldown. Completions during the
cooldown or a run are merged into one later run (`coalesceTaskEvents`). Completions
made while the desktop is closed are not replayed; the startup run covers them. The
command must finish within the time limit. When a run times out or is cancelled
(closing the desktop, changing the watcher), the command receives SIGTERM and, after
3 seconds, its process group SIGKILL; a command that starts processes in another
process group must stop them on SIGTERM. One configured command per watcher file: copy
the script and its parameter file to a custom path for another command.

For example, Command `/home/me/AI/settings/scripts/pi-updates.sh` with Argument
`--check` checks for Pi updates at startup and after completed tasks.

## Forgejo PRs

With pi-note **0.42.0+**, configure trusted instances in this machine's
`pi-note.json` (in `PI_CODING_AGENT_DIR`, default `~/.pi/agent`), then enable
**Forgejo PR** in Watchers:

```json
{
  "forgejoInstances": [
    { "url": "https://forgejo.example", "tokenEnv": "FORGEJO_TOKEN" }
  ]
}
```

`url` is an HTTPS instance base URL, optionally including its installation subpath
or port; it is not a repository or API URL. HTTP is also accepted for numeric
loopback hosts `127.0.0.1` and `[::1]` only. At most 32 instances are allowed.
`tokenEnv` names a variable in the desktop's environment holding a read-only API token
(with repository read access for private repositories). Omit it for anonymous
public access. Never put tokens in task fields, URLs or `pi-note.json`. Node must
be on the desktop's PATH; `gh` is not needed.

For a local repository such as
`http://127.0.0.1:3000/tomas/production-deploy`, configure the instance base
`http://127.0.0.1:3000`, not the repository path. Loopback refers to this machine. A sign-in-required instance needs `tokenEnv` even
for repository reads; set that variable in the desktop's environment.

Set `PRs` to `https://forgejo.example/owner/repo/pulls/123` or, for that local
instance, `http://127.0.0.1:3000/tomas/production-deploy/pulls/123`, one URL or
Markdown link per line. Since 0.43.0, GitHub and Forgejo URLs can share one field;
each watcher checks only its supported, trusted URLs. Legacy `PR` still accepts
one URL/link. Only explicitly configured instance URLs receive requests; credentials are scoped
to that instance, and API redirects are rejected. Both bundled watchers ignore
other providers' links, so they can be enabled together. Displaying a PR link or
formatting `<number>` does not authorize network access. After changing instances,
toggle the Forgejo watcher off/on to rescan existing fields. Restart the
desktop when changing its environment.

Forgejo checks the current head's latest commit statuses across all pages, including
Forgejo Actions jobs published as commit statuses. Failures trigger the owning
worker, unchanged alerts are deduplicated, and merged/closed PRs stop polling.
A mergeable PR with no reported statuses is passing ("has no checks") where the
repository's Actions are disabled. Where they are enabled, it is pending while an
Actions run for the head commit is queued or running, or the runs API is unavailable,
and passing once two consecutive checks of the same head find no run. External CI on a repository
without Actions shows passing until its first status. Passing does not imply that CI
ran, approvals were granted or branch protection was satisfied.

Forgejo's API reports only a boolean `mergeable`: `false` means a conflict, a merge
check in progress or an error, or a draft (WIP title). Pending statuses and drafts
stay pending ("is a draft"). Otherwise the first `mergeable=false` is pending
("checking mergeability"); if the next check on the same head still finds it, the PR
is a red `conflict` ("not mergeable") with an alert, like a GitHub conflict. These
one-time observations name the head they saw, so a new push restarts the confirmation.
Two consecutive checks that both catch a slow merge check can still raise a brief
false alert. Editing a field starts its checks afresh, so an unchanged conflict is
confirmed, and alerted, again.
Since pi-note 0.49.0, both PR watchers have a **Check interval (seconds)**
parameter (`interval`, default 60), set separately for each in the desktop's
Watchers settings. Values outside 10–86,400 use the nearest limit. Legacy `PR`
API/configuration errors retry after 120 seconds, or the interval when longer;
partial `PRs` batch errors retry with the field's regular check.

To support another field, add another executable using the contract below. A
watcher receives the field events selected in its [settings](#watcher-settings)
and returns `{}` for fields it does not handle. The desktop's Watchers settings
edit `forgejoInstances` as the Forgejo watcher's **Instances** parameter.

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
  "previousValue": null,
  "params": {}
}
```

- `added`, `changed`, `removed`: effective field-value changes from committed task
  history, including CLI/GUI/other-session writes. Completing, removing or scheduling
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
  "display": { "color": "error", "strikethrough": false },
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
| `items` | Up to 64 URL-keyed results; each has `url` (max 2,048) plus the properties above except nested `items` |

Since pi-note 0.43.0, the bundled `PRs` result has `state: "multiple"` and
`items: [{"url": "https://github.com/owner/repo/pull/123", "state": "passing",
"display": {"color": "success"}}]`. Top-level recheck settings control polling;
each item styles and notifies only its matching PR URL. The scheduler tracks each
item's notification key independently; message-only changes do not repeat alerts.
The bundled top-level batch notification remains available to handler consumers,
but is not used for PR acknowledgements. Error items may retain earlier keys,
but are never actionable or sent as current model observations.

Results replace previous results, not the original field value. Omitting a
notification clears the current alert. Identical notification key/message pairs
are deduplicated; a resolved condition followed by another failure alerts again.

## Delivery and reliability

- The scheduler stores its history cursor, scheduled checks, results and alert owner
  under `$XDG_STATE_HOME/pinote/field-events/<database-path-hash>/state.db` (default
  state home: `~/.local/state`). Keep this private and local, like `notes.db`.
  Watcher cursors, jobs and notices are independent; alert ownership is shared.
  It uses Node's built-in SQLite API; Node 22 may print its experimental warning.
- Monitoring continues without an open Pi session while the desktop runs, and
  pauses while it is closed; changes made meanwhile are picked up on its next start.
- The scheduler reads field history only after
  `notes.db` changes (checked in-process each second) and at least once a minute,
  rather than starting the CLI every second. It watches the default
  `$XDG_DATA_HOME/pinote/notes.db`: a `PINOTE_NOTE_COMMAND` wrapper selecting
  another database delays new events by up to a minute.
  Deadlines survive restarts. A lease prevents overlapping normal execution by
  competing processes; run one desktop per notes database.
- Initial activation reconstructs fields from durable history. Intake scans at
  most 25 history rows per tick and coalesces superseded pending changes before
  execution. This is a **current-field automation API**, not a lossless audit hook:
  intermediate values may never reach the script. Old migrated history without
  field snapshots cannot be reconstructed.
- In Pi's interactive terminal, execution failures produce one grouped notice:
  `Pinote watchers failing: GitHub PR [PR], Deploy [Build, URL].`
  It points to `watchers.log` beside the watcher state. Health is
  scheduler-wide, grouped by watcher and affected field across tasks; long field
  lists show an additional count. Notices appear on session start and when the
  failure set changes, not on every retry. A final notice clears the failure set
  after recovery, disabling a watcher or removing its failing fields. An unavailable
  CLI is not treated as recovery. These notices use native Pi
  notifications only: no model turn, transcript entry, or model-context diagnostics.
- Up to four watchers run at once; each watcher runs one invocation at a time, in
  turn between its task events and field checks, after its startup event. Each
  invocation has the watcher's time limit (30 seconds by default) and a
  combined 64 KiB stdout/stderr limit. On Unix, a timeout or cancellation sends
  SIGTERM to its process group and, if any of it remains, SIGKILL 3 seconds later. The
  invocation ends once the group is gone, or shortly after the SIGKILL when only
  unreaped members remain (pi-note 0.55.0+; earlier versions send SIGKILL at once). Scripts must not detach child processes. Invalid JSON/schema, nonzero
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
  Alerts for several PRs arrive as one bounded group with every per-PR receipt;
  delivery acknowledges all members together.
  Busy workers defer delivery until
  idle, then refresh to verify ownership, selection and current status. An aborted
  run does not immediately drain deferred alerts. There is no launch of a closed
  Pi process; current alerts are delivered when its owning conversation starts again.
- Worker messages use fixed instructions plus explicitly untrusted observations;
  the worker must verify fresh task context and obey existing scope and approvals.
  Enabling never authorizes task selection/completion, PR merging or bypassing
  approvals. Current results reach each agent run through fresh task-scoped
  context; stale/unavailable checks are excluded. Oversized current results are
  omitted with a count, preserving the task first. Actionable results such as PR
  CI failures still use the separately enabled worker-alert behavior above.
- Only current alerts are retained: one per PR, or one per other field, not an
  offline alert log.
  If a failure resolves while Pi is closed, it is not delivered later as a stale
  failure.
- Newly enabled watchers reconstruct current fields from history independently.
  Disabling/removing in `/pinote` settings clears their automation state; enabling
  again checks afresh. After a manual `pi-note.json` edit, the desktop's scheduler
  clears it on its next tick.
  Editing the same file affects its next invocation, not stopped checks.
  Restoring an older notes backup can invalidate the cursor: close the desktop and
  deliberately back up/reset its corresponding automation state before restarting.

Handlers run with the desktop user's permissions and inherited environment,
including available credentials. They are trusted code, **not sandboxed**. The
human-confirmed Watchers UI can configure executable paths; agent tools cannot.
`watchers.log` records each failed invocation with timestamp, watcher
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
does not execute handlers. `note events` lists task completions the same way, and
`note task-events` (0.27.0+) lists task changes as
`{"id":124,"taskId":402,"event":"completed","fields":{"PR":"…"}}`.
