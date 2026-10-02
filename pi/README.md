# pi-note

Persistent [pinote](https://github.com/kvidzibo/pinote) tasks and Markdown handoffs
in Pi: selected-task footer status, `/pi-note`, and agent current-task read/update,
add, and tag-listing tools.
The extension and Python app share a repository but install separately.

## Install

Requires Node.js 22.19+ and **pinote 0.3.0+** (`note` on PATH). Add and tag listing need **pinote 0.4.0+**.
From this checkout, install the extension with `pi install ./pi`, then run
`/reload` in interactive Pi. Use `/pi-note-setup` if the CLI is missing, or the
suggested `/pi-note-upgrade` if it is older than the bundled CLI. The planned npm package name is
`pi-note`; after its first release use `pi install npm:pi-note` instead.
It is not published yet. npm installation does not run Python installers.

### CLI setup and upgrades

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) first and
restart Pi with `uv` on PATH. At startup the extension checks `note --version`
against its bundled CLI version (currently 0.4.0), without network requests:

- Missing/unrecognized CLI: show `/pi-note-setup` in the slash-command menu.
- Older CLI: show and suggest `/pi-note-upgrade`.
- Equal/newer CLI: hide both commands; no upgrade notification.

Both commands ask before installing into uv's isolated tool environment.
The menu refreshes after setup/upgrade; restart Pi or `/reload` after external
CLI changes. Manually typing either command rechecks the version and never
reinstalls an equal/newer CLI or intentionally downgrades it.
Python 3.11+ is required; uv can download a suitable interpreter when missing.
The command downloads a pinned GitHub source archive and build dependencies,
not a similarly named PyPI package. It does not install GTK dependencies, edit
shell configuration, or change tasks. This checks the Python CLI bundled with
the installed extension, not the latest npm/GitHub release. Update the extension
first to receive a newer bundled CLI. `/pi-note-setup --upgrade` is replaced by
`/pi-note-upgrade`.

Back up your database before upgrading and update an optional GUI separately.
For checkout development, use `uv tool install --reinstall .` at the repo root
instead, so local Python changes are installed.

