# Pinote native UI over MCP

An opt-in alternative to the Pinote-specific Pi extension. Pinote serves the task
picker, settings forms, previews, footer data, and action validation through MCP;
the generic [gateway UI host](https://github.com/kvidzibo/mcp-session-gateway)
only renders and routes them. No model turn is needed for UI actions.

This uses the gateway's **private native UI v1 protocol**, not browser MCP Apps or
the built-in Pi MCP resource renderer. Use gateway 0.12.0+ with its Pi adapter.

## Setup

Requires Node.js 22.19+, Python 3.11+, and `note` 0.4.0+. From the Pinote checkout:

```bash
uv sync --locked
npm --prefix pi ci --ignore-scripts
npm --prefix pi run build:mcp
```

Add a service to the gateway config (use absolute paths):

```json
{
  "servers": {
    "pinote": {
      "command": "node",
      "args": ["/absolute/path/to/pinote/pi/dist-mcp/mcp/server.js"],
      "env": { "PINOTE_NOTE_COMMAND": "/absolute/path/to/pinote/.venv/bin/note" }
    }
  }
}
```

Then launch the gateway's generic Pi adapter and open
`/gateway` → Services → pinote → Open app.
Do not also load `pi/index.ts` for this workflow. Nothing is automatically
installed, activated, or migrated; keep the existing integration until you approve
the switch. To test `/reload`, reload only a disposable session/profile first.

The service shares the existing database and `pi-note.json`. `PINOTE_NOTE_COMMAND`
selects an executable, not a shell command. Without it, `note` must be on PATH.
Explicitly pass `PI_CODING_AGENT_DIR`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` in service
`env` when using overrides or disposable data. Defaults otherwise refer to your
normal personal data. No desktop notifications are sent.

## Use

- **Tasks:** filter, select/start, create/select, clear selection, complete, preview,
  and request insertion of the task prompt. Selecting a task asks for confirmation.
- **Settings:** edit prompts, task-offer policy, footer limits, and field definitions
  (label, link, format, width). Enter text as JSON strings (`\n` for line breaks)
  so whitespace round-trips exactly. Saves are confirmed, validated, and atomic; concurrent
  edits are rejected and unrelated settings are preserved. Invalid configuration
  fails closed; repair it manually rather than replacing it with defaults.
- **Footer:** selected task plus configured fields; safe HTTP(S) links are clickable.
  The title previews the task; **✔** completes it and clears the selection without
  resetting the conversation or editor. Suggestions show **✖ / ✚** to dismiss or
  create/start/select. These use the gateway's generic footer actions, not a Pinote
  extension or private handler. Install the gateway's Kitty protocol handler as
  described in its native UI documentation; app menus remain the keyboard fallback.
- **Agent:** `propose`, `get_current`, `update_current`, `fields`, and `tags` are
  available through gateway tool discovery. `propose` returns opaque UI state;
  it does not create a task. It replaces an unaccepted suggestion only when no task
  is selected. Text is limited to 4,000 characters and the host's 8 KiB state budget.
  Acceptance/dismissal consumes a durable receipt before mutation, so old links,
  branch restores and reconnects cannot replay consent. An interrupted acceptance
  may have created a task: inspect the task list, never blindly propose it again. They use the same host-supplied selection as the UI.
  UI actions and settings writes are not advertised as model tools.

The host owns durable conversation/branch state; the service does not store a
second selection database. Reload/reconnect restores saved state, separate sessions
in one folder stay independent, and `/new` retains the current selection or pending
suggestion. An unrelated fresh launch starts unselected. The stable service
context is separate from both the Pi conversation ID and gateway process UUID. Pi must
have saved the session for resume persistence. Existing extension selections are
not imported. Changing the gateway config path or service name starts a separate
selection namespace.

## Initial-version limits

This is a working alternative, **not full parity with the old extension**. It does
not retag/edit existing tasks or install/upgrade the CLI. Completion intentionally
does not reset conversations. Task-offer policy and new-session prompt can
be edited for compatibility with the existing extension, but this host does not
yet implement their automation. Continue requests a separately confirmed draft;
it never overwrites existing editor text or submits a prompt. Previews are display-only transcript entries (never model context), showing plain
text/Markdown source limited to 20,000 characters; the task list shows at most 200
filtered matches (fewer if the serialized display budget is reached). Use the CLI for full text and unsupported task operations.

Consent receipts live under `$XDG_STATE_HOME/pinote/mcp-proposals` (default
`~/.local/state/pinote/mcp-proposals`). They contain no task content and are retained
to reject historical proposals. Do not delete them while old sessions may resume.
They are replay protection, not a second selection database or an authorization
boundary against local processes.

Changes through this service notify the host. External CLI/GTK/config changes need
Ctrl+R or reopening the app. Failed actions are never retried automatically: a
write might have committed before an interruption. Read fresh state before retrying.
Trusted services/agents have ordinary OS permissions; UI-only routing is not a
secrecy or authorization boundary.

## Validation

```bash
npm --prefix pi test
```

The MCP integration test runs the real stdio server and CLI against temporary
storage, including settings conflicts, host selection isolation, handoff updates,
completion, and reconnect. Visual validation must use Xvfb, private D-Bus, and
explicit temporary service data/settings paths.
