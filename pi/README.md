# pi-note

[npm](https://www.npmjs.com/package/pi-note) · [Pi package directory](https://pi.dev/packages/pi-note)

[Pinote](https://github.com/kvidzibo/pinote) tasks and Markdown handoffs in Pi:
a task footer, the `/pinote` menu, agent tools and fresh task context for every
run. The extension reads and writes this machine's notes in-process through the
`note` CLI. There is no service, token or network listener.

Compact suggestion and selected-task titles hide leading Markdown heading markers
(`# ` through `###### `); saved task text and
full Markdown previews keep the original source.

Tasks, tags, progress and handoff fields are shared with the Pinote desktop, the
CLI and other Pi sessions. Selection and pending suggestions belong to each Pi
conversation/branch. Watcher results refresh normally; a change to the poll
timestamp alone does not add another task-context update to the model conversation.

## Install

Requires **Pi 1.4.0+**, **Node.js 22.19+** and the Node **note 0.26.0+** CLI on
`PATH` ([CLI install](../docs/usage.md#install)); Python is not needed.

```sh
pi install npm:pi-note
# Or, from a checkout:
pi install ./pi
```

`PINOTE_NOTE_COMMAND` selects another `note` executable. Notes live in
`$XDG_DATA_HOME/pinote/notes.db` (default `~/.local/share`). Load the package
once per Pi process. Pi on another machine or in a VM uses that machine's own
notes: nothing is synchronized.

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
**One task per Kitty tab**, then **Footer layout**. **Tab** or **Escape** returns to tasks with the search
retained. Editors accept plain text or numbers, not JSON; validation retains the
draft. Cancelling a change's confirmation returns to its text draft. Values
are saved only after review and confirmation.

**Footer layout** lists the current fields under the width settings. Select a
field to show it next in the bottom bar; its number is that order. Select it
again to hide it and renumber the rest. None selected hides every handoff field.
Empty values stay hidden, and **Max fields** still caps the bar. Until an order
is saved, enabled fields appear in definition order. This does not change agent
instructions.

Menus use Pi's native inline components, themes and configured selection keys.
**Escape** goes back; **Ctrl+R** refreshes; page keys scroll lists and documents.
Small terminals show compact menus or ask you to enlarge the window before acting.
Fullscreen has a clickable footer: **▤** opens Pinote; single-click a task title
to preview, or double-click to complete immediately without another confirmation
(requires idle Pi). Single-click a suggestion title to preview it; double-click
to accept, start and select it immediately without another confirmation.
A future task suggested by the agent follows the fields as `✚ [tag] title`:
single-click to preview, double-click to add it without starting or selecting
it, right-click to dismiss. It keeps up to 24 columns when the row is full.
Regular mode shows status; `/pinote` provides all actions. No Kitty action handler
is needed.

Accepting a suggestion, selecting a task (including the current one), or creating
and selecting one renames the current Kitty tab to `[tag] task title` (tag omitted
when unset; `Task #<id>` without a title), using the footer's first-line title rather than the GUI launcher's shortened name.
Requires local Kitty with remote control enabled, `kitty` on PATH, and
`KITTY_LISTEN_ON` / `KITTY_WINDOW_ID`; SSH and other terminals are unchanged.
Rename failures warn without undoing selection. Completion and deselection leave
the tab name unchanged; reload/resume and external task edits do not rename it.

**One task per Kitty tab** (off by default; also in Electron's **Kitty…**)
keeps split panes from sharing a tab name. Each interactive Pi records its
selected task in its Kitty window's `pinote_task` user variable, cleared on
deselection, completion or exit. When another pane in the tab holds a different
task, selecting one first moves this pane to a new tab beside the current one,
then names it. A pane that is not focused within its Kitty OS window stays put and
the shared tab keeps its name, with a warning; select the task again after focusing it.
Verified with Kitty 0.48.

Completion follows `onTaskComplete` (see below). With an empty editor, **Ctrl+D**
(or your configured exit key) offers Cancel, Exit without completing, or Complete
task and exit. **`/new`** offers Cancel, Start new session without completing, or
Complete task and start new session. With no selected task, `/new` proceeds normally.
Completion requires idle Pi and a current displayed revision; failures keep the
current session open. `/quit` exits without completing.

Reload/resume restores the active branch's selection. Starting a new session
without completing retains the selection; completing starts it unselected.
A GUI task launch or `/new` with a retained selection shows `Task #<id>` and the full task Markdown in the Pi transcript. This display entry is not sent to the model. Unrelated fresh launches start unselected.
Unsaved Pi sessions cannot guarantee selection persistence.

Selecting a task
(including accepting a suggestion, creating one, or **Start in Kitty…**) appends
the actual Pi session ID to its persistent `pi-sessions` array, without duplicates.
Task reads and injected agent context include the array so later agents can locate
previous sessions. Reads, previews, reload/resume,
and carried selections do not append IDs; select the task in a new session to record it.
IDs are metadata only: transcripts are not uploaded, and unsaved/deleted sessions
may no longer be available. The array is separate from editable handoff fields.

Electron's **Start in Kitty…** action chooses a working directory and opens a
named tab with this task selected, without submitting a prompt. It uses the tag's
default folder when available, otherwise keeps the directory chooser. Set or
clear defaults in **Manage tags…**.
Successful selection prefills an empty Pi editor with Electron's **Kitty… →
Start prompt** (default `is task clear?`; empty disables it); existing drafts are
never replaced.
The one-shot `PINOTE_LAUNCH_TASK` environment handoff carries the task ID, displayed
revision and optional editor draft, never task text or tokens. The draft is
never persisted as launch state.
Only a fresh session can consume it; missing/stale revisions fail closed. Resume, reload and `/new` never replay the
handoff or replace another selection.
### After completing a task

`onTaskComplete` in `pi-note.json` (Electron: **Kitty… → When a task is completed
in Pi**) decides what happens after you complete the selected task from the menu
or footer:

- `close-pi` (default): exit Pi. A **Start in Kitty…** tab closes with it.
- `close-pane`: exit Pi, then close its Kitty pane, ending the shell Pi ran in.
  **Complete task and exit** closes the pane too. Needs local Kitty remote control,
  as for tab names.
- `keep-open`: keep the conversation and editor.

It applies to every Pi session. An externally completed task, or a failed or
uncertain completion, never closes Pi. Pinote itself never runs Git commands;
optional local completion hooks can briefly delay closing (see below).

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

This local event fires exactly once only after this session's acknowledged **Done**
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
`pinote:query-current`) before Done returns or Pi exits after completion.
Without registered work, completion proceeds immediately.

There is one fixed **25-second total deadline**, shared by all listeners. The signal
aborts on session lifetime cancellation, deadline, or hook settlement; listeners
must honor it and avoid blocking synchronous work. Timers cannot preempt JavaScript
that blocks the event loop. On runtime teardown, `signal.reason` carries Pi's
shutdown reason (`quit`, `reload`, `new`, `resume`, or `fork`). A listener with its
own awaited shutdown handler may finish bounded work on `quit`; other cancellation
still stops its work. Hook rejection, timeout or cancellation never undo an
acknowledged completion, invalidate its state, or retry writes. Registered
promise rejections and timeouts produce only a generic warning when UI is available;
Pinote does not display their error or response text. This is a trusted local extension API, not task instructions or authorization to run models or external actions.

### Agent tools and context

The extension registers `pinote_search`, `pinote_get_task`, `pinote_get_current`,
`pinote_update_current`, `pinote_fields`, `pinote_tags`, `pinote_propose`, and
`pinote_suggest_later`.
Default guidance suggests tasks only for substantial work requiring changes, not
questions, explanations, research, read-only inspection, or trivial edits.
For new tasks, `pinote_propose` requires a nonblank, single-line `title` of
1–60 Unicode characters, with optional multiline `description` and `tag`.
Title and description are joined with a blank line; the combined text must
fit 4,000 characters. Invalid input is rejected, never truncated. To suggest an
existing task, pass only `task_id`.

`pinote_suggest_later` suggests a new task for future work when you ask for one,
with the same `title` and `tag` rules and a required, nonblank Markdown
`description`. It works with a task
selected and never changes the selection. Preview it from the footer or
`/pinote`; adding it creates a not-started task. A new suggestion replaces the
pending one.

Suggestions do not create/start/select tasks until accepted in the UI. Reads by ID
do not change selection. Updates require the task's `expected_updated_at` revision;
concurrent edits are rejected rather than overwritten. `set` replaces each named
value; `append` adds unique nonblank, trimmed lines while preserving existing
content. Do not combine `set`, `append` or `remove` for the same field. For example:

```json
{"expected_updated_at":"<current revision>","append":{"PRs":"https://github.com/owner/repo/pull/42"}}
```

Before each agent run, the extension reads fresh task context and agent guidance
and appends them as a hidden conversation message. Task updates do not change
the system prompt or invalidate its cached prefix.
Task text and handoff fields are untrusted data, not authorization. Failed reads
explicitly report unavailable context; they never reuse a cached task or claim no
task is selected. Tool results and injected context can reach your configured
model: do not put secrets in tasks.

External CLI/desktop/other-session edits refresh the footer and open menus within
about a second. If the `note` CLI is missing, outdated or failing, the footer shows
**Pinote unavailable · retrying…** until a fresh view can be read. Recovery retries
reads after 1 second, doubling to a maximum 30-second delay, preserving each
conversation's saved selection. `/pinote` can refresh immediately. Task actions are
unavailable until fresh state returns; session shutdown/reload cancels recovery.
Mutations are **never automatically replayed**: a failed write may already have
committed, so read fresh state before retrying.

### Shared settings

Settings live in `pi-note.json` under `PI_CODING_AGENT_DIR` (default
`~/.pi/agent`) and apply to every Pi session using that directory. The `/pinote`
settings edit prompts, injected agent guidance and footer definitions with
confirmation and revision checks. A malformed configuration fails closed; fix
the file rather than replacing it with defaults. Task fields such as `PRs`, `Worktrees` and `Next` remain task data,
separate from global display settings. The **New session prompt** setting
is stored for compatibility; `/new` does not insert it. Selected-task previews
above the 20,000-character display limit show explicit guidance to read through the
CLI instead of silently truncating.

### Automatic field updates

Open **Settings → Fields → Worktrees / PRs** and turn **Enabled** on.
Both presets are offered disabled by default; existing configured fields remain
enabled unless explicitly disabled. Legacy `PR`/`Bar` task display remains readable.
**Add field** creates a definition, not a task value.

Each field has editable **Agent instructions** describing what to save and when.
Enabled instructions are injected before untrusted task data on every agent run:
Worktrees appends the verified absolute root of each worktree after choosing/creating it;
PRs appends a URL after creating each PR. Default guidance also asks agents to
check missing/changed relevant values before ending implementation or handing off.
This is model guidance, not a guaranteed filesystem hook. It does not create
worktrees or PRs, and never authorizes work beyond the user's request.

Disabling stops automatic population guidance. Bottom-bar display is chosen in
**Footer layout**; until that order is saved, enabled fields still appear in
definition order. Saved values remain visible in Electron's task preview, alongside
full Pi session IDs. Session recording is integration-managed and independent of field switches.
Watchers have separate enable switches. Removing a preset definition restores its
disabled default; other definitions are removed without deleting saved values.
New definitions/edits require confirmation and affect every Pi session.
Presets remain discoverable at the 64-definition limit; remove an existing
definition before configuring another. Unedited presets do not consume slots.

### Multiple PRs

Set `PRs` to GitHub or Forgejo PR URLs or Markdown links, **one per line**. Each PR number
is its own footer link: green for passing CI, red for failures/conflicts, amber
for pending checks, and the theme accent (default purple) for merged PRs.
Closed or unavailable PRs are neutral. Status checks require the corresponding
enabled watcher and, for Forgejo, an explicitly trusted instance. Unwatched links
still work but remain neutral; display recognition never authorizes network access.

Existing `PR` values and footer definitions remain readable as `PRs`; task data
is not rewritten. If both fields exist, their links are combined and deduplicated.
Custom `<value>` formats retain legacy text and link labels alongside PR URLs.
Preserve existing entries when adding a PR. Up to 64 distinct URLs are supported;
invalid lines are ignored. The PRs group consumes one field slot and shares its
configured field width, so narrow layouts can truncate later links.
Alerts are acknowledged per PR, including across legacy/plural aliases and list
edits; grouped alerts never hide another PR's pending failure.

### Field watchers

Open **Settings → Fields → Watchers** to enable bundled watchers or add a
trusted executable. Events, fields and script parameters are edited in the
desktop's **Watchers…** settings. Files in the packaged `watchers/` folder are discovered
automatically, but remain disabled until enabled explicitly.

Pi never runs watchers itself. The [Pinote desktop](../docs/electron.md#field-watchers)
runs enabled watchers while it is open; Pi shows their results in the footer and
delivers their alerts. While the desktop is closed, results are not refreshed.

The bundled GitHub PR watcher triggers the owning Pi worker to investigate and fix
failed CI or merge conflicts. Repeated unchanged failures are deduplicated; busy
workers wait until idle and recheck current state before acting. Merged PRs retain
their links without strikethrough. Polling stops once all PRs handled by a watcher
in a field are closed or merged; tasks are not completed. GitHub requires
authenticated `gh` and Node on the desktop's `PATH`.
The **Forgejo PR** watcher supports configured HTTPS instances (or numeric
loopback HTTP) and API tokens from the desktop's environment without `gh`; it
alerts on failed CI and styles merged/closed PRs. Ambiguous Forgejo mergeability
remains pending, not a conflict alert. Both providers support multiple independent PRs.
Watcher execution failures appear as one terminal-only notice listing failing
watchers and affected fields, with the log path; they never enter model context.
See [setup, configuration, script contract and safeguards](FIELD_EVENTS.md).

## Migration

pi-note **0.47.0** removes the MCP Streamable HTTP service and client. Update,
then `/reload` or restart Pi.

1. Install the Node `note` CLI on the machine running Pi; it must use the notes
   database the service used.
2. Remove `PINOTE_URL`, `PINOTE_TOKEN`, `PINOTE_TOKEN_FILE` and `PINOTE_ALLOW_HTTP`
   from Pi's environment, and delete the unused token file. They are ignored.
3. Stop and disable any standalone `pinote.service`. Programs reading its
   `/events` stream should poll `note events --after CURSOR` instead.
4. For field watchers, update the Pinote desktop to Electron 0.15.0+ and keep it
   open; a watcher's tokens and `PATH` now come from the desktop's environment.
5. A custom loader must import the package's `index.ts`; `remote.ts` is gone.

A selection saved by the former client is kept when the local task records that
Pi session among its `pi-sessions`; otherwise the session starts unselected and
you select the task again in `/pinote`.
Pi in a VM or on another machine no longer shares the host's tasks.

The separate local-only extension with its own footer, `pinote_add` tool and CLI
installer is removed; this extension replaces it. Its Kitty preview handler
(`pi-note-preview`) can be deleted from `open-actions.conf`.

Trusted extensions listening to `pinote:query-current` and
`pinote:task-completed` are unaffected.

## Development and releases

From the repository root:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
npm --prefix pi ci --ignore-scripts && npm --prefix pi test
(cd pi && npm pack --dry-run)
```

Tests use the checkout's own `backend/bin/note` and temporary storage. UI validation must use Xvfb, a private D-Bus session and temporary app data.

Bump the pi-note version with `npm version patch|minor|major --no-git-tag-version`
inside `pi/` and commit its manifest and lockfile together. GitHub CI tests `main`,
then publishes new npm versions through OIDC trusted publishing; registry failures
fail the workflow.
The trusted publisher is `kvidzibo/pinote`, workflow `publish.yml`, no environment.
Installation never edits personal Pi, shell, systemd or desktop configuration.
