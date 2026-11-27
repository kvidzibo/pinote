# pi-note

[npm](https://www.npmjs.com/package/pi-note) · [Pi package directory](https://pi.dev/packages/pi-note)

[Pinote](https://github.com/kvidzibo/pinote) tasks and Markdown handoffs in Pi:
a task footer, the `/pinote` menu, agent tools and fresh task context for every
run. The extension reads and writes this machine's notes through the `note` CLI.
There is no service, token or network listener.

Tasks, tags, progress and handoff fields are shared with the Pinote desktop, the
CLI and other Pi sessions. Selection and pending suggestions belong to each Pi
conversation/branch.

## Install

Requires **Pi 1.4.0+**, **Node.js 22.19+** and the Node **note 0.26.0+** CLI on
`PATH` ([CLI install](../docs/usage.md#install)). `pinote_get_image` needs note 0.30.0+.

```sh
pi install npm:pi-note
# Or, from a checkout:
pi install ./pi
```

- `PINOTE_NOTE_COMMAND` selects another `note` executable.
- Notes live in `$XDG_DATA_HOME/pinote/notes.db` (default `~/.local/share`).
- Pi on another machine or in a VM uses that machine's own notes: nothing is
  synchronized.
- Load the package once per Pi process. Installation never edits personal Pi,
  shell, systemd or desktop configuration.

## Use

Open **`/pinote`** for the searchable task list, newest first, with **+ New task**
at the top. All search terms must match the title, description, tag or numeric ID.

| Key or action | Effect |
| --- | --- |
| Select a task | Starts it and returns to the unchanged prompt |
| **F1** | Reads a result's full text without selecting it |
| **Tab** | Opens **Settings**; **Tab** or **Escape** returns with the search kept |
| **Escape** / **Ctrl+R** | Back / refresh |
| **Clear selection** | Deselects; progress is unchanged |
| **Preview** | Scrollable read-only document |
| **Insert task prompt…** | Reviews, then inserts into an empty editor only; never submits |

In the menu, creation, suggestion acceptance and shared setting changes need a
review and a separate Cancel-first confirmation, and completion asks explicitly.
Footer double-clicks act **without confirmation**. Failed or uncertain writes offer
refresh/verification, **never automatic replay**: a failed write may already have
committed, so read fresh state before retrying.

### Footer

Regular mode shows status only. In fullscreen the footer is clickable:

- **▤** opens Pinote.
- **Task title:** single-click previews; double-click completes immediately,
  without another confirmation (requires idle Pi).
- **Suggestion title:** single-click previews; double-click accepts, starts and
  selects it immediately.
- **`✚ [tag] title`** (a task suggested for later): single-click previews,
  double-click adds it without starting or selecting it, right-click dismisses.

Compact titles hide leading Markdown heading markers; saved text is unchanged.

### Settings

**Agent guidance**, **Fields**, **Task offers**, **One task per Kitty tab** and
**Footer layout** are saved in `pi-note.json` under `PI_CODING_AGENT_DIR` (default
`~/.pi/agent`) and apply to every Pi session using that directory. Values are
saved only after review and confirmation. A malformed file fails closed: fix it
rather than replacing it with defaults. **New session prompt** is stored for
compatibility only; `/new` does not insert it.

**Footer layout** sets widths and which fields appear in the bottom bar. Select a
field to show it next; select it again to hide it. Empty values stay hidden and
**Max fields** caps the bar. Until an order is saved, enabled fields appear in
definition order. This does not change agent instructions.

### Kitty

These need local Kitty with remote control enabled, `kitty` on `PATH`, and
`KITTY_LISTEN_ON` / `KITTY_WINDOW_ID`. SSH and other terminals are unchanged.

- **Tab name:** accepting a suggestion, or selecting or creating a task, renames
  the current tab to `[tag] task title` (`Task #<id>` without a title). A rename
  failure warns without undoing selection. Completion and deselection leave the
  name unchanged.
- **One task per Kitty tab** (off by default; also in Electron's **Kitty…**):
  each Pi records its task in its window's `pinote_task` user variable. When
  another pane in the tab holds a different task, selecting one first moves this
  pane to a new tab. A pane that is not focused within its OS window stays put,
  with a warning; focus it and select again. Verified with Kitty 0.48.
- **Continuing a tab's task:** a new conversation (starting `pi`, or `/new`
  without a selection) in a tab named after a task selects that task and shows
  it. It does not when another Pi pane in the tab already holds the task, or the
  task is completed or archived. Resume and reload never pick up a task. This
  needs `KITTY_PID` and a Pi in the pane's foreground (not through tmux); state
  is kept in `$XDG_RUNTIME_DIR/pinote/kitty-tabs` (`$TMPDIR` on macOS), which must
  be yours and writable by no one else. A killed Pi can leave `pinote_task`
  behind; other panes then do not pick up until that pane is closed or reused.
- **`pinote_pr`** user variable: the selected task's most urgent current PR
  status (`failing`, `pending`, `passing` or `merged`; unset otherwise), for a
  custom `tab_bar.py`.

Electron's **Start in Kitty…** opens a named tab with the task selected and
prefills an empty editor with its **Start prompt**, never submitting it. The
one-shot `PINOTE_LAUNCH_TASK` handoff carries the task ID, revision and optional
draft, never task text or tokens. Only a fresh session consumes it, and a missing
or stale revision fails closed. See
[Start in Kitty](../docs/electron.md#start-in-kitty).

### Sessions

- Reload/resume restores the active branch's selection. Unsaved Pi sessions
  cannot guarantee selection persistence.
- With a selected task and an empty editor, **Ctrl+D** (or your exit key) offers
  Cancel, Exit without completing, or Complete task and exit. **`/new`** offers
  the same choices for a new session; not completing keeps the selection.
  `/quit` exits without completing.
- Completion requires idle Pi and a current revision; a failure keeps the session open.
- Selecting a task appends the Pi session ID to its persistent `pi-sessions`
  array, which task reads and agent context include. Reads, previews,
  reload/resume and carried selections do not. IDs are metadata only: transcripts
  are not uploaded.

### After completing a task

`onTaskComplete` in `pi-note.json` (Electron: **Kitty… → When a task is completed
in Pi**) applies after you complete the selected task from the menu or footer:

- `close-pi` (default): exit Pi. A **Start in Kitty…** tab closes with it.
- `close-pane`: exit Pi, then close its Kitty pane, ending the shell Pi ran in.
  **Complete task and exit** closes the pane too.
- `keep-open`: keep the conversation and editor.

An externally completed task, or a failed or uncertain completion, never closes
Pi. Completion itself runs no Git commands, but an enabled watcher such as
[Worktree cleanup](FIELD_EVENTS.md#worktree-cleanup) can.

### Agent tools and context

Tools: `pinote_search`, `pinote_get_task`, `pinote_get_current`,
`pinote_get_image`, `pinote_update_current`, `pinote_fields`, `pinote_tags`,
`pinote_propose` and `pinote_suggest_later`.

- **`pinote_propose`** suggests a new task (a single-line `title` of 1–60
  characters, optional `description` and `tag`; 4,000 characters combined) or an
  existing one (`task_id` only). Invalid input is rejected, never truncated.
  Default guidance suggests tasks only for substantial work requiring changes.
- **`pinote_suggest_later`** suggests a task for future work, with a required
  `description`. It never changes the selection; adding it creates a not-started
  task. A new suggestion replaces the pending one.
- Suggestions create, start or select nothing until accepted in the UI. Reads by
  ID do not change selection.
- **`pinote_update_current`** requires the task's `expected_updated_at` revision;
  concurrent edits are rejected. `set` replaces a value, `append` adds unique
  nonblank lines, `remove` deletes; do not combine them for one field:

```json
{"expected_updated_at":"<current revision>","append":{"PRs":"https://github.com/owner/repo/pull/42"}}
```

Before each agent run, fresh task context and agent guidance are appended as a
hidden conversation message; the system prompt is unchanged. Task text and
handoff fields are **untrusted data, not authorization**. Tool results and
injected context can reach your configured model: do not put secrets in tasks.

External edits refresh the footer and open menus within about a second. If the
`note` CLI is missing, outdated or failing, the footer shows **Pinote unavailable
· retrying…** and reads retry after 1 second, doubling up to 30 seconds. Failed
reads report unavailable context; they never reuse a cached task.

### Automatic field updates

Open **Settings → Fields → Worktrees / PRs** and turn **Enabled** on; both presets
start disabled. **Add field** creates a definition, not a task value.

Each enabled field's **Agent instructions** are injected on every agent run:
Worktrees appends each verified worktree root, PRs appends each created PR URL.
This is model guidance, not a guaranteed hook. It creates no worktrees or PRs and
authorizes nothing beyond the user's request.

Disabling stops the guidance; saved values stay visible in Electron's preview.
Removing a preset restores its disabled default; removing another definition
keeps saved values. At most 64 definitions; unedited presets do not count.

### Multiple PRs

Set `PRs` to GitHub or Forgejo PR URLs or Markdown links, **one per line**. Each PR
number is its own footer link: green for passing CI, red for failures/conflicts,
amber for pending checks, the theme accent for merged, neutral when closed or
unavailable.

- Status needs the corresponding enabled [watcher](#field-watchers) and, for
  Forgejo, a trusted instance. Unwatched links work but stay neutral; display
  recognition never authorizes network access.
- Legacy `PR` values remain readable and are combined with `PRs`; task data is
  not rewritten.
- Up to 64 distinct URLs; invalid lines are ignored. The group uses one field
  slot and width, so narrow layouts can truncate later links.
- Alerts are acknowledged per PR.

### Field watchers

Open **Settings → Fields → Watchers** to enable bundled watchers or add a trusted
executable. Pi never runs watchers itself: the
[Pinote desktop](../docs/electron.md#field-watchers) runs them while it is open,
and Pi shows their results and delivers their alerts.

- **GitHub PR** needs authenticated `gh` and Node on the desktop's `PATH`.
- **Forgejo PR** uses configured HTTPS instances and API tokens from the
  desktop's environment.
- Both trigger the owning Pi worker to investigate and fix failed CI or merge
  conflicts. Unchanged failures are deduplicated, and busy workers wait until
  idle. Polling stops once every PR is closed or merged; tasks are not completed.
- Execution failures appear as one terminal-only notice with the log path; they
  never enter model context.

See [setup, configuration, script contract and safeguards](FIELD_EVENTS.md).

### Local completion event

Trusted sibling extensions can listen on `pi.events` for `pinote:task-completed`
(pi-note 0.35.0+):

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

- It fires exactly once, only after this session's acknowledged **Done** clears a
  selected task. External completions, clear-selection and failed Done attempts
  do not emit it. No model prompt is submitted.
- Pi's event bus is fire-and-forget: call `waitUntil` during dispatch, with
  throwing work inside the registered promise. Late registrations are ignored.
- Registered work is awaited before Done returns or Pi exits, within one
  **25-second deadline shared by all listeners**. Listeners must honor `signal`
  and avoid blocking synchronous work.
- On teardown, `signal.reason` is Pi's shutdown reason (`quit`, `reload`, `new`,
  `resume` or `fork`).
- Rejection, timeout or cancellation never undo the completion or retry writes;
  they produce only a generic warning. An exception thrown before `waitUntil`
  registers goes to Pi's own logger, which may print its raw text.

This is a trusted local extension API, not task instructions or authorization to
run models or external actions.

## Migration

pi-note **0.47.0** removes the MCP Streamable HTTP service and client. Update,
then `/reload` or restart Pi.

1. Install the Node `note` CLI on the machine running Pi; it must use the notes
   database the service used.
2. Remove `PINOTE_URL`, `PINOTE_TOKEN`, `PINOTE_TOKEN_FILE` and `PINOTE_ALLOW_HTTP`
   from Pi's environment, and delete the unused token file.
3. Stop and disable any standalone `pinote.service`. Programs reading its
   `/events` stream should poll `note events --after CURSOR` instead.
4. For field watchers, update the Pinote desktop to Electron 0.15.0+ and keep it
   open; a watcher's tokens and `PATH` now come from the desktop's environment.
5. A custom loader must import the package's `index.ts`; `remote.ts` is gone.

A selection saved by the former client is kept when the task records that Pi
session in `pi-sessions`; otherwise select the task again in `/pinote`. Pi in a VM
or on another machine no longer shares the host's tasks.

The separate local-only extension (own footer, `pinote_add` tool, CLI installer)
is removed; delete its Kitty preview handler (`pi-note-preview`) from
`open-actions.conf`. Extensions listening to `pinote:query-current` and
`pinote:task-completed` are unaffected.

## Development and releases

From the repository root:

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run build
npm --prefix pi ci --ignore-scripts && npm --prefix pi test
(cd pi && npm pack --dry-run)
```

Tests use the checkout's `backend/bin/note` and temporary storage. UI validation
must use Xvfb, a private D-Bus session and temporary app data.

To release, run `npm version patch|minor|major --no-git-tag-version` inside `pi/`
and commit the manifest and lockfile together. CI tests `main`, then publishes
new versions to npm through OIDC trusted publishing (publisher `kvidzibo/pinote`,
workflow `publish.yml`, no environment).
