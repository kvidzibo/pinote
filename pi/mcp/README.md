# Pinote native UI over MCP

An opt-in alternative to the Pinote-specific Pi extension. Pinote serves the task
picker, settings forms, previews, footer data, and action validation through MCP;
the generic [gateway UI host](https://github.com/kvidzibo/mcp-session-gateway)
only renders and routes them. No model turn is needed for UI actions.

This uses the gateway's **private native UI v1 protocol**, not browser MCP Apps or
the built-in Pi MCP resource renderer. Use gateway 0.12.0+ with its Pi adapter.

## Setup

Requires Node.js 22.19+, Python 3.11+, and `note` 0.12.0+. From the Pinote checkout:

```bash
uv sync --locked
npm --prefix pi ci --ignore-scripts
npm --prefix pi run build:mcp
```

Merge the service into your gateway's existing `mcpServers` map, preserving other
services (use absolute paths). Do not mix `mcpServers` with the legacy `servers` key:

```json
{
  "mcpServers": {
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
  Single-click the active title to preview; double-click it to complete. **✔** also
  completes and clears the selection without resetting the conversation or editor.
  Suggested titles use italic accent text; double-click to accept/start, then the
  title returns to normal text. Acceptance cannot reuse the same click capability
  to complete. Styling/double-click require gateway 0.28.0+ and double-click needs
  its updated Kitty mouse mapping (Ctrl+Shift+double-click in fullscreen).
  Older hosts retain plain titles and icon actions. Suggestions show **✚**: left-click to
  create/start/select, right-click to dismiss. Right-click requires gateway 0.22.0+
  and its Kitty mouse mapping; **Dismiss suggestion** in the app menu remains the
  keyboard/older-host fallback. These use the gateway's generic footer actions, not a Pinote
  extension or private handler. Install the gateway's Kitty protocol handler
  and right-click mouse mapping as described in its native UI documentation. Existing
  installations need to add the mapping and reload Kitty; package updates do not
  edit terminal configuration. App menus remain the keyboard fallback.
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

## Task-offer guidance

Before multi-step implementation or configuration migrations, agents should call
`get_current`. If it returns null, use `tags` and `propose` to suggest a short task
with a saved tag, then continue without waiting. Skip informational questions and
trivial edits. Never replace an existing selection or create/select without consent.

The tool descriptions reinforce this workflow after discovery. For proactive
discovery, include the same guidance in the client's always-loaded agent rules;
tool descriptions alone cannot make an agent discover the service.

## Initial-version limits

This is a working alternative, **not full parity with the old extension**. It does
not retag/edit existing tasks or install/upgrade the CLI. Completion intentionally
does not reset conversations. The legacy `taskOfferPolicy` and new-session prompt
remain editable for native-extension compatibility; the MCP host does not apply
them automatically. Agent-side task offers follow the client rules and tool
descriptions above. Continue requests a separately confirmed draft;
it never overwrites existing editor text or submits a prompt. Previews are display-only transcript entries (never model context), showing plain
text/Markdown source limited to 20,000 characters; the task list shows at most 200
filtered matches (fewer if the serialized display budget is reached). Use the CLI for full text and unsupported task operations.

Consent receipts live under `$XDG_STATE_HOME/pinote/mcp-proposals` (default
`~/.local/state/pinote/mcp-proposals`). They contain no task content and are retained
to reject historical proposals. Do not delete them while old sessions may resume.
They are replay protection, not a second selection database or an authorization
boundary against local processes.

Each MCP process observes the shared database (including its WAL), settings, and
proposal receipts with coalesced, one-second stat checks. External CLI/GTK/other-session
changes refresh connected hosts; Ctrl+R or reopening the app remains a fallback.
Watchers stop on disconnect and never invoke the CLI or change task data.

Gateway 0.16.0+ negotiates per-control revisions: unrelated task-list changes no
longer invalidate preview/navigation, task creation, settings saves, or completion
of an unchanged selected task. Completion checks the displayed task revision;
selection starts its target with an atomic revision check. Settings writes check
the original file and resolved field definitions, including task-defined `Bar`
fields. Older hosts retain full-view revision checks without extra control fields.

Known stale-view rejections occur before writes and report **Action not applied**
on supporting hosts. Failed actions are never retried automatically: other errors
can follow a committed or partial write. Read fresh state before retrying.
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
