# Standalone Pinote service

Pinote runs independently of the MCP gateway. The [dedicated Pi extension](../README.md)
connects directly over authenticated **MCP Streamable HTTP**, using `/mcp` for tools,
resources, notifications and its native terminal UI. No browser UI is served.

## Build and run

On the machine holding your notes, requires **Node.js 22.19+**, **Python 3.11+**
and the checkout's `note` CLI:

```sh
uv sync --locked
npm --prefix pi ci --ignore-scripts
npm --prefix pi run build:mcp
export PINOTE_NOTE_COMMAND="$PWD/.venv/bin/note"
# Load PINOTE_TOKEN from a private environment file/secret manager.
npm --prefix pi run serve
```

The bearer token is mandatory, including on loopback: use at least 32 random
non-whitespace characters. Store it in an owner-only regular file (mode `0600`),
never commit or paste it into a conversation. For a new setup, after creating the
private agent directory:

```sh
(umask 077; openssl rand -hex 32 > /absolute/path/to/private/pinote-token)
export PINOTE_TOKEN_FILE=/absolute/path/to/private/pinote-token
```

Do not overwrite an existing token during an upgrade. Copy it securely to each
client's private token file, or use your secret manager's `PINOTE_TOKEN` environment.

| Variable | Default / purpose |
|---|---|
| `PINOTE_TOKEN` | Bearer token shared with authorized clients; overrides the file |
| `PINOTE_TOKEN_FILE` | Owner-only regular file; defaults to `<Pi agent directory>/pinote-token` |
| `PINOTE_HOST` | `127.0.0.1`; explicit bind address |
| `PINOTE_PORT` | `8765` |
| `PINOTE_ALLOWED_HOSTS` | Comma-separated exact HTTP authorities; include port when clients send one |
| `PINOTE_NOTE_COMMAND` | `note`; executable path, never a shell command |
| `PINOTE_LOG_PATH` | `app.log` in the launch directory |
| `PI_CODING_AGENT_DIR` | Server-side settings directory; normally `~/.pi/agent` |
| `XDG_DATA_HOME` / `XDG_STATE_HOME` | Optional Pinote data/state locations |

Children run as your user. The service uses the same local database as the CLI and
GTK app: normally `~/.local/share/pinote/notes.db`. Only the **service machine**
needs Python or access to that file. Do not put SQLite/WAL files on a VM network
share. Point every client at the service instead.

## Remote access

The Node listener is plaintext HTTP. **Never expose it directly to the public
Internet.** Use a private VPN or a trusted HTTPS reverse proxy. The proxy must
forward `/mcp`, bearer authorization, MCP headers and streaming responses without
buffering, preserve the external Host, and allow long-lived SSE connections.

For example, a local reverse proxy serving `https://notes.example.net/mcp` forwards
to `http://127.0.0.1:8765/mcp`; set:

```sh
PINOTE_ALLOWED_HOSTS=notes.example.net
```

Without an explicit allowlist, only the bound non-wildcard address/port is accepted.
A `0.0.0.0` or `::` bind requires an explicit allowlist of client-facing authorities.
Browser Origin headers are rejected by default; no CORS or browser login is exposed.
A private-VPN plaintext client must explicitly set `PINOTE_ALLOW_HTTP=1`; this is a
**client** opt-in, not encryption or server-side authorization.

An SSH tunnel is also sufficient: on the VM run
`ssh -N -L 8765:127.0.0.1:8765 host`, then use the default loopback endpoint with
the same private token. HTTP travels inside SSH; no public listener is needed.

One token grants full access to this user's Pinote service, including shared
settings. It is not multi-user authorization. Protect it like your notes. Token
rotation requires restarting the service and updating client credentials.

## Run continuously

A [systemd user-unit template](../deploy/pinote.service) is included. Replace its
absolute checkout, Node and CLI paths and review it before installation. Store the
environment file outside the repository with mode `0600`:

```ini
PINOTE_TOKEN_FILE=/absolute/path/to/private/pinote-token
PINOTE_NOTE_COMMAND=/absolute/path/to/pinote/.venv/bin/note
PINOTE_LOG_PATH=/absolute/path/to/private/state/pinote/app.log
# Set only when using a proxy or a remote bind:
# PINOTE_ALLOWED_HOSTS=notes.example.net
```

Install the reviewed unit under your user systemd directory, then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now pinote.service
journalctl --user -u pinote.service
```

This starts at login and survives closing Pi. Running before login requires
administrator-approved user lingering. Your machine must remain awake and reachable.
Installation never creates the unit, changes lingering, or edits personal config
automatically. Logs go to stdout/journal and `app.log`; arguments, results, tokens
and task content are not logged. Arrange external rotation if needed.

## Sessions and failures

Each HTTP MCP session has its own protocol server. Conversation/branch state is
supplied by the dedicated Pi extension, so two clients never share a global
selection. Notes and saved settings remain shared. Read/check/write operations
serialize within this daemon and mutations use database/config revisions.

The service bounds request bodies and session counts, and expires idle disconnected
sessions. Active streams and operations are not expired. Shutdown closes sessions;
a server restart preserves notes but requires clients to reconnect. No durable SSE
replay, offline writes or automatic mutation retries are provided. After an
interrupted write, read fresh state before retrying: it may already have committed.

The native terminal UI protocol and `pinote://agent-context` resource are internal
to Pinote's extension/service integration. Registering the endpoint through a plain
MCP client does not supply its conversation state or render the task app. The stdio
entry point remains available for compatible clients and protocol tests; it is not
needed for deployment.

## Validate

From the checkout root:

```sh
uv sync --locked
npm --prefix pi test
```

Tests use temporary data and real HTTP/stdio connections, including authentication,
shared notes, independent selections, conflicts and reconnects. Visual checks use
Xvfb and private D-Bus; never point them at personal data.