If setup reports a PATH problem, run `uv tool dir --bin` in your terminal,
put that directory before older `note` executables on PATH, and restart Pi.
Check `note --version`, then restart Pi or `/reload`. Network/build failures and
conflicting executables are reported without forcibly overwriting another
installer's commands. Fix the reported cause and retry; installs time out after
three minutes. Setup/upgrade commands are hidden while installation runs.
Missing uv is reported with its installation link, not installed
automatically. The [GTK desktop app](../README.md#optional-gtk-checklist) is optional
and still requires separate system dependencies.

The extension probes `note --version` before task commands: older CLIs interpret
unknown commands as note text and must be rejected before use. Remove the old
standalone `settings/pi/extensions/pinote.ts` entry if installed; load only one copy.

## Use

`/pi-note` picks a task, starts it, and adds a short task-ID prompt to the editor:
“Read the current task (#121) with pinote_get_current and work on it. Ask only if
blocked. Save progress with pinote_update_current.” The agent fetches current task text and saved handoff fields
when you submit; they are not copied into the draft. Existing drafts are preserved;
nothing is submitted automatically.
With a selected task it offers **Continue**, **Done**, and **Switch task**.
Type in the task picker to filter by text, ID, tag, or state (all words must match).
Use ↑/↓ and Enter to select, or Esc to cancel. Rows show **●** for in progress or
**○** for active, followed by the tag (`[Untagged]` when absent).
The normal Pi status area shows `📌 [tag] Task title` without replacing other footers.
The footer omits the task ID and state and shows only the first line, truncated to 60 terminal columns including the pin and tag.
The pin glyph is bundled in `icons/note.txt`; it uses the terminal's emoji font, not a Nerd Font or icon theme.

Each Pi session remembers its own task, including several sessions in one folder.
Resume restores that session's task; a new session starts unselected and does not import
an older per-folder selection. Pi saves the session after the first submitted message;
quitting before that leaves the next launch unselected, while the task stays in progress.
Use **Continue**
to insert its task-ID prompt. Completing, removing, or scheduling a task clears it
from sessions that refresh it. Switching does not complete or reset the previous task.
Task fields such as `Worktree` and `PR` stay on the task, so sessions can use separate
worktrees and pull requests. Task status refreshes at session start, before/after
agent activity, and after commands/tools. The CLI's per-directory `agent selected`
command is not this session memory.

Agent tools:

- `pinote_get_current`: read this session's selected task, including its revision.
  Takes no arguments; returns null when this session has no selected task.
- `pinote_update_current`: supply `expected_updated_at` from that read and arbitrary
  `set` label/value pairs or `remove` labels. Updates the selected task only, with no
  ID argument. Updates merge fields, never replace the task text or tag. Fails if
  no task is selected or the selection changes during the operation. If another
  process changed the task, read again before retrying.
- `pinote_tags`: list saved tag names.
- `pinote_add`: create an active task. Optional `tag`. `select: true` starts and
  remembers it for this session only; use that only after the user agrees.

Version 0.7.0 replaces `pinote_get`/`pinote_update` with these current-task tools
and removes `pinote_tag`, without aliases. Agents cannot read/update tasks by ID
or retag existing tasks; use `/pi-note` to select an existing task.

When the user gives work and no task is selected, the agent proposes one note as
`[tag] text` and asks before creating it. No continues without a note. Yes calls
`pinote_add` with `select: true`. An existing selection is not replaced unless the
user asks to switch. Reuse a saved tag name when it fits.

Agents are guided to keep notes to three short bullets total: relevant outcome,
blocker, and next action. Replace stale notes; omit narration, repeated task text,
and routine test logs. Keep a GitHub pull request in `PR`. To show another footer
field, set its Markdown value and append its label to `Bar`, one label per line.
Do not list `PR` in `Bar`. Remove the field and its `Bar` line to drop it. This is
guidance, not truncation or a storage limit.

Values are Markdown strings; no fields are required. `PR` enables the watcher below.
`Bar` chooses extra footer fields:

```markdown
# Agent
PR: [Task selection #42](https://github.com/org/repo/pull/42)
Dashboard: [Metrics](http://127.0.0.1:3000/d/app)
Next: Address review comments
Bar: Dashboard
Next
Jira: [PROJ-123](https://example.atlassian.net/browse/PROJ-123)
CWD: `/home/me/project`
```

The GTK preview renders this section using its existing safe Markdown renderer.
Fields are stored separately from task text, retained in history, and survive
sessions. Labels are case-sensitive (trimmed, Unicode-normalized), at most 64
characters; values are at most 4096 characters. Maximum 64 fields / 32 KiB JSON
per task. Use removal rather than empty values.

### Footer links

The selected active or in-progress task can show fields after its title.
`PR` is always shown when it matches the watcher format below, as **PR #123**.
`Bar` is a newline-separated list of other field labels. Each listed value is
Markdown: the footer shows its text, and links in it are clickable for any scheme
except `javascript:`, `data:`, and `vbscript:`. Credentials, control characters,
and targets over 2048 characters after serialization are shown as text but not
linked. Missing labels and the `PR` and `Bar` labels themselves are skipped.
At most four extra fields are shown, each truncated to 60 columns. Removing a listed
field hides it even if `Bar` still names it. Terminal OSC 8 support is required
for clicking links. Pi joins footer statuses on one line, so a narrow terminal can
ellipsize later fields. Other fields, such as `Jira` and `CWD` in the example, stay
off the footer unless named in `Bar`.

### PR merge watcher

Set `PR` with `pinote_update_current` to one `https://github.com/owner/repo/pull/123` URL
or Markdown link. The footer adds a clickable, link-coloured **PR #123**, without
status text. Other hosts, multiple links, and prose are not watched.

Interactive Pi checks only the selected task's PR using authenticated `gh`
(`gh auth login`). Polling defaults to 60 seconds; launch Pi with
`PINOTE_PR_POLL_SECONDS=120 pi` to change it, or `0` to disable polling.
Allowed intervals are 10–86400 seconds. The selected task's link remains visible when polling is disabled.
Network/authentication failures warn once until recovery and retry next interval.
No polling runs in print/RPC mode or after Pi exits.

On merge, Pi waits until idle and asks **Mark this task completed?** In Kitty,
indeterminate progress animates the tab while the prompt awaits input (with Kitty's
default progress-aware tab title or a working/ready renderer). Progress clears on
response, cancellation, or shutdown; other terminals and redirected output are untouched.
Confirmation uses the same guarded CLI Done operation as `/pi-note`; declining leaves
the task unchanged. If it is already done, Pi says **PR #123 was merged and the task is
already completed**, without completing it again. Completion clears the selection
and hides the footer link, even with polling disabled. The background watch remains
until another task is selected, the link is removed, or Pi exits. Removed/scheduled tasks are no longer watched.

The watched task ID/link and merge acknowledgements are saved in the Pi session,
so `/reload` and session resume retain completed-task watches without repeating
acknowledged prompts. A new session can notify again for a
selected task. Task or PR changes during confirmation cannot complete a different
task. No completion-hook system is added; this uses Pinote's existing Done flow.
A separate branch-based PR-status extension may show a duplicate link; disable it
if you only want task-linked PRs.

Task data stays local except for GitHub status requests. Tools work without a TUI,
but `/pi-note` needs an idle TUI.
This package does not synchronize databases or paths between machines. Note text
and fields loaded into Pi are sent to the configured model when used as context;
avoid secrets. Agent commands do not send desktop notifications.

## Development and releases

From the repository root:

```sh
uv sync --locked
npm --prefix pi ci --ignore-scripts
npm --prefix pi test
(cd pi && npm pack --dry-run)
```

The load test uses the real Pi loader and checkout's `.venv/bin/note` with temporary
data. Run visual checks under Xvfb/private D-Bus; never use personal task data.

`.github/workflows/publish.yml` follows the other Pi packages: every push to
`main` runs the full Python/GTK/Pi tests, then publishes a new npm version using
OIDC trusted publishing and provenance. Existing versions are skipped; registry
failures fail the workflow. No npm token is stored in GitHub.

One-time maintainer setup (not performed by installing this package):

1. From `pi/`, run `npm login`, then `npm publish --ignore-scripts --access public`
   to bootstrap `pi-note` after checking name availability.
2. In npm's package settings configure the GitHub trusted publisher: owner
   `kvidzibo`, repository `pinote`, workflow `publish.yml`, no environment.
3. Add verified npm and Pi package-directory links here after publication.

The CLI source pin in `setup.ts` must point to a verified immutable commit with a
compatible Python package. Update it and the bundled-version setup text together
when releasing Python changes; verify installation in a temporary uv tool directory.

Subsequent releases: run `npm version patch|minor|major --no-git-tag-version`
inside `pi/`, commit both version files in a PR, and merge through the normal
review/check process. Python and npm versions are independent; update the stated
minimum CLI version whenever the integration contract changes.
