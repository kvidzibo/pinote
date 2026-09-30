# pi-note

Persistent [pinote](https://github.com/kvidzibo/pinote) tasks and Markdown handoffs
in Pi: selected-task footer status, `/pinote`, and agent read/update tools.
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

`/pinote` picks a task, starts it, and puts its full text and saved handoff fields
in the editor. Existing drafts are preserved; nothing is submitted automatically.
With a selected task it offers **Continue**, **Done**, and **Switch task**.
The normal Pi status area shows `📌 #42 Task title` without replacing other footers.
The pin glyph is bundled in `icons/note.txt`; it uses the terminal's emoji font, not a Nerd Font or icon theme.

Selection is stored per canonical working directory in pinote's database. A new
Pi session shows that selection; use **Continue** to load its current contents.
Completing, removing, or scheduling a task clears its selections. Switching does
not complete or reset the previous task. Status refreshes at session start,
before/after agent activity, and after commands/tools, not on an idle timer.

Agent tools:

- `pinote_get`: read the selected task, or an explicit `id`, including its revision.
- `pinote_update`: supply `id`, `expected_updated_at` from that read, and arbitrary
  `set` label/value pairs or `remove` labels. Updates merge fields, never replace
  the task text. If another process changed the task, read again before retrying.

Values are Markdown strings; no predefined or required fields:

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

All data stays local. Tools work without a TUI, but `/pinote` needs an idle TUI.
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
