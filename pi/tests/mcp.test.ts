import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// Assert the wire limits independently of the service implementation.
const text = z.string().max(20_000);
const scalar = z.union([text, z.number(), z.boolean(), z.null()]);
const View = z.object({
  version: z.literal(1), title: text, revision: z.string().min(1).max(256), state: z.record(z.unknown()), body: text.optional(), retainOnNew: z.boolean().optional(),
  controls: z.array(z.object({ id: z.string().min(1).max(256), label: text, revision: z.string().min(1).max(256).optional(), kind: z.enum(['action', 'text', 'number', 'toggle', 'select']), value: scalar.optional(), icon: z.string().max(8).optional(), description: text.optional(), multiline: z.boolean().optional(), confirm: text.optional(), options: z.array(z.object({ label: text, value: scalar })).max(256).optional() }).strict()).max(256),
  footer: z.array(z.object({ text, url: z.string().max(2048).optional(), action: z.string().optional(), secondaryAction: z.string().optional(), width: z.number().int().min(3).max(1000).optional() }).strict()).max(128).optional(),
}).strict();

// One end-to-end case exercises the UI contract against the real CLI and database.
test('native UI owns tasks/settings, rejects stale writes, and restores host selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-mcp-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = join(dir, 'pi-note.json');
  await writeFile(config, JSON.stringify({ unrelated: true }));
  const connect = async () => {
    const client = new Client({ name: 'native-ui-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist-mcp/mcp/server.js')],
      env: { PINOTE_NOTE_COMMAND: join(root, '../.venv/bin/note'), PI_CODING_AGENT_DIR: pathToFileURL(dir).href, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    return client;
  };
  let client = await connect();
  let state: Record<string, unknown> = {};
  let scoped = false, secondary = false;
  const meta = () => ({ 'native-ui/context': { conversationId: 'conversation-a', state }, ...((scoped || secondary) ? { 'native-ui/features': { ...(scoped ? { actionRevisions: true } : {}), ...(secondary ? { footerSecondaryActions: true } : {}) } } : {}) });
  const read = async () => {
    const result = await client.readResource({ uri: 'pinote://ui', _meta: meta() });
    assert.ok('text' in result.contents[0]);
    assert.ok(result.contents[0].text.length <= 256_000);
    return View.parse(JSON.parse(result.contents[0].text));
  };
  const act = async (view: any, action: string, value?: unknown) => {
    const result = await client.request({ method: 'native-ui/action', params: { uri: 'pinote://ui', revision: view.controls.find((control: any) => control.id === action)?.revision ?? view.revision, action, value, _meta: meta() } }, z.object({ view: View, draft: text.optional(), preview: text.optional() }));
    state = result.view.state;
    return result;
  };
  try {
    assert.equal((await client.listResources()).resources[0].mimeType, 'application/vnd.mcp-native-ui+json');
    let view = await read(); state = view.state;
    assert.equal(view.state.selectedId, null);
    view = (await act(view, 'add', 'MCP task\n\nDetails')).view;
    const id = view.state.selectedId;
    assert.equal(typeof id, 'number');
    assert.match((await act(view, 'preview')).preview!, /Details/);
    const task = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    assert.equal(task.id, id);
    const update = await client.callTool({ name: 'update_current', arguments: { expected_updated_at: task.updated_at, set: { PR: 'https://github.com/example/repo/pull/42', '--Flag': 'remove me', Large: 'https://example.com/' + 'x'.repeat(3000) } }, _meta: meta() });
    assert.equal(update.isError, undefined);
    await assert.rejects(act(view, 'done'), /changed/);
    view = await read(); state = view.state;
    assert.ok(view.footer?.some((item) => item.url?.endsWith('/42')));
    view = (await act(view, 'screen:settings')).view;
    view = (await act(view, 'handoffPrompt', 'Read current task, then wait.')).view;
    assert.equal(JSON.parse(await readFile(config, 'utf8')).unrelated, true);
    await assert.rejects(act(view, 'maxFields', -1), /maxFields/);
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), external: 1 }));
    await assert.rejects(act(view, 'titleWidth', 30), /changed/);
    view = await read(); state = view.state;
    view = (await act(view, 'add-field', 'Next')).view;
    view = (await act(view, 'field:Next')).view;
    view = (await act(view, 'link', false)).view;
    view = (await act(view, 'screen:settings')).view;
    const unicodeName = '😀'.repeat(33);
    view = (await act(view, 'add-field', unicodeName)).view;
    view = (await act(view, `field:${unicodeName}`)).view;
    view = await read(); state = view.state;
    view = (await act(view, 'link', false)).view;
    view = (await act(view, 'screen:settings')).view;
    view = (await act(view, 'add-field', 'Large')).view;
    view = (await act(view, 'field:Large')).view;
    view = (await act(view, 'format', '<value>'.repeat(8))).view;
    assert.ok(view.footer?.some((item) => item.text.includes('example.com') && !item.url));
    const latest = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    const removed = await client.callTool({ name: 'update_current', arguments: { expected_updated_at: latest.updated_at, remove: ['--Flag'] }, _meta: meta() });
    assert.equal(removed.isError, undefined);
    view = await read(); state = view.state;
    view = (await act(view, 'screen:tasks')).view;
    assert.equal((await act(view, 'continue')).draft, 'Read current task, then wait.');
    const other = await client.callTool({ name: 'get_current', arguments: {}, _meta: { 'native-ui/context': { conversationId: 'conversation-b', state: {} } } });
    assert.equal((other.content as any[])[0].text, 'null');
    await client.close(); client = await connect();
    view = await read(); assert.equal(view.state.selectedId, id);
    const selected = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    const bar = ['x'.repeat(65), ...Array.from({ length: 300 }, (_, i) => `F${i}`)].join('\n');
    assert.equal((await client.callTool({ name: 'update_current', arguments: { expected_updated_at: selected.updated_at, set: { Bar: bar } }, _meta: meta() })).isError, undefined);
    const legacy = JSON.parse(await readFile(config, 'utf8')); legacy.footer.fields = null;
    await writeFile(config, JSON.stringify(legacy));
    view = await read(); state = view.state;
    view = (await act(view, 'screen:settings')).view;
    const derived = view.controls.filter((c) => c.id.startsWith('field:'));
    assert.equal(derived.length, 64);
    assert.ok(derived.every((c) => [...c.id.slice(6)].length <= 64));
    view = (await act(view, 'field:F0')).view;
    view = await read(); state = view.state;
    view = (await act(view, 'screen:tasks')).view;
    view = (await act(view, 'done')).view;
    assert.equal(view.state.selectedId, null);
    view = (await act(view, 'add', '--help')).view;
    view = (await act(view, 'done')).view;
    await promisify(execFile)(join(root, '../.venv/bin/python'), ['-c', 'from pathlib import Path; from pinote.store import Store; import sys\nwith Store(Path(sys.argv[1])) as store:\n for i in range(200): store.add(f"Task {i} " + "x" * 2000)', join(dir, 'pinote/notes.db')]);
    view = await read(); state = view.state;
    assert.ok(view.controls.filter((c) => c.id.startsWith('select:')).length < 200);
    view = (await act(view, 'search', 'Task 199')).view;
    assert.equal(view.controls.filter((c) => c.id.startsWith('select:')).length, 1);
    view = (await act(view, 'search', '')).view;
    const proposal = await client.callTool({ name: 'propose', arguments: { text: 'Suggested task\n\nDetails', tag: 'MCP' }, _meta: meta() });
    assert.equal(proposal.isError, undefined);
    state = proposal._meta!['native-ui/state'] as Record<string, unknown>;
    const first = await read();
    assert.ok(first.footer?.some((item) => item.action === 'proposal:accept'));
    assert.ok(first.footer?.every((item) => item.action !== 'proposal:dismiss' && item.secondaryAction === undefined), 'Legacy hosts use the app menu to dismiss, without a cross');
    const legacyResult = (await act(first, 'screen:settings')).view;
    assert.ok(legacyResult.footer?.every((item) => item.secondaryAction === undefined), 'Legacy action results omit unsupported fields too');
    secondary = true;
    const clickable = (await act(await read(), 'screen:tasks')).view;
    assert.equal(clickable.footer?.find((item) => item.action === 'proposal:accept')?.secondaryAction, 'proposal:dismiss');
    assert.ok(clickable.footer?.every((item) => item.action !== 'proposal:dismiss'));
    const replaced = await client.callTool({ name: 'propose', arguments: { text: 'Replacement task', tag: 'MCP' }, _meta: meta() });
    const oldState = state;
    state = replaced._meta!['native-ui/state'] as Record<string, unknown>;
    view = await read();
    assert.notEqual(first.revision, view.revision);
    await assert.rejects(act(first, 'proposal:accept'), /changed/);
    view = (await act(view, 'proposal:accept')).view;
    assert.equal(view.retainOnNew, true);
    const acceptedId = view.state.selectedId;
    assert.equal(typeof acceptedId, 'number');
    const accepted = JSON.parse(((await client.callTool({ name: 'get_current', arguments: {}, _meta: meta() })).content as any[])[0].text);
    assert.equal(accepted.tag, 'MCP');
    assert.equal(accepted.text, 'Replacement task');
    assert.ok(view.footer?.some((item) => item.action === 'preview'));
    assert.ok(view.footer?.some((item) => item.action === 'done'));
    assert.equal((await client.callTool({ name: 'propose', arguments: { text: 'Forbidden' }, _meta: meta() })).isError, true);
    view = (await act(view, 'done')).view;
    const emptyState = state;
    state = oldState;
    await client.close(); client = await connect();
    assert.equal((await read()).state.proposal, null, 'Replaced proposal cannot be resurrected by branch restore/reconnect');
    state = replaced._meta!['native-ui/state'] as Record<string, unknown>;
    assert.equal((await read()).state.proposal, null, 'Accepted consent cannot be replayed');
    state = emptyState;
    const dismissible = await client.callTool({ name: 'propose', arguments: { text: 'Dismiss me' }, _meta: meta() });
    state = dismissible._meta!['native-ui/state'] as Record<string, unknown>;
    view = (await act(await read(), 'proposal:dismiss')).view;
    assert.equal(view.state.proposal, null);
    assert.equal(view.state.selectedId, null);
    // Negotiated controls only invalidate dependencies of the requested action.
    scoped = true;
    view = await read(); state = view.state;
    assert.ok(view.controls.every((control) => control.revision));
    view = (await act(view, 'search', 'External')).view;
    view = (await act(view, 'add', 'Scoped task')).view;
    const displayed = view;
    const external = async (...args: string[]) => (await promisify(execFile)(join(root, '../.venv/bin/note'), ['--no-notify', ...args], {
      env: { ...process.env, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir },
    })).stdout;
    const observer = await connect();
    const observedChange = async (write: () => Promise<unknown>, matches: (next: any) => boolean, observerState: Record<string, unknown> = {}) => {
      let timeout: ReturnType<typeof setTimeout>;
      const changed = new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('External write did not notify the other MCP process')), 8000);
        observer.setNotificationHandler(z.object({ method: z.literal('notifications/native-ui/changed'), params: z.object({ uri: z.literal('pinote://ui') }) }), async () => {
          try {
            const result = await observer.readResource({ uri: 'pinote://ui', _meta: { 'native-ui/context': { conversationId: 'observer', state: observerState } } });
            if ('text' in result.contents[0] && matches(JSON.parse(result.contents[0].text))) resolve();
          } catch (error) { reject(error); }
        });
      });
      try { await write(); await changed; } finally { clearTimeout(timeout!); }
    };
    try {
      let other: any;
      await observedChange(async () => { other = JSON.parse(await external('agent', 'add', '--text', 'External task')); },
        (next) => next.controls.some((control: any) => control.id === `select:${other?.id}`), { search: 'External' });
      assert.notEqual((await read()).revision, displayed.revision);
      assert.match((await act(displayed, 'preview')).preview!, /Scoped task/);
      view = (await act(displayed, 'done')).view;
      const selectable = view;
      await external('agent', 'add', '--text', 'Another unrelated task');
      view = (await act(selectable, `select:${other.id}`)).view;
      const selectedView = view;
      let current = JSON.parse(await external('agent', 'get', String(other.id)));
      await external('agent', 'update', String(other.id), '--expected-updated-at', current.updated_at, '--set-json', JSON.stringify({ Bar: 'Before' }));
      const rejected = (error: unknown) => error instanceof McpError && error.code === -33003 &&
        (error.data as any)?.['native-ui/action']?.status === 'not-applied';
      await assert.rejects(act(selectedView, 'done'), rejected);
      assert.match((await act(selectedView, 'preview')).preview!, /Before/);
      view = (await act(await read(), 'screen:settings')).view;
      await external('agent', 'add', '--text', 'Settings must survive this unrelated task');
      view = (await act(view, 'titleWidth', 82)).view;
      const document = JSON.parse(await readFile(config, 'utf8'));
      document.footer.fields = null;
      await observedChange(async () => {
        await writeFile(`${config}.tmp`, JSON.stringify(document)); await rename(`${config}.tmp`, config);
      }, (next) => next.controls.some((control: any) => control.id === 'titleWidth' && control.value === 82), { screen: 'settings' });
      view = await read(); state = view.state;
      view = (await act(view, 'field:Before')).view;
      current = JSON.parse(await external('agent', 'get', String(other.id)));
      await external('agent', 'update', String(other.id), '--expected-updated-at', current.updated_at, '--set-json', JSON.stringify({ Bar: 'Before\nAfter' }));
      await assert.rejects(act(view, 'width', 90), rejected, 'Derived field definitions are part of settings consent');
      assert.equal(JSON.parse(await readFile(config, 'utf8')).footer.fields, null);
      const legacy = await observer.readResource({ uri: 'pinote://ui', _meta: { 'native-ui/context': { conversationId: 'legacy', state: {} } } });
      assert.ok('text' in legacy.contents[0]);
      assert.ok(JSON.parse(legacy.contents[0].text).controls.every((control: any) => control.revision === undefined));
      view = await read(); state = view.state;
      view = (await act(view, 'done')).view;
      const receipt = await client.callTool({ name: 'propose', arguments: { text: 'Cross-process receipt' }, _meta: meta() });
      state = receipt._meta!['native-ui/state'] as Record<string, unknown>;
      view = await read(); state = view.state;
      const pendingState = { ...state };
      await observedChange(() => act(view, 'proposal:dismiss'), (next) => next.state.proposal === null, pendingState);
    } finally { await observer.close(); }
    const saved = await readFile(config, 'utf8');
    await writeFile(config, JSON.stringify({ ...JSON.parse(saved), taskOfferPolicy: null }));
    await assert.rejects(read(), /taskOfferPolicy/);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).taskOfferPolicy, null);
    assert.ok(!(await client.listTools()).tools.some((t) => /settings|action/.test(t.name)), 'UI writes are not model tools');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
