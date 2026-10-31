import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
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
    } }, z.object({ view: z.object({ state: z.record(z.string(), z.unknown()), revision: z.string() }).passthrough() }));
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

test('completion SSE authenticates, checkpoints, resumes durable history and cleans up', { timeout: 30_000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'pinote-events-'));
  const names = ['PINOTE_NOTE_COMMAND', 'XDG_DATA_HOME', 'XDG_STATE_HOME'];
  const previous = names.map((name) => process.env[name]);
  Object.assign(process.env, {
    PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../.venv/bin/note', import.meta.url)),
    XDG_DATA_HOME: dir, XDG_STATE_HOME: dir,
  });
  const { startPinoteHttpServer } = await import('../mcp/http.ts');
  const token = 'events-test-secret-'.repeat(3);
  const service = await startPinoteHttpServer({ token, port: 0, logPath: join(dir, 'app.log') });
  const url = service.url.replace('/mcp', '/events');
  const headers = { Authorization: `Bearer ${token}` };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const note = async (...args: string[]) => (await exec(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args])).stdout;
  const open = async (cursor?: string) => {
    const response = await fetch(url, { headers: { ...headers, ...(cursor === undefined ? {} : { 'Last-Event-ID': cursor }) } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    readers.push(reader);
    let buffer = '';
    return async () => {
      const deadline = setTimeout(() => { void reader.cancel(); }, 8000);
      try {
        while (!buffer.includes('\n\n')) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, 'stream ended before event');
          buffer += new TextDecoder().decode(chunk.value);
        }
        const index = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        return frame;
      } finally { clearTimeout(deadline); }
    };
  };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal(await new Promise<number>((ok, fail) => {
      const req = request(url, { headers: { ...headers, Host: 'evil.invalid' } }, (res) => { res.resume(); ok(res.statusCode!); });
      req.on('error', fail); req.end();
    }), 403);
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
    for (const cursor of ['-1', 'bad', '1.5', '9007199254740992', '1']) {
      const response = await fetch(url, { headers: { ...headers, 'Last-Event-ID': cursor } });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /Last-Event-ID/);
    }
    const next = await open();
    assert.equal(await next(), 'id: 0\nevent: checkpoint\ndata: {}');
    await note('add', 'Live completion');
    await note('start', '1');
    let checkpoint = await next();
    if (checkpoint === 'id: 1\nevent: checkpoint\ndata: {}') checkpoint = await next();
    assert.equal(checkpoint, 'id: 2\nevent: checkpoint\ndata: {}');
    await note('done', '1');
    const frame = await next();
    assert.match(frame, /^id: 3\nevent: task.completed\ndata: /);
    const payload = JSON.parse(frame.split('data: ')[1]);
    assert.equal(payload.task_id, 1);
    assert.equal(typeof payload.timestamp, 'string');
    await readers[0].cancel();
    await note('done', '1'); // Re-marking does not append history.
    await note('add', 'Ignored removal');
    await note('rm', '2');
    const catchup = await open('2');
    assert.equal(await catchup(), 'id: 2\nevent: checkpoint\ndata: {}');
    assert.equal(await catchup(), frame);
    assert.equal(await catchup(), 'id: 5\nevent: checkpoint\ndata: {}');
    await readers[1].cancel();
    const fresh = await open();
    assert.equal(await fresh(), 'id: 5\nevent: checkpoint\ndata: {}');

    // A later subscriber must not be checked against an earlier in-flight tail read.
    const command = process.env.PINOTE_NOTE_COMMAND!;
    const gate = join(dir, 'tail-gate'), entered = join(dir, 'tail-entered');
    const delayed = join(dir, 'delayed-note.cjs');
    await writeFile(gate, '');
    await writeFile(delayed, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const output = require('node:child_process').execFileSync(${JSON.stringify(command)}, args);
(async () => {
  if (args.includes('events') && !args.includes('--after') && fs.existsSync(${JSON.stringify(gate)})) {
    fs.writeFileSync(${JSON.stringify(entered)}, '');
    while (fs.existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 10));
  }
  process.stdout.write(output);
})();\n`, { mode: 0o700 });
    process.env.PINOTE_NOTE_COMMAND = delayed;
    const earlier = fetch(url, { headers });
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await access(entered); break; } catch { /* Wait for the captured tail. */ }
      assert.ok(Date.now() < deadline, 'tail scan reached the gate');
      await new Promise(r => setTimeout(r, 10));
    }
    await note('add', 'Concurrent completion');
    await note('done', '3');
    const joined = new Promise<void>(resolve => service.listener.once('request', () => resolve()));
    const later = fetch(url, { headers: { ...headers, 'Last-Event-ID': '7' } });
    await joined;
    await rm(gate);
    const responses = await Promise.all([earlier, later]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    await Promise.all(responses.map(response => response.body!.cancel()));
    process.env.PINOTE_NOTE_COMMAND = command;
    await service.close();
    while (!(await readers[2].read()).done) { /* Drain in-flight events before EOF. */ }
  } finally {
    await Promise.allSettled(readers.map((reader) => reader.cancel()));
    await service.close();
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});
