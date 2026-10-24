import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { request } from 'node:http';

test('authenticated HTTP sessions share notes, not host selection, and reconnect without replaying writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-http-'));
  const token = 'http-integration-secret-'.repeat(3);
  const names = ['PINOTE_NOTE_COMMAND', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR'];
  const previous = names.map((name) => process.env[name]);
  Object.assign(process.env, {
    PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../.venv/bin/note', import.meta.url)),
    XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: pathToFileURL(dir).href,
  });
  const { startPinoteHttpServer } = await import('../mcp/http.ts');
  const service = await startPinoteHttpServer({ token, port: 0, logPath: join(dir, 'app.log'), maxSessions: 4 });
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ name: 'http-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    clients.push(client);
    return { client, transport };
  };
  const meta = (conversationId: string, state: Record<string, unknown> = {}) => ({ 'native-ui/context': { conversationId, state } });
  const content = (result: any) => JSON.parse(result.content[0].text);
  const read = async (client: Client, state: Record<string, unknown> = {}) => {
    const result = await client.readResource({ uri: 'pinote://ui', _meta: meta('a', state) });
    assert.ok('text' in result.contents[0]);
    return JSON.parse(result.contents[0].text);
  };
  try {
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal((await fetch(service.url, { method })).status, 401);
    }
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(service.url, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
    const rawStatus = (rawHeaders: string[]) => new Promise<number>((ok, fail) => {
      const req = request(service.url, { headers: rawHeaders }, (res) => { res.resume(); ok(res.statusCode!); });
      req.on('error', fail);
      req.end();
    });
    assert.equal(await rawStatus(['Authorization', `Bearer ${token}`, 'Host', 'evil.invalid']), 403);
    assert.equal(await rawStatus(['Authorization', `Bearer ${token}`, 'Host', new URL(service.url).host, 'Mcp-Session-Id', 'one', 'Mcp-Session-Id', 'two']), 400);
    assert.equal((await fetch(service.url, { headers: { ...headers, 'mcp-session-id': 'bad' } })).status, 400);
    assert.equal((await fetch(service.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 400);
    const a = await connect();
    const b = await connect();
    assert.notEqual(a.transport.sessionId, b.transport.sessionId);
    const initial = await read(a.client);
    const created = await a.client.request({ method: 'native-ui/action', params: {
      uri: 'pinote://ui', revision: initial.revision, action: 'add', value: 'Shared HTTP task', _meta: meta('a'),
    } }, z.object({ view: z.object({ state: z.record(z.unknown()), revision: z.string() }).passthrough() }));
    const state = created.view.state;
    const current = await a.client.callTool({ name: 'get_current', arguments: {}, _meta: meta('a', state) });
    const task = content(current);
    assert.equal(task.text, 'Shared HTTP task');
    assert.equal(content(await b.client.callTool({ name: 'get_current', arguments: {}, _meta: meta('b') })), null);
    assert.equal((await read(b.client)).state.selectedId, null);
    const update = await a.client.callTool({ name: 'update_current', arguments: { expected_updated_at: task.updated_at, set: { Next: 'Shared handoff' } }, _meta: meta('a', state) });
    assert.ok(!update.isError);
    const shared = content(await b.client.callTool({ name: 'get_task', arguments: { task_id: task.id }, _meta: meta('b') }));
    assert.equal(shared.agent_notes.Next, 'Shared handoff');
    const stale = await a.client.callTool({ name: 'update_current', arguments: { expected_updated_at: task.updated_at, set: { Next: 'Must not overwrite' } }, _meta: meta('a', state) });
    assert.equal(stale.isError, true);
    await assert.rejects(a.client.request({ method: 'native-ui/action', params: {
      uri: 'pinote://ui', revision: created.view.revision, action: 'done', _meta: meta('a', state),
    } }, z.object({})), /changed/);
    const oldId = a.transport.sessionId!;
    await a.transport.terminateSession();
    await a.client.close();
    assert.equal((await fetch(service.url, { headers: { ...headers, 'mcp-session-id': oldId, Accept: 'text/event-stream' } })).status, 404);
    const reconnected = await connect();
    assert.notEqual(reconnected.transport.sessionId, oldId);
    assert.equal(content(await reconnected.client.callTool({ name: 'get_current', arguments: {}, _meta: meta('a') })), null);
    const restored = content(await reconnected.client.callTool({ name: 'get_current', arguments: {}, _meta: meta('a', state) }));
    assert.equal(restored.id, task.id);
    assert.equal(restored.agent_notes.Next, 'Shared handoff');
    assert.equal(content(await b.client.callTool({ name: 'search', arguments: { query: '' }, _meta: meta('b') })).total, 1);
    assert.ok(!(await readFile(join(dir, 'app.log'), 'utf8')).includes(token));
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await service.close();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(dir, { recursive: true, force: true });
  }
});
