import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

// Assert the wire limits independently of the service implementation.
const text = z.string().max(20_000);
const scalar = z.union([text, z.number(), z.boolean(), z.null()]);
const View = z.object({
  version: z.literal(1), title: text, revision: z.string().min(1).max(256), state: z.record(z.unknown()), body: text.optional(),
  controls: z.array(z.object({ id: z.string().min(1).max(256), label: text, kind: z.enum(['action', 'text', 'number', 'toggle', 'select']), value: scalar.optional(), icon: z.string().max(8).optional(), description: text.optional(), multiline: z.boolean().optional(), confirm: text.optional(), options: z.array(z.object({ label: text, value: scalar })).max(256).optional() }).strict()).max(256),
  footer: z.array(z.object({ text, url: z.string().max(2048).optional(), width: z.number().int().min(3).max(1000).optional() }).strict()).max(128).optional(),
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
  const meta = () => ({ 'native-ui/context': { conversationId: 'conversation-a', state } });
  const read = async () => {
    const result = await client.readResource({ uri: 'pinote://ui', _meta: meta() });
    assert.ok('text' in result.contents[0]);
    assert.ok(result.contents[0].text.length <= 256_000);
    return View.parse(JSON.parse(result.contents[0].text));
  };
  const act = async (view: any, action: string, value?: unknown) => {
    const result = await client.request({ method: 'native-ui/action', params: { uri: 'pinote://ui', revision: view.revision, action, value, _meta: meta() } }, z.object({ view: View, draft: text.optional(), preview: text.optional() }));
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
    view = (await act(view, 'done')).view;
    assert.equal(view.state.selectedId, null);
    view = (await act(view, 'add', '--help')).view;
    view = (await act(view, 'done')).view;
    await promisify(execFile)(join(root, '../.venv/bin/python'), ['-c', 'from pathlib import Path; from pinote.store import Store; import sys\nwith Store(Path(sys.argv[1])) as store:\n for i in range(200): store.add(f"Task {i} " + "x" * 2000)', join(dir, 'pinote/notes.db')]);
    view = await read(); state = view.state;
    assert.ok(view.controls.filter((c) => c.id.startsWith('select:')).length < 200);
    view = (await act(view, 'search', 'Task 199')).view;
    assert.equal(view.controls.filter((c) => c.id.startsWith('select:')).length, 1);
    const saved = await readFile(config, 'utf8');
    await writeFile(config, JSON.stringify({ ...JSON.parse(saved), taskOfferPolicy: null }));
    await assert.rejects(read(), /taskOfferPolicy/);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).taskOfferPolicy, null);
    assert.ok(!(await client.listTools()).tools.some((t) => /settings|action/.test(t.name)), 'UI writes are not model tools');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
