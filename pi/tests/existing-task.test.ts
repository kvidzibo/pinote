import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

test('find, read, suggest, and accept an existing task without duplication or automatic selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-existing-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env, PINOTE_NOTE_COMMAND: join(root, '../.venv/bin/note'), PI_CODING_AGENT_DIR: pathToFileURL(dir).href, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir };
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(env.PINOTE_NOTE_COMMAND, ['--no-notify', ...args], { env })).stdout);
  const connect = async () => {
    const client = new Client({ name: 'existing-task-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist-mcp/mcp/server.js')], env, stderr: 'pipe' }));
    return client;
  };
  let client = await connect();
  let state: Record<string, unknown> = {};
  const meta = () => ({ 'native-ui/context': { conversationId: 'existing-task', state }, 'native-ui/features': { actionRevisions: true, footerNativeActions: true, footerStyles: true } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args, _meta: meta() });
    if (result._meta?.['native-ui/state']) state = result._meta['native-ui/state'] as Record<string, unknown>;
    return result;
  };
  const data = (result: any) => JSON.parse(result.content[0].text);
  const read = async () => {
    const result = await client.readResource({ uri: 'pinote://ui', _meta: meta() });
    assert.ok('text' in result.contents[0]);
    return JSON.parse(result.contents[0].text);
  };
  const act = async (view: any, action: string) => {
    const result = await client.request({ method: 'native-ui/action', params: { uri: 'pinote://ui', revision: view.controls.find((control: any) => control.id === action)?.revision ?? view.revision, action, _meta: meta() } }, z.object({ view: z.any() }));
    state = result.view.state;
    return result.view;
  };
  try {
    const task = await cli('agent', 'add', '--text', 'OME registrations\n\nInvestigate callbacks after registration.\n' + 'Details '.repeat(500), '--tag', 'job');
    const saved = await cli('agent', 'update', String(task.id), '--expected-updated-at', task.updated_at, '--set-json', JSON.stringify({ Worktree: '/tmp/ome-worktree · feat/registration', Next: 'Trace callback handling' }));
    await cli('agent', 'add', '--text', 'OME unrelated');
    const completed = await cli('agent', 'add', '--text', 'OME registrations already fixed');
    await cli('agent', 'done', String(completed.id), '--expected-updated-at', completed.updated_at);
    const initial = await cli('list', '--all', '--json');
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((tool) => tool.name === 'search')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'get_task')?.annotations?.readOnlyHint, true);
    const found = data(await call('search', { query: 'CALLBACKS JOB ome' }));
    assert.deepEqual(found, { tasks: [{ id: task.id, title: 'OME registrations', state: 'active', tag: 'job' }], total: 1, next_offset: null });
    const first = data(await call('search', { query: 'ome', limit: 1 }));
    assert.equal(first.total, 2);
    assert.equal(first.next_offset, 1);
    const second = data(await call('search', { query: 'ome', limit: 1, offset: first.next_offset }));
    assert.notEqual(first.tasks[0].id, second.tasks[0].id);
    assert.equal(second.next_offset, null);
    assert.equal(data(await call('search', { query: '' })).total, 2);
    assert.deepEqual(data(await call('search', { query: 'missing' })).tasks, []);
    assert.deepEqual(data(await call('get_task', { task_id: task.id })), saved);
    assert.equal((await call('get_task', { task_id: 999999 })).isError, true);
    assert.equal(data(await call('get_current')), null);
    for (const args of [{}, { task_id: 0 }, { task_id: 999999 }, { task_id: completed.id }, { task_id: task.id, text: 'Duplicate' }, { task_id: task.id, tag: 'new' }]) {
      assert.equal((await call('propose', args)).isError, true);
    }
    assert.equal((await call('propose', { task_id: task.id })).isError, undefined);
    assert.equal(data(await call('get_current')), null, 'Suggestion never selects automatically');
    assert.deepEqual(await cli('list', '--all', '--json'), initial, 'Read and suggestion do not mutate tasks');
    const originalState = state;
    let view = await read();
    assert.match(view.footer[1].text, /\? \[job\] OME registrations/);
    assert.match(view.controls.find((control: any) => control.id === 'proposal:accept').description, /existing task/);
    assert.ok(JSON.stringify(state).length < 1024, 'Long task content is not copied into host state');
    await client.close(); client = await connect();
    assert.deepEqual((await read()).state, view.state, 'Pending existing-task suggestion survives reconnect');
    const changed = await cli('agent', 'update', String(task.id), '--expected-updated-at', saved.updated_at, '--set-json', JSON.stringify({ Next: 'Inspect the changed callback' }));
    await assert.rejects(act(view, 'proposal:accept'), /changed/, 'Changed target invalidates old consent');
    view = await read();
    await cli('agent', 'add', '--text', 'Unrelated task created elsewhere');
    view = await act(view, 'proposal:accept');
    assert.equal(view.state.selectedId, task.id, 'Acceptance selects the original ID');
    const current = data(await call('get_current'));
    assert.equal(current.state, 'in_progress');
    assert.equal(current.text, task.text);
    assert.equal(current.tag, task.tag);
    assert.deepEqual(current.agent_notes, changed.agent_notes);
    assert.equal((await cli('list', '--all', '--json')).filter((item: any) => item.text === task.text).length, 1);
    assert.equal((await call('propose', { task_id: task.id })).isError, true, 'Existing selection is never replaced');
    await assert.rejects(act(view, 'proposal:accept'), /changed/);
    await act(view, 'clear');
    state = originalState;
    assert.equal((await read()).state.proposal, null, 'Consumed acceptance cannot replay from old branch state');
    state = {};
    await call('propose', { task_id: task.id });
    const beforeDismiss = await cli('agent', 'get', String(task.id));
    view = await act(await read(), 'proposal:dismiss');
    assert.equal(view.state.selectedId, null);
    assert.deepEqual(await cli('agent', 'get', String(task.id)), beforeDismiss);
    await call('propose', { task_id: task.id });
    const pending = state;
    await call('propose', { text: 'Genuinely new work' });
    state = pending;
    assert.equal((await read()).state.proposal, null, 'Replacing an existing-task suggestion consumes its receipt');
    state = {};
    await call('propose', { task_id: task.id });
    view = await read();
    await cli('agent', 'done', String(task.id), '--expected-updated-at', beforeDismiss.updated_at);
    assert.equal((await read()).state.proposal, null, 'Completed target disappears from suggestions');
    await assert.rejects(act(view, 'proposal:accept'), /changed/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
