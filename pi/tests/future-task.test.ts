import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectEngine } from './host.ts';

test('a future task is previewed and added without starting it or replacing the selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-future-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env, PINOTE_NOTE_COMMAND: join(root, '../backend/bin/note'), PI_CODING_AGENT_DIR: pathToFileURL(dir).href, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir };
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(env.PINOTE_NOTE_COMMAND, ['--no-notify', ...args], { env })).stdout);
  Object.assign(process.env, env);
  const client = connectEngine();
  let state: Record<string, unknown> = {};
  const meta = () => ({ 'native-ui/context': { conversationId: 'future-task', state }, 'native-ui/features': { actionRevisions: true, footerNativeActions: true, footerStyles: true, footerDoubleActions: true, footerSecondaryActions: true } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args, _meta: meta() });
    if (result.state) state = result.state;
    return result;
  };
  const read = async () => JSON.parse(await client.readView(meta()));
  const act = async (view: any, action: string, value?: unknown) => {
    const result = await client.act({ revision: view.controls.find((control: any) => control.id === action)?.revision ?? view.revision, action, value, _meta: meta() });
    state = result.view.state;
    return result;
  };
  try {
    let view = (await act(await read(), 'add', 'Current work')).view;
    const selectedId = view.state.selectedId;
    const before = await cli('list', '--all', '--json');
    assert.equal((await call('suggest_later', { title: 'x'.repeat(61) })).isError, true);
    assert.equal((await call('suggest_later', { task_id: selectedId })).isError, true, 'Only new tasks can be suggested for later');
    assert.equal((await call('suggest_later', { title: 'Old idea' })).isError, undefined);
    const replaced = await read();
    assert.equal((await call('suggest_later', { title: 'Retry flaky e2e', description: '- Wait for the ready event', tag: 'ci' })).isError, undefined);
    view = await read();
    assert.equal(view.state.selectedId, selectedId, 'Selection is unchanged');
    assert.deepEqual(await cli('list', '--all', '--json'), before, 'Suggesting creates nothing');
    assert.deepEqual(view.footer.at(-1), { text: '✚ [ci] Retry flaky e2e', action: 'later:preview', doubleAction: 'later:accept', secondaryAction: 'later:dismiss', style: { italic: true, color: 'accent' }, width: 60 });
    assert.equal(view.footer[1].action, 'preview', 'The selected task stays first');
    assert.match(await client.readContext(meta()), /Pending future-task suggestion[^\n]*\n\{"text":"Retry flaky e2e\\n\\n- Wait for the ready event","tag":"ci"\}$/);
    await assert.rejects(act(replaced, 'later:accept'), /changed/, 'A replaced suggestion cannot be accepted');
    assert.equal((await act(view, 'later:preview')).preview, 'Retry flaky e2e\n\n- Wait for the ready event');
    assert.match(view.controls.find((control: any) => control.id === 'later:accept').confirm, /not started or selected\.\nTag: ci\n\nRetry flaky e2e/);
    const pending = structuredClone(state);
    const added = await act(await read(), 'later:accept');
    assert.match(added.notice, /^Added #\d+ for later: Retry flaky e2e\./);
    assert.equal(added.view.state.later, null);
    assert.equal(added.view.state.selectedId, selectedId);
    const tasks = await cli('list', '--all', '--json');
    assert.equal(tasks.length, before.length + 1);
    const created = tasks.find((task: any) => task.text.startsWith('Retry flaky e2e'));
    assert.deepEqual([created.text, created.tag, created.state], ['Retry flaky e2e\n\n- Wait for the ready event', 'ci', 'active']);
    state = pending;
    assert.equal((await read()).state.later, null, 'Accepted consent cannot be replayed from old state');
    await call('suggest_later', { title: 'Dismiss me' });
    view = await read();
    const dismissed = await act(view, view.footer.at(-1).secondaryAction);
    assert.equal(dismissed.view.state.later, null);
    assert.ok(dismissed.view.footer.every((item: any) => !item.action?.startsWith('later:')));
    assert.equal((await cli('list', '--all', '--json')).length, tasks.length, 'Dismissal creates nothing');
    // Also offered when nothing is selected, alongside a regular suggestion.
    await act(await read(), 'clear');
    await call('propose', { title: 'Start now' });
    await call('suggest_later', { title: 'Do later' });
    view = await read();
    assert.deepEqual(view.footer.filter((item: any) => item.action).map((item: any) => item.action), ['proposal:preview', 'later:preview']);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
