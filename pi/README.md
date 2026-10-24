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

Open **`/pinote`** (`/pi-note` is an alias). Select or create a task, preview it,
clear the selection, complete it, respond to suggestions, or edit shared settings.
Selection/creation and settings changes require confirmation. Nothing submits a
model prompt automatically; inserting Continue's draft requires confirmation and
preserves an existing draft.

Menus use Pi's native components and configured selection keys. **Escape** goes
back; **Ctrl+R** refreshes. Settings with fewer than five choices cycle inline.
Fullscreen has a native clickable footer: **▤** opens Pinote; clicking a selected
title previews it and double-clicking completes it. A suggested title requires a
double-click to accept. Regular mode shows status; `/pinote` provides all actions.
No Kitty action handler is needed for this extension.

Completion keeps the conversation and editor. With an empty editor, **Ctrl+D**
(or your configured exit key) offers Cancel, Exit without completing, or Complete
task and exit. Completion requires idle Pi and a current displayed revision;
failures leave Pi open. `/quit` exits without completing.

Reload/resume restores the active
branch's selection; `/new` retains it. Unrelated fresh launches start unselected.
Changing endpoints starts a separate selection namespace. Unsaved Pi sessions
cannot guarantee selection persistence.

### Agent tools and context

The extension registers `pinote_search`, `pinote_get_task`, `pinote_get_current`,
`pinote_update_current`, `pinote_fields`, `pinote_tags`, and `pinote_propose`.
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
separate from global display settings.

## Migration

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
