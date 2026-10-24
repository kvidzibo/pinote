import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { remoteConfig, RemoteFailure, type Peer, type PeerFactory } from '../remote/client.ts';
import { ENTRY_TYPE, RemoteSession, restoreState, type SavedState } from '../remote/session.ts';
import { UI_CONTEXT, UI_FEATURES, UI_STATE, type NativeView } from '../remote/protocol.ts';
import { toolDefinitions } from '../remote/tools.ts';

const token = 'private-token-never-log-01234567890123456789';
const config = remoteConfig({ PINOTE_TOKEN: token });
const view = (state = {}): NativeView => ({ version: 1, title: 'Pinote', revision: 'view-1', state, retainOnNew: true,
  controls: [{ id: 'complete', kind: 'action', label: 'Complete', revision: 'task-1' }], footer: [{ text: 'Task', action: 'complete' }] });
const resource = (value: NativeView) => ({ contents: [{ mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify(value) }] });
function harness(overrides: Partial<Peer> = {}) {
  const saved: SavedState[] = [], metas: Record<string, unknown>[] = [];
  let connections = 0, changed = () => {};
  const peer: Peer = {
    read: async (uri, meta) => {
      metas.push(structuredClone(meta));
      return uri === 'pinote://ui' ? resource(view((meta[UI_CONTEXT] as SavedState).state)) :
        { contents: [{ mimeType: 'application/vnd.mcp-agent-context+json', text: JSON.stringify({ version: 1, text: 'fresh task data' }) }] };
    },
    tool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    action: async () => ({ view: view({ selectedId: null }) }), close: async () => {}, ...overrides,
  };
  const factory: PeerFactory = async (_config, _signal, notify) => { connections++; changed = notify; return peer; };
  const session = new RemoteSession(config, (state) => saved.push(structuredClone(state)), factory);
  return { session, saved, metas, connections: () => connections, changed: () => changed() };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

 test('endpoint safety, stable credential-free scope, and no configuration secret disclosure', () => {
  assert.equal(config.url.href, 'http://127.0.0.1:8765/mcp');
  assert.equal(config.scope, remoteConfig({ PINOTE_TOKEN: 'x'.repeat(32) }).scope);
  for (const url of ['http://private.example/mcp', 'ftp://localhost/mcp', `https://user:${token}@host/mcp`, `https://host/mcp?token=${token}`, token]) {
    assert.throws(() => remoteConfig({ PINOTE_TOKEN: token, PINOTE_URL: url }), (error: Error) => !error.message.includes(token));
  }
  assert.throws(() => remoteConfig({ PINOTE_TOKEN: 'short' }), /at least 32/);
  assert.doesNotThrow(() => remoteConfig({ PINOTE_TOKEN: token, PINOTE_URL: 'http://vpn/mcp', PINOTE_ALLOW_HTTP: '1' }));
  assert.doesNotThrow(() => remoteConfig({ PINOTE_TOKEN: token, PINOTE_URL: 'https://remote/mcp' }));
  const dir = mkdtempSync(join(tmpdir(), 'pinote-token-'));
  const file = join(dir, 'token');
  try {
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    assert.equal(remoteConfig({ PINOTE_TOKEN_FILE: file }).token, token);
    chmodSync(file, 0o644);
    assert.throws(() => remoteConfig({ PINOTE_TOKEN_FILE: file }), /owner-only/);
    assert.throws(() => remoteConfig({ PINOTE_TOKEN: `${token} ` }), /non-whitespace/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('branch-only restoration, endpoint isolation and independent unrelated launch', async () => {
  const a = restoreState([], config.scope), b = restoreState([], config.scope);
  assert.notEqual(a.contextId, b.contextId);
  const branch = [{ type: 'custom', customType: ENTRY_TYPE, data: { ...a, state: { selectedId: 7 } } }];
  assert.equal(restoreState(branch, config.scope).state.selectedId, 7);
  assert.deepEqual(restoreState(branch, 'another endpoint').state, {});
  const h = harness();
  await h.session.start(branch, 'pi-session');
  assert.equal((h.metas[0][UI_CONTEXT] as any).contextId, a.contextId);
  assert.equal((h.metas[0][UI_CONTEXT] as any).conversationId, 'pi-session');
  assert.equal((h.metas[0][UI_FEATURES] as any).actionRevisions, true);
  const carried = h.session.snapshot();
  await h.session.start([], 'new-pi-session', carried);
  assert.equal(h.session.snapshot()?.state.selectedId, 7);
  assert.equal(h.session.snapshot()?.contextId, a.contextId);
  await h.session.start([], 'unrelated');
  assert.deepEqual(h.session.snapshot()?.state, {});
  await h.session.stop();
});

test('seven explicit direct schemas; tool state is applied before next serialized call', async () => {
  assert.deepEqual(toolDefinitions.map((t) => t.name).sort(), ['fields', 'get_current', 'get_task', 'propose', 'search', 'tags', 'update_current']);
  const seen: unknown[] = [];
  const h = harness({ tool: async (_name, _args, meta) => {
    seen.push(structuredClone((meta[UI_CONTEXT] as any).state));
    await sleep(10);
    return { content: [{ type: 'text', text: 'ok' }], _meta: { [UI_STATE]: { selectedId: 19 } } };
  } });
  await h.session.start([], 'conversation');
  await Promise.all([h.session.tool('propose', { text: 'task' }), h.session.tool('get_current', {})]);
  assert.deepEqual(seen, [{}, { selectedId: 19 }]);
  assert.equal(h.session.snapshot()?.state.selectedId, 19);
  assert.equal(await h.session.context(), 'fresh task data');
  await h.session.stop();
});

test('mutations never replay; transport errors are secret-free, reconnect is explicit and lazy', async () => {
  let calls = 0;
  const h = harness({ tool: async () => { calls++; throw new Error(`Authorization Bearer ${token}`); } });
  await h.session.start([], 'conversation');
  await assert.rejects(h.session.tool('update_current', { expected_updated_at: 'old' }), (e: Error) => e.message.includes('may have committed') && !e.message.includes(token));
  assert.equal(calls, 1); assert.equal(h.connections(), 1); assert.equal(h.session.view, undefined);
  h.changed(); await sleep(100);
  assert.equal(h.connections(), 1);
  await h.session.refresh(true);
  assert.equal(h.connections(), 2); assert.equal(calls, 1);
  await h.session.stop();
});

test('server isError throws, failed fresh context is unavailable rather than cached/no-task', async () => {
  let fail = false;
  const h = harness({
    tool: async () => ({ isError: true, content: [{ type: 'text', text: token }] }),
    read: async (uri) => {
      if (uri === 'pinote://ui') return resource(view());
      if (fail) throw new Error(token);
      return { contents: [{ mimeType: 'application/vnd.mcp-agent-context+json', text: '{"version":1,"text":"selected task"}' }] };
    },
  });
  await h.session.start([], 'conversation');
  assert.equal(await h.session.context(), 'selected task'); fail = true;
  await assert.rejects(h.session.context(), RemoteFailure);
  await assert.rejects(h.session.tool('get_current', {}), RemoteFailure);
  await h.session.stop();
});

test('session epoch cancels queued and in-flight work without state contamination', async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const h = harness({ tool: async () => { calls++; started(); await waiting; return { content: [], _meta: { [UI_STATE]: { selectedId: 99 } } }; } });
  await h.session.start([], 'old');
  const first = h.session.tool('propose', { text: 'old' });
  const second = h.session.tool('propose', { text: 'queued' });
  const rejected = Promise.all([assert.rejects(first, RemoteFailure), assert.rejects(second, RemoteFailure)]);
  await began;
  await h.session.start([], 'new');
  release(); await rejected;
  assert.equal(calls, 1); assert.deepEqual(h.session.snapshot()?.state, {});
  assert.ok(!h.saved.some((state) => state.state.selectedId === 99));
  await h.session.stop();
});

test('stale displayed revisions fail closed; stale server error is definitely not-applied', async () => {
  let actions = 0;
  const h = harness({ action: async () => { actions++; throw new McpError(-33003, token, { 'native-ui/action': { status: 'not-applied', reason: 'stale-view' } }); } });
  await h.session.start([], 'conversation');
  const old = view(); old.controls[0].revision = 'obsolete';
  await assert.rejects(h.session.action(old, old.controls[0]), (e: RemoteFailure) => e.stale && !e.uncertain);
  assert.equal(actions, 0);
  const current = h.session.view!;
  await assert.rejects(h.session.action(current, current.controls[0]), (e: RemoteFailure) => e.stale && !e.message.includes(token));
  assert.equal(actions, 1);
  await h.session.stop();
});

test('change notifications coalesce and never reconnect or start model work', async () => {
  let reads = 0;
  const h = harness({ read: async () => { reads++; await sleep(15); return resource(view()); } });
  await h.session.start([], 'conversation');
  for (let i = 0; i < 50; i++) h.changed();
  await sleep(120);
  assert.equal(reads, 2); assert.equal(h.connections(), 1);
  await h.session.stop(); h.changed(); await sleep(100);
  assert.equal(reads, 2);
});

test('real direct Streamable HTTP handshake, auth, empty capabilities and per-call metadata', async () => {
  const methods: string[] = [], metas: any[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); methods.push(message.method);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test-pinote', version: '1' } };
    else if (message.method === 'resources/read') {
      metas.push(message.params._meta);
      result = message.params.uri === 'pinote://ui' ? resource(view()) : { contents: [{ uri: 'pinote://agent-context', mimeType: 'application/vnd.mcp-agent-context+json', text: '{"version":1,"text":"fresh HTTP context"}' }] };
      if (message.params.uri === 'pinote://ui') (result as any).contents[0].uri = 'pinote://ui';
    } else result = { content: [{ type: 'text', text: 'remote task' }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const remote = new RemoteSession(remoteConfig({ PINOTE_URL: `http://127.0.0.1:${address.port}/mcp`, PINOTE_TOKEN: token }), () => {});
  try {
    await remote.start([], 'pi-conversation-not-http-id');
    assert.equal(await remote.context(), 'fresh HTTP context');
    await remote.tool('get_current', {});
    assert.ok(methods.includes('initialize')); assert.ok(methods.includes('tools/call'));
    assert.ok(metas.every((meta) => meta[UI_CONTEXT].conversationId === 'pi-conversation-not-http-id' && meta[UI_FEATURES].actionRevisions));
  } finally { await remote.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('native fullscreen footer keeps preview and double completion/acceptance distinct', async () => {
  const { NativeFooter } = await import('../remote/footer.ts');
  const calls: Array<string | undefined> = [];
  const current = view();
  current.controls.push({ id: 'preview', label: 'Preview', kind: 'action', revision: 'task-1' });
  current.footer = [{ text: '▤ ', openApp: true }, { text: 'Task', action: 'preview', doubleAction: 'complete' }];
  const theme = { fg: (_color: string, text: string) => text, italic: (text: string) => text } as any;
  const footer = new NativeFooter(() => [{ uri: 'pinote://ui', view: current }], theme,
    async (_row, item, action) => { calls.push(item.openApp ? 'open' : action); return true; }, () => {});
  footer.render(80);
  const click = (x: number, clickCount: number) => footer.handleMouse({ type: 'click', button: 'left', x, y: 0, clickCount } as any);
  click(3, 1); click(3, 2); await sleep(5);
  assert.deepEqual(calls, ['complete']);
  click(3, 1); await sleep(520);
  assert.deepEqual(calls, ['complete', 'preview']);
  click(0, 1); await sleep(5);
  assert.deepEqual(calls, ['complete', 'preview', 'open']);
  // A proposal has no single-click mutation, only a separately negotiated double action.
  current.footer = [{ text: '? Proposal', doubleAction: 'complete' }]; footer.render(80);
  click(1, 1); await sleep(520); assert.equal(calls.length, 3);
  click(1, 1); click(1, 2); await sleep(5); assert.equal(calls.length, 4);
  footer.dispose();
});

test('required review has no default approval and non-TUI review cannot authorize actions', async () => {
  const { review } = await import('../remote/ui.ts');
  const controller = new AbortController();
  let options: string[] = [];
  const ctx = {
    mode: 'tui', ui: {
      custom: async (factory: any) => new Promise((resolve) => {
        const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
        const theme = { fg: (_color: string, text: string) => text };
        const keys = { matches: (data: string, action: string) => action === 'tui.select.confirm' && data === '\r' };
        const component = factory(tui, theme, keys, resolve);
        component.render(80); component.handleInput('\r'); component.dispose();
      }),
      select: async (_title: string, values: string[]) => { options = values; return values[0]; },
    },
  } as any;
  assert.equal(await review(ctx, 'Confirm change', 'All change details', controller.signal), false);
  assert.deepEqual(options, ['Cancel', 'Confirm']);
  assert.equal(await review({ mode: 'rpc' } as any, 'Confirm', 'details', controller.signal), false);
});

test('remote menu bounds native layout and preserves search/selection across notification refresh and resize', async () => {
  const { remoteMenu } = await import('../remote/menu.ts');
  const { initTheme } = await import('@earendil-works/pi-coding-agent');
  initTheme('dark', false);
  const { getKeybindings, visibleWidth } = await import('@earendil-works/pi-tui');
  const state = { search: '', selected: undefined as string | undefined };
  const current = view({ screen: 'settings' });
  current.body = 'Summary '.repeat(100);
  current.controls = Array.from({ length: 20 }, (_, i) => ({ id: `setting-${i}`, kind: 'toggle' as const,
    label: `Setting ${i}`, value: false, description: 'Long selected setting help '.repeat(100) }));
  const tui = { terminal: { rows: 24, columns: 56 }, children: [] as any[], requestRender() {} };
  const theme = { fg: (_color: string, text: string) => text };
  const controller = new AbortController();
  let component: any, changed = () => {}, result: any;
  const ctx = { ui: { custom: async (factory: any) => new Promise((resolve) => {
    component = factory(tui, theme, getKeybindings(), (value: any) => { result = value; resolve(value); });
    // Pi's transcript, inline custom owner, and native footer/widget siblings.
    tui.children = [{ render: () => [] }, { children: [component] }, { render: () => Array(7).fill('footer') }];
  }) } } as any;
  const watch = (callback: () => void) => { changed = callback; return () => {}; };
  const bounded = () => {
    const rows = component.render(tui.terminal.columns);
    assert.ok(rows.length <= tui.terminal.rows - 8, `${rows.length} rows overflow reserved footer`);
    assert.ok(rows.every((row: string) => visibleWidth(row) <= tui.terminal.columns));
    assert.match(rows.join('\n'), /Ctrl\+R refresh/);
    return rows;
  };
  const first = remoteMenu(ctx, current, state, controller.signal, watch);
  bounded();
  component.handleInput('Setting'); component.handleInput('\r');
  assert.equal(typeof result, 'undefined', 'Unrendered filter changes cannot activate a stale row');
  component.render(56);
  component.handleInput('\x1b[B'); bounded();
  assert.equal(state.search, 'Setting'); assert.equal(state.selected, 'setting-1');
  changed(); assert.deepEqual(await first, { id: '__changed' }); component.dispose();
  const second = remoteMenu(ctx, current, state, controller.signal, watch);
  bounded(); assert.equal(state.selected, 'setting-1');
  // Input in a new geometry must not activate until that geometry has rendered.
  tui.terminal.columns = 40; component.handleInput('\r'); assert.equal(result.id, '__changed');
  bounded(); assert.equal(state.selected, 'setting-1');
  tui.terminal.rows = 12; component.render(40); component.handleInput('\r');
  assert.equal(result.id, '__changed');
  tui.terminal.rows = 30; tui.terminal.columns = 80; bounded();
  assert.equal(state.search, 'Setting'); assert.equal(state.selected, 'setting-1');
  component.handleInput('\r');
  assert.deepEqual(await second, { id: 'setting-1', value: 'true' }); component.dispose();
});

test('extension registers seven tools before startup and injects unavailable instead of stale task data', async () => {
  const { default: extension } = await import('../remote.ts');
  const tools: string[] = [], commands: string[] = [], handlers = new Map<string, (...args: any[]) => any>();
  extension({
    registerTool: (tool: any) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    registerEntryRenderer() {},
    events: { on() { return () => {}; } },
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  } as any);
  assert.equal(tools.length, 7);
  assert.ok(tools.every((name) => name.startsWith('pinote_')));
  assert.deepEqual(commands, ['pinote', 'pi-note']);
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  await handlers.get('before_agent_start')!(event, {});
  assert.match(event.systemPromptOptions.sections.pinote_remote, /UNAVAILABLE/);
  assert.match(event.systemPromptOptions.sections.pinote_remote, /UNTRUSTED TASK DATA/);
  assert.match(event.systemPromptOptions.sections.pinote_remote, /Do not infer no task/);
});
