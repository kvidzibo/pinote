import { createHash } from 'node:crypto';
import { pinoteToken } from '../token.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ResourceListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ActionResultSchema, ChangedSchema, StaleActionDataSchema, UI_STALE_ACTION } from './protocol.ts';

export interface RemoteConfig { url: URL; token: string; scope: string }
/** PINOTE_ALLOW_HTTP=1 explicitly permits plaintext on a trusted private VPN. */
export function remoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const token = pinoteToken(env);
  let url: URL;
  try { url = new URL(env.PINOTE_URL ?? 'http://127.0.0.1:8765/mcp'); }
  catch { throw new Error('Invalid PINOTE_URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('PINOTE_URL must not contain credentials, query, or fragment');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || env.PINOTE_ALLOW_HTTP === '1'))) {
    throw new Error('Remote Pinote requires HTTPS; PINOTE_ALLOW_HTTP=1 permits a trusted private VPN');
  }
  return { url, token, scope: createHash('sha256').update(url.href).digest('hex') };
}
export class RemoteFailure extends Error {
  readonly uncertain: boolean;
  readonly stale: boolean;
  constructor(uncertain = false, stale = false) {
    super(stale ? 'Action not applied: view changed. Refresh and review before retrying.' :
      `Pinote request failed.${uncertain ? ' The write may have committed; refresh before retrying.' : ' Context unavailable; retry an explicit call to reconnect.'}`);
    this.uncertain = uncertain && !stale; this.stale = stale;
  }
}
export interface Peer {
  read(uri: string, meta: Record<string, unknown>, signal: AbortSignal): Promise<{ contents: Array<{ text?: string; mimeType?: string }> }>;
  tool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  action(params: Record<string, unknown>, signal: AbortSignal): Promise<ReturnType<typeof ActionResultSchema.parse>>;
  close(): Promise<void>;
}
export type PeerFactory = (config: RemoteConfig, signal: AbortSignal, changed: () => void, disconnected: () => void) => Promise<Peer>;
export const connectPeer: PeerFactory = async (config, signal, changed, disconnected) => {
  const client = new Client({ name: 'pinote-pi', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(config.url, {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error' },
    // Never replay POSTs, resume streams, or reconnect behind the caller's epoch.
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: init?.method === 'DELETE'
      ? AbortSignal.timeout(1000) // Bounded session cleanup remains possible after operation cancellation.
      : AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
  });
  let closing = false;
  // Losing the notification stream must clear the idle UI, not silently leave a stale view.
  // SDK errors can contain response bodies/URLs; expose only our stable failure messages.
  client.onerror = () => {
    if (closing) return;
    closing = true; disconnected();
    void client.close().catch(() => {});
  };
  client.onclose = () => { closing = true; disconnected(); };
  client.setNotificationHandler(ChangedSchema, changed);
  client.setNotificationHandler(ResourceListChangedNotificationSchema, changed);
  const abort = () => { void client.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal, timeout: 10_000 });
    signal.throwIfAborted();
  } catch {
    signal.removeEventListener('abort', abort);
    await client.close().catch(() => {});
    throw new RemoteFailure();
  }
  const options = (operation: AbortSignal) => ({ signal: AbortSignal.any([signal, operation]), timeout: 20_000 });
  return {
    read: (uri, meta, operation) => client.readResource({ uri, _meta: meta }, options(operation)),
    tool: (name, args, meta, operation) => client.callTool({ name, arguments: args, _meta: meta }, undefined, options(operation)) as Promise<CallToolResult>,
    action: (params, operation) => client.request({ method: 'native-ui/action', params }, ActionResultSchema, options(operation)),
    async close() {
      closing = true;
      signal.removeEventListener('abort', abort);
      // Pinote owns no detached jobs: release the HTTP session rather than waiting for idle expiry.
      try { await transport.terminateSession(); } catch { /* A dropped server may already have discarded it. */ }
      await client.close();
    },
  };
};
/** Stable errors only: neither env credentials nor transport/server error bodies escape. */
export function remoteFailure(error: unknown, mutation: boolean): RemoteFailure {
  return new RemoteFailure(mutation, error instanceof McpError && error.code === UI_STALE_ACTION && StaleActionDataSchema.safeParse(error.data).success);
}
