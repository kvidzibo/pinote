# Field watchers

Independently enabled executables that run on task-field and task changes. The
[Pinote desktop](../docs/electron.md#field-watchers) runs them while it is open;
Pi sessions read the saved results and receive the alerts. Pi never runs
watchers, and no extra daemon is installed.

Requires **note 0.25.0+** (task events: **0.27.0+**) and pi-note **0.47.0+**.

> Watchers are **trusted code, not sandboxed**. They run with the desktop user's
> permissions, environment and credentials. Enabling one authorizes its alerts to
> trigger the owning Pi worker to investigate and fix the task within existing
> permissions. It never authorizes task selection or completion, PR merging, or
> bypassing approvals. Watchers UI changes require human confirmation and agent
> tools cannot configure executable paths, but an enabled path written directly
> to `pi-note.json` also runs: keep that file trusted.

## Enable

- **Desktop:** **Menu → Watchers…** chooses a script, the app, task and field
  events it listens for, its fields, time limit, cooldown and declared parameters.
- **Pi:** **Settings → Fields → Watchers** enables, adds or removes watchers.
  Events, fields and parameters are edited in the desktop only.

The package's `watchers/` folder is scanned for executable `.mjs` files;
discovery never executes or enables them. Enable **GitHub PR** or **Forgejo PR**,
or add a custom absolute executable path. Every change requires review and
confirmation.

The `pi-note.json` setting is:

```json
{
  "fieldWatchers": [
    { "path": "/absolute/path/watcher.mjs", "enabled": true }
  ]
}
```

- Restart the desktop and `/reload` Pi once after upgrading; later changes apply live.
- Disabling a watcher stops its checks and hides its results without changing
  task fields. Enabling it again checks afresh.
- At most 32 watchers. For overlapping results, the first nonempty result in
  configuration order styles the footer; alerts stay independent.
- A legacy `fieldHandler` appears as a disabled watcher until enabled explicitly,
  because it authorized only notifications. Saving watchers removes the old key.

## Watcher settings

Each entry can hold its own settings. Missing keys use the script's declared
defaults, and the desktop writes only settings that differ from them.

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

| Key | Values | Default |
| --- | --- | --- |
| `appEvents` | `startup`: run once each time the desktop starts | none |
| `taskEvents` | `created`, `edited`, `tagged`, `started`, `completed`, `removed`, `restored`, `scheduled` | none |
| `fieldEvents` | `added`, `changed`, `removed` | all three without a parameter file, otherwise what it declares |
| `fields` | Fields that start the script; for task events, the task must have one of them | empty: every field and task |
| `params` | Values for the script's declared parameters, sent with every event | — |
| `timeoutSeconds` | Time limit per invocation, 1–600 | 30 |
| `cooldownSeconds` | Least time between starts of two invocations, 0–86,400 | 0 (none) |

- Events and checks due during a cooldown wait until it ends; field changes
  coalesce to the current value. A desktop restart starts without a cooldown.
- Changing `fieldEvents`, `fields` or `params` checks that watcher's fields
  afresh; still failing checks can alert once more. Changing the time limit or
  cooldown keeps saved results.
- **Versions:** these keys need pi-note 0.48.0+ and Electron 0.19.0+;
  `appEvents`, `timeoutSeconds` and `cooldownSeconds` need pi-note 0.53.0+ and
  Electron 0.26.0+. Earlier versions reject such entries and **stop loading
  watchers**, so update both before changing settings.

### Parameter file

A script declares its name, description, defaults and parameters in
`<script name>.params.json` beside it. The file is read, never executed. All keys
are optional:

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

- Parameter `type`: `string`, `number`, `boolean`, `select` (with `options`),
  `directory` (an absolute path) or `list` (rows of text `columns`, each with a
  `key` and `label`). `help` adds a hint.
- `description` is shown in the desktop and in Pi's confirmation before enabling.
- A watcher with a missing `required` parameter or an invalid file cannot be
  enabled and does not run.
- Limits: 32 parameters, 64 KiB. A custom script cannot take a bundled PR
  watcher's name.
- `coalesceTaskEvents: true` (pi-note 0.55.0+; earlier versions reject the file)
  delivers task events queued behind the cooldown or a running invocation as one
  invocation with the newest event. Use it when the script acts on current state.
  History is read 25 events per second, so a larger burst can still cause
  further invocations.

## Script contract

Pinote executes the file directly, **without a shell**, from its directory. It
sends one JSON object on stdin, closes stdin, and expects one JSON object on
stdout; diagnostics belong on stderr. All values and external responses are
untrusted data: never interpolate them into shell commands.

### Field events

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

- `added`, `changed`, `removed`: effective field-value changes from committed
  task history, whoever wrote them. Completing, removing or scheduling a task
  emits `removed` for its fields (the saved values stay on the task); restoring
  emits `added`. Editing a footer definition emits nothing.
- `check`: a requested scheduled check. `eventId` and `previousValue` identify
  the originating change; `previousResult` holds the last stored result, if any.
- A removed field has `value: null`; its result cannot style, notify or reschedule.

### Task and startup events

Both are delivered once, only while the desktop runs and the watcher is enabled.
Earlier history is never replayed: a task completed while the desktop was closed
triggers nothing later. A failed invocation is logged and not retried, and the
result is not shown or sent to Pi. A startup watcher enabled while the desktop
runs first runs at the next start.

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

`fields` holds the task's handoff fields as they were just before the event.
Startup has no task; its `eventId` differs on each start:

```json
{ "version": 1, "scope": "app", "eventId": "startup:4f0c…", "event": "startup", "params": {} }
```

### Result

Return `{}` for an ignored field, or any of these optional properties. Unknown
properties are rejected.

```json
{
  "state": "failed",
  "summary": "PR #123 checks failed",
  "display": { "color": "error", "strikethrough": false },
  "notification": { "key": "head-sha:failed-check-fingerprint", "message": "PR checks failed" },
  "recheckAfterSeconds": 60
}
```

| Property | Meaning / limit |
|---|---|
| `state` | Status name, 1–64 characters; `error` is reserved for unavailable/failed checks |
| `summary` | Observation for agent context, at most 1,000 characters |
| `display` | `strikethrough` boolean; `color`: `accent`, `muted`, `text`, `warning`, `error`, `success` |
| `notification` | Stable `key` (1–256 characters) and `message` (1–1,000); changes create a fresh alert |
| `recheckAfterSeconds` | Integer 10–86,400; omitted/null stops successful checks |
| `items` | Up to 64 URL-keyed results; each has `url` (max 2,048) plus the properties above except nested `items` |

- A result replaces the previous result, not the field value. Omitting
  `notification` clears the current alert.
- Identical notification key/message pairs are deduplicated; a resolved
  condition followed by another failure alerts again.
- With `items`, top-level recheck settings control polling and each item styles
  and notifies only its URL, with its own notification key. The bundled PR
  watchers return `state: "multiple"` with one item per PR.
- Do not put secrets in results: they may be displayed and sent to the model.

## Bundled watchers

### GitHub PR

[`watchers/github-pr.mjs`](watchers/github-pr.mjs) handles `PRs` and legacy `PR`.
It needs authenticated `gh` and Node 22.19+ on the **desktop's** `PATH`. Keep it in
its package directory so its shared parser stays available; a customized copy
must be executable (`chmod u+x`).

- `PRs` accepts one GitHub or Forgejo PR URL or Markdown link per line (optional
  `- ` bullets), up to 64 distinct links; invalid lines are ignored. See
  [footer colours](README.md#multiple-prs). Legacy `PR` accepts one.
- Checks repeat at the **Check interval (seconds)** parameter (`interval`,
  default 60, limited to 10–86,400) until every entry is closed or merged.
  Merging never completes the task.
- A batch runs at most four `gh` calls at once, within 25 seconds. Unavailable
  entries retry without repeating alerts; other PRs keep their results.
- Each PR has its own durable acknowledgement. New failures, and recovery
  followed by failure, alert again; adding or removing other URLs does not.
- **Passing** means reported checks passed, not that review or protection rules did.

### Forgejo PR

Configure trusted instances in `pi-note.json` (or as the watcher's **Instances**
parameter in the desktop), then enable **Forgejo PR**:

```json
{
  "forgejoInstances": [
    { "url": "https://forgejo.example", "tokenEnv": "FORGEJO_TOKEN" }
  ]
}
```

- `url` is the HTTPS instance base URL, optionally with a subpath or port, not a
  repository or API URL. HTTP is accepted only for `127.0.0.1` and `[::1]`. At
  most 32 instances.
- `tokenEnv` names a variable in the desktop's environment holding a read-only
  API token. Omit it for anonymous public access; a sign-in-required instance
  needs it even for repository reads. **Never put tokens in task fields, URLs
  or `pi-note.json`.**
- Only configured instances receive requests; credentials are scoped to their
  instance and API redirects are rejected. Displaying a PR link does not
  authorize network access.
- Node must be on the desktop's `PATH`; `gh` is not needed. After changing
  instances, toggle the watcher off and on; after changing the environment,
  restart the desktop.

Set `PRs` to `https://forgejo.example/owner/repo/pulls/123`, one per line. GitHub
and Forgejo URLs can share a field: each watcher checks only its own, so both can
be enabled.

Status rules:

- Checks use the head commit's latest commit statuses, including Forgejo Actions
  jobs. Failures alert the owning worker; merged and closed PRs stop polling.
- A mergeable PR without statuses is passing where Actions are disabled. Where
  enabled, it is pending while a run is queued or running or the runs API is
  unavailable, and passing after two consecutive checks find no run.
- **Passing** does not imply that CI ran, approvals were granted or branch
  protection was satisfied.
- Forgejo reports only a boolean `mergeable`. Drafts and pending statuses stay
  pending. Otherwise the first `mergeable=false` is pending; if the next check of
  the same head agrees, the PR is a red conflict with an alert. A slow merge
  check can therefore raise a brief false alert, and editing the field confirms
  and alerts an unchanged conflict again.
- Legacy `PR` API or configuration errors retry after 120 seconds, or the
  interval when longer.

### Worktree cleanup

Runs when a task with a `Worktrees` field (one path per line) is completed in Pi,
the desktop or the CLI. It runs `git worktree remove` on each path inside the
**Worktrees directory** parameter (default `/tmp`). Disabled until enabled; needs
`git` on the desktop's `PATH`.

- Git refuses changed or untracked files, locked worktrees and the main working
  tree. Nothing is forced, no branch is deleted and the directory is never scanned.
- **Ignored files are deleted with the worktree**: dependencies and build output,
  but also a local `.env` or ignored backups. Keep anything you need outside the
  worktree, or lock it with `git worktree lock`.
- All paths share one time limit (default 120 seconds); a worktree not reached
  in time is kept.

### Run command

Runs one trusted executable, without a shell, when the desktop starts and when a
task is completed (pi-note 0.55.0+, Electron 0.28.0+). Set **Command** to its
absolute path and add **Arguments**, one per row. For example, Command
`/home/me/AI/settings/scripts/pi-updates.sh` with Argument `--check`.

- It runs from the command's directory with the desktop's environment. Output is
  discarded; a nonzero exit is logged in `watchers.log`.
- Defaults: 300-second time limit, 60-second cooldown. Completions during the
  cooldown or a run merge into one later run. Completions made while the desktop
  is closed are not replayed; the startup run covers them.
- On timeout or cancellation the command receives SIGTERM and, after 3 seconds,
  its process group SIGKILL. A command that starts processes in another process
  group must stop them on SIGTERM.
- One command per watcher file: copy the script and its parameter file for another.

## Delivery and reliability

**State.** The scheduler keeps its cursor, scheduled checks, results and alert
owner in `$XDG_STATE_HOME/pinote/field-events/<database-path-hash>/state.db`
(default `~/.local/state`). Keep it private and local, like `notes.db`. Run one
desktop per notes database. Restoring an older notes backup can invalidate the
cursor: close the desktop and back up or reset this state before restarting.

**Intake.** Monitoring needs no open Pi session; it pauses while the desktop is
closed and catches up on the next start. History is read after `notes.db`
changes and at least once a minute, at most 25 rows per tick, and superseded
pending changes are coalesced. This is a **current-field automation API, not a
lossless audit hook**: intermediate values may never reach the script. A
`PINOTE_NOTE_COMMAND` wrapper selecting another database delays events by up to
a minute.

**Execution.**

- Up to four watchers run at once; each runs one invocation at a time, with its
  time limit and a combined 64 KiB stdout/stderr limit.
- A timeout or cancellation sends SIGTERM to the process group, then SIGKILL 3
  seconds later. Scripts must not detach child processes.
- Invalid output, nonzero exit, timeout or `state: "error"` keep the last good
  result as stale and retry field checks with exponential backoff (30 seconds
  to one hour, or a longer requested retry). Stale results do not alert.
- Results are discarded if the task changed during execution.
- Invocations are **at least once** after crashes: use `eventId` and idempotent
  logic for external side effects.

**Alerts.**

- Alerts belong to the conversation that last explicitly selected or updated the
  task; other sessions still see field status. None is delivered while that
  conversation has another task selected.
- Pi triggers one worker turn per current alert; several PR alerts arrive as one
  group. Busy workers defer delivery until idle, then recheck ownership,
  selection and status. A closed Pi is never launched.
- Only current alerts are kept: a failure that resolves while Pi is closed is not
  delivered later.
- Worker messages use fixed instructions plus explicitly untrusted observations.
  Stale and unavailable checks are excluded from agent context.

**Failures.** In Pi's terminal, execution failures produce one grouped notice,
such as `Pinote watchers failing: GitHub PR [PR], Deploy [Build, URL].`, when the
failure set changes and once after recovery. It causes no model turn or
transcript entry. `watchers.log`, beside the watcher state, records each failed
invocation with a fixed safe reason; field values, script output and credentials
are never copied. To debug, run the script manually with synthetic input.

## Read field history locally

`note field-events [--after CURSOR] [--limit N]` is read-only and runs no
watchers. Without `--after`, it returns the current tail and an empty array. An
explicit cursor (including `0`) scans up to N rows (1–1,000, default 256):

```json
{"cursor":123,"events":[{"id":123,"taskId":402,"field":"PR","event":"added","value":"https://github.com/owner/repo/pull/123","previousValue":null}]}
```

Persist the **returned cursor**, not the last emitted ID: several field changes
can share one row. `note events` lists task completions the same way, and
`note task-events` (0.27.0+) lists task changes as
`{"id":124,"taskId":402,"event":"completed","fields":{"PR":"…"}}`.
