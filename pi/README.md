# pi-note

[npm](https://www.npmjs.com/package/pi-note) · [Pi package directory](https://pi.dev/packages/pi-note)

Shared [Pinote](https://github.com/kvidzibo/pinote) tasks and Markdown handoffs in Pi.
A dedicated extension connects directly to an authenticated **MCP Streamable HTTP**
service. No MCP gateway, VM-local Python installation, or network-mounted database
is needed.

```text
Host Pi ── Pinote extension ──┐
                             ├─ HTTPS → Pinote service → notes.db
VM Pi ──── Pinote extension ──┘
```

Compact suggestion and selected-task titles hide leading Markdown heading markers
(`# ` through `###### `); saved task text and
full Markdown previews keep the original source.

Tasks, tags, progress and handoff fields are shared. Selection and pending
suggestions belong to each Pi conversation/branch, not the HTTP connection.
Other tools continue running wherever Pi and their services run.

## Install

Requires **Pi 1.4.0+** and **Node.js 22.19+**. The service additionally needs
**Python 3.11+** and **note 0.12.0+**. Install and start the
[Pinote service](mcp/README.md) first, then on each client:

```sh
pi install npm:pi-note
# Or, from a checkout:
pi install ./pi
```

Set the endpoint and use the same private bearer token as the service before
starting Pi. Both read `PINOTE_TOKEN`, or a private owner-only `PINOTE_TOKEN_FILE`
(default `<Pi agent directory>/pinote-token`):

```sh
export PINOTE_URL=https://notes.example.net/mcp
# Load PINOTE_TOKEN from your private environment/secret manager; never commit it.
pi
```

The token must contain at least 32 non-whitespace characters. The default endpoint
is `http://127.0.0.1:8765/mcp`. Non-loopback HTTP requires the explicit
`PINOTE_ALLOW_HTTP=1` opt-in and a trusted private VPN; prefer HTTPS. Endpoint URLs
cannot contain credentials, query strings or fragments. Do not register this
service again through Pi's built-in MCP client: the extension owns the connection,
state routing, tools and UI.

## Use

Open **`/pinote`** for the searchable task list, newest-created first, with
**+ New task** as its first option. All search terms must match the title,
description, tag or numeric ID. Results show status and the current selection;
selection waits for fresh search results. Selected-task and pending-suggestion
actions follow the task results.
Press **F1** on a result to read its full title and text without selecting it.
Selecting a task starts it and returns to the unchanged prompt without another
confirmation. **Clear selection** leaves its progress unchanged.

**Preview** opens a scrollable, read-only document. **Insert task prompt…** reviews
and inserts into an empty editor only; it never submits or replaces a draft.
Creation, menu suggestion acceptance and shared changes require complete review,
then a separate Cancel-first confirmation. Menu completion also asks explicitly.
Footer double-click directly approves suggestion acceptance or completion;
completion requires idle Pi. Failed or uncertain
writes offer refresh/verification, never automatic replay.

Press **Tab** for **Settings**: **Agent guidance**, **Fields**, **Task offers**,
then **Footer layout**. **Tab** or **Escape** returns to tasks with the search
retained. Editors accept plain text or numbers, not JSON; validation retains the
draft. Cancelling a change's confirmation returns to its text draft. Values
are saved only after review and confirmation.

Menus use Pi's native inline components, themes and configured selection keys.
**Escape** goes back; **Ctrl+R** refreshes; page keys scroll lists and documents.
Small terminals show compact menus or ask you to enlarge the window before acting.
Fullscreen has a clickable footer: **▤** opens Pinote; single-click a task title
to preview, or double-click to complete immediately without another confirmation
(requires idle Pi). Single-click a suggestion title to preview it; double-click
to accept, start and select it immediately without another confirmation.
Regular mode shows status; `/pinote` provides all actions. No Kitty action handler
is needed.

Accepting a suggestion, selecting a different task, or creating and selecting one
renames the current Kitty tab to `[tag] task title` (tag omitted when unset),
using the footer's first-line title rather than the GUI launcher's shortened name.
Requires local Kitty with remote control enabled, `kitty` on PATH, and
`KITTY_LISTEN_ON` / `KITTY_WINDOW_ID`; SSH and other terminals are unchanged.
Rename failures warn without undoing selection. Completion and deselection leave
the tab name unchanged; reload/resume and external task edits do not rename it.

Completion keeps the conversation and editor, except for dedicated **Start in Kitty…**
sessions (see below). With an empty editor, **Ctrl+D**
(or your configured exit key) offers Cancel, Exit without completing, or Complete
task and exit. **`/new`** offers Cancel, Start new session without completing, or
Complete task and start new session. With no selected task, `/new` proceeds normally.
Completion requires idle Pi and a current displayed revision; failures keep the
current session open. `/quit` exits without completing.

Reload/resume restores the active branch's selection. Starting a new session
without completing retains the selection; completing starts it unselected.
Unrelated fresh launches start unselected.
Changing endpoints starts a separate selection namespace. Unsaved Pi sessions
cannot guarantee selection persistence.

With pi-note 0.41.0+ on both client and service, and note 0.25.0+, selecting a task
(including accepting a suggestion, creating one, or **Start in Kitty…**) appends
the actual Pi session ID to its persistent `pi-sessions` array, without duplicates.
Task reads and injected agent context include the array so later agents can locate
previous sessions on the machine that saved them. Reads, previews, reload/resume,
and carried selections do not append IDs; select the task in a new session to record it.
IDs are metadata only: transcripts are not uploaded, and unsaved/deleted sessions
may no longer be available. The array is separate from editable handoff fields.

The GTK app's **Start in Kitty…** action (note 0.13.0+) chooses a working directory
and opens a named tab with this task selected, without submitting a prompt.
In note 0.16.0+, it uses the tag's default folder when available, otherwise keeps
the directory chooser. Set or clear defaults in **Manage tags…**.
With note 0.15.0+ and pi-note 0.32.0+, successful selection prefills an empty Pi editor
with `is task clear?`. Configure `gui.kitty_start_prompt` in the
[GUI config](../docs/gui.md#gui-configuration), or set it to `""` to disable; existing
drafts are never replaced. The service needs pi-note 0.31.0+.
The one-shot `PINOTE_LAUNCH_TASK` environment handoff carries the task ID, displayed
revision and optional editor draft, never task text or tokens. The draft stays
client-local and is never sent to the service or persisted as launch state.
Only a fresh session can consume it. The service must share the GUI's database;
missing/stale revisions fail closed. Resume, reload and `/new` never replay the
handoff or replace another selection. Pi keeps its normal endpoint/token settings.
With pi-note 0.33.4+, completing the launched task from the menu or
**Complete task and exit** exits Pi directly, so Kitty closes its dedicated tab
(or the standalone window's last tab). Pinote itself never runs Git commands;
optional local completion hooks can briefly delay closing (see below).
This ownership survives `/reload`, but not `/new`, resume, fork, tree navigation
or process restart. Completing a different task or an externally completed task
does not close Pi; failed/uncertain completion stays open.

### Local completion event (pi-note 0.35.0+)

Trusted sibling extensions can listen on `pi.events` for `pinote:task-completed`:

```ts
pi.events.on('pinote:task-completed', (event) => {
  const { taskId, signal, waitUntil } = event as {
    taskId: number;
    signal: AbortSignal;
    waitUntil(work: Promise<unknown>): void;
  };
  waitUntil(Promise.resolve().then(() => doLocalWork(taskId, signal))); // Register before any await.
});
```

This local event fires exactly once only after this client's acknowledged **Done**
action clears a valid selected task, across menu, footer and exit/new-session paths.
`taskId` is the original positive safe-integer task ID, not the cleared selection.
External completions, notifications, clear-selection actions and failed/stale Done
attempts do not emit it. Pinote does not submit a model prompt for this event.

Pi's event bus is synchronous fire-and-forget: returning an async handler's promise
is insufficient. Call `waitUntil` during dispatch; late registrations are ignored.
Put potentially throwing work inside the registered promise, as above. Exceptions
thrown by the listener itself before registration are handled by Pi's own logger,
which may print their raw text; Pinote cannot intercept those bus errors.
All registered work is awaited outside Pinote's serial queue (so listeners may use
`pinote:query-current`) before Done returns or a launched session auto-exits.
Without registered work, completion proceeds immediately. Ordinary Done still
keeps the conversation open.

There is one fixed **25-second total deadline**, shared by all listeners. The signal
aborts on session lifetime cancellation, deadline, or hook settlement; listeners
must honor it and avoid blocking synchronous work. Timers cannot preempt JavaScript
that blocks the event loop. On runtime teardown, `signal.reason` carries Pi's
shutdown reason (`quit`, `reload`, `new`, `resume`, or `fork`). A listener with its
own awaited shutdown handler may finish bounded work on `quit`; other cancellation
still stops its work. Hook rejection, timeout or cancellation never undo an
acknowledged completion, invalidate its state, or retry remote writes. Registered
promise rejections and timeouts produce only a generic warning when UI is available;
Pinote does not display their error or response text. This is a trusted local extension API, not remote task
instructions or authorization to run models or external actions.

### Agent tools and context

The extension registers `pinote_search`, `pinote_get_task`, `pinote_get_current`,
`pinote_update_current`, `pinote_fields`, `pinote_tags`, and `pinote_propose`.
Default guidance suggests tasks only for substantial work requiring changes, not
questions, explanations, research, read-only inspection, or trivial edits.
For new tasks, `pinote_propose` requires a nonblank, single-line `title` of
1–60 Unicode characters, with optional multiline `description` and `tag`.
The service joins title and description with a blank line; the combined text must
fit 4,000 characters. Invalid input is rejected, never truncated. To suggest an
existing task, pass only `task_id`.

Suggestions do not create/start/select tasks until accepted in the UI. Reads by ID
do not change selection. Updates require the task's `expected_updated_at` revision;
concurrent edits are rejected rather than overwritten.

Fresh selected-task context and service guidance are read before every agent run.
Task text and handoff fields are untrusted data, not authorization. Failed reads
explicitly report unavailable context; they never reuse a cached task or claim no
task is selected. Tool results and injected context can reach your configured
model: do not put secrets in tasks.

External CLI/GTK/client edits refresh connected views through notifications.
After a network failure, use `/pinote` or a tool call to reconnect. Mutations are
**never automatically replayed**: a failed write may already have committed, so
read fresh state before retrying. Server restart loses HTTP sessions, not notes.
There is no offline write queue or database replication.

### Shared settings

Settings live in `pi-note.json` on the **service machine**, under its
`PI_CODING_AGENT_DIR` (default `~/.pi/agent`). The Pinote app edits prompts, injected
agent guidance and footer definitions with confirmation and revision checks.
A malformed configuration fails closed; fix it on the server rather than replacing
it with defaults. Task fields such as `PR`, `Worktree` and `Next` remain task data,
separate from global display settings. The remote **New session prompt** setting
is stored for compatibility; remote `/new` does not insert it. Selected-task previews
above the protocol's 20,000-character limit show explicit guidance to read through the
CLI/service instead of silently truncating.

### Field watchers (pi-note 0.40.0+)

Open **Settings → Fields → Watchers** to enable bundled watchers or add a
trusted executable on the service machine. Files in the packaged `watchers/`
folder are discovered automatically, but remain disabled until enabled explicitly.
Each watcher handles task-field changes and scheduled checks independently.

The bundled GitHub PR watcher triggers the owning Pi worker to investigate and fix
failed CI or merge conflicts. Repeated unchanged failures are deduplicated; busy
workers wait until idle and recheck current state before acting. Merged PRs use
the theme accent (default purple), retain their links and stop polling; tasks are not
completed. Requires authenticated `gh`, Node and **note 0.24.0+** on the service.
The **Forgejo PR** watcher supports configured HTTPS instances (or numeric
loopback HTTP) and service-side API tokens without `gh`; it alerts on failed CI and styles merged/closed PRs.
Forgejo's ambiguous mergeability flag stays pending rather than generating false
conflict alerts. GitHub and Forgejo links both support `#<number>` footer formats.
See [setup, configuration, script contract and safeguards](mcp/FIELD_EVENTS.md).

## Migration

Since pi-note 0.40.1, `/pinote` opens tasks directly and **Tab** opens settings.
Update both client and service for newest-created-first search results, then
`/reload` Pi.

With pi-note 0.41.1+ on client and service, watcher execution failures appear as
one terminal-only notice listing failing watchers and affected fields, with the
service log path for safe diagnostics. Repeated retries stay quiet; a changed
failure set or recovery updates the notice. These diagnostics never trigger a
model turn or enter model context; current actionable PR alerts remain separate.

Since pi-note 0.40.0, `fieldWatchers` replaces `fieldHandler`. Existing handlers
appear disabled and need explicit re-enabling: enabling now authorizes automatic
worker turns, not just notifications. Update/restart the service and `/reload` Pi.
Watcher changes then apply live; no extra service is installed.

Since pi-note 0.39.3, fullscreen suggestion-title double-click accepts immediately;
single-click still previews and menu acceptance still requires review/confirmation.
Update both client and service, then `/reload` Pi.

Since pi-note 0.39.2, fullscreen task-title double-click completes without another
confirmation; single-click still previews and menu completion still confirms.
Update the client and `/reload` Pi. The service must support footer double-click
(pi-note 0.39.1+).

Since pi-note 0.38.0, the default HTTP extension uses task-first navigation and
explicit completion/suggestion approval. Update the client and service together,
then `/reload`. The explicit local-only extension retains its existing menus.


Since pi-note 0.36.0, new-task proposals use `title` and optional `description`
instead of `text`, in both remote and local modes. Update clients and service
together, then `/reload` Pi. Stored tasks and pending suggestions are unchanged;
`task_id` proposals and the local-only `pinote_add` tool are unchanged.

Since pi-note 0.33.0, `/pinote` is the only slash command in both modes.
The `/pi-note` alias is removed; update saved shortcuts to `/pinote`.
The npm package name and `pi-note.json` configuration filename are unchanged.

1. Back up the service machine's Pinote data; keep `notes.db` local to that machine.
2. Start the standalone service against that same database and settings directory.
3. Remove Pinote's service entry and its unused package entry from the gateway
   configuration; preserve all other services/packages.
4. Remove the old gateway-dependent `exit-confirm.ts` companion and any old local
   `index.ts` extension from Pi's load list. Load this package once.
5. Finish active gateway jobs before reloading Pi. Configure each VM client with
   the remote endpoint and token, then select its task in `/pinote`.

Existing gateway selection entries are not imported; notes and handoff fields are
unchanged. Remote-safe Ctrl+D handling is built into this extension; the obsolete
gateway companion is removed. The existing
[local-only CLI extension](LOCAL.md) remains available explicitly for on-device
use, but must not be loaded alongside the HTTP extension.

## Development and releases

From the repository root:

```sh
uv sync --locked
npm --prefix pi ci --ignore-scripts
npm --prefix pi test
(cd pi && npm pack --dry-run)
```

Tests use the checkout's own `.venv/bin/note`, real HTTP/stdio servers and temporary
storage. UI validation must use Xvfb, a private D-Bus session and temporary app data.

The npm and Python packages are versioned independently. Bump npm with
`npm version patch|minor|major --no-git-tag-version` inside `pi/` and commit its
manifest and lockfile together. GitHub CI tests `main`, then publishes new npm
versions through OIDC trusted publishing; registry failures fail the workflow.
The trusted publisher is `kvidzibo/pinote`, workflow `publish.yml`, no environment.
Installation never edits personal Pi, shell, systemd or desktop configuration.
