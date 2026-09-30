# pi-note

Persistent [pinote](https://github.com/kvidzibo/pinote) tasks and Markdown handoffs
in Pi: selected-task footer status, `/pi-note`, and agent read/update tools.
The extension and Python app share a repository but install separately.

## Install

Requires Node.js 22.19+ and **pinote 0.3.0+** (`note` on PATH).
The extension probes `note --version` before commands: older CLIs interpret unknown
commands as note text and must be rejected before use. From this checkout:

```sh
uv tool install --reinstall .
pi install ./pi
```

Run `/reload` in existing Pi sessions. Remove the old standalone
`settings/pi/extensions/pinote.ts` entry if installed; load only one copy.
The planned npm package name is `pi-note`; after its first release install with
`pi install npm:pi-note`. It is not published yet.

## Use

`/pi-note` picks a task, starts it, and puts its full text and saved handoff fields
in the editor. Existing drafts are preserved; nothing is submitted automatically.
With a selected task it offers **Continue**, **Done**, and **Switch task**.
Type in the task picker to filter by text, ID, tag, or state (all words must match).
Use ↑/↓ and Enter to select, or Esc to cancel. Rows show **●** for in progress or
**○** for active, followed by the tag (`[Untagged]` when absent).
The normal Pi status area shows `📌 [tag] Task title` without replacing other footers.
The footer omits the task ID and state and shows only the first line, truncated to 60 terminal columns including the pin and tag.
The pin glyph is bundled in `icons/note.txt`; it uses the terminal's emoji font, not a Nerd Font or icon theme.

Selection is stored per canonical working directory in pinote's database. A new
Pi session shows that selection; use **Continue** to load its current contents.
Completing, removing, or scheduling a task clears its selections. Switching does
not complete or reset the previous task. Task status refreshes at session start,
before/after agent activity, and after commands/tools.

Agent tools:

- `pinote_get`: read the selected task, or an explicit `id`, including its revision.
- `pinote_update`: supply `id`, `expected_updated_at` from that read, and arbitrary
  `set` label/value pairs or `remove` labels. Updates merge fields, never replace
  the task text. If another process changed the task, read again before retrying.

Agents are guided to keep notes to three short bullets total: relevant outcome,
blocker, and next action. Replace stale notes; omit narration, repeated task text,
and routine test logs. Keep PR links in `PR`. This is guidance, not truncation or
a storage limit.

Values are Markdown strings; no fields are required. `PR` enables the watcher below:

```markdown
# Agent
PR: [Task selection #42](https://github.com/org/repo/pull/42)
Jira: [PROJ-123](https://example.atlassian.net/browse/PROJ-123)
CWD: `/home/me/project`
Next: Address review comments
```

The GTK preview renders this section using its existing safe Markdown renderer.
Fields are stored separately from task text, retained in history, and survive
sessions. Labels are case-sensitive (trimmed, Unicode-normalized), at most 64
characters; values are at most 4096 characters. Maximum 64 fields / 32 KiB JSON
per task. Use removal rather than empty values.

### PR merge watcher

Set `PR` with `pinote_update` to one `https://github.com/owner/repo/pull/123` URL
or Markdown link. The footer adds a clickable, link-coloured **PR #123**, without
status text. Other hosts, multiple links, and prose are not watched. Terminal
OSC 8 support is required for clicking links.

Interactive Pi checks only the selected task's PR using authenticated `gh`
(`gh auth login`). Polling defaults to 60 seconds; launch Pi with
`PINOTE_PR_POLL_SECONDS=120 pi` to change it, or `0` to disable polling.
Allowed intervals are 10–86400 seconds. The selected task's link remains visible when polling is disabled.
Network/authentication failures warn once until recovery and retry next interval.
No polling runs in print/RPC mode or after Pi exits.

On merge, Pi waits until idle and asks **Mark this task completed?** Confirmation
uses the same guarded CLI Done operation as `/pi-note`; declining leaves the task
unchanged. If it is already done, Pi says **PR #123 was merged and the task is
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

Subsequent releases: run `npm version patch|minor|major --no-git-tag-version`
inside `pi/`, commit both version files in a PR, and merge through the normal
review/check process. Python and npm versions are independent; update the stated
minimum CLI version whenever the integration contract changes.
