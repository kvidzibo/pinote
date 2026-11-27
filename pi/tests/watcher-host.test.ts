import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectPeer } from '../extension/client.ts';
import { FieldAutomation } from '../field-events.ts';

test('a Pi session reads results and alerts saved by a scheduler in another process', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-watcher-host-'));
  const names = ['PINOTE_NOTE_COMMAND', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR'];
  const previous = names.map((name) => process.env[name]);
  Object.assign(process.env, { PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../backend/bin/note', import.meta.url)),
    XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: dir });
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args])).stdout);
  const watcher = join(dir, 'watcher.mjs');
  await writeFile(watcher, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ state: 'failed', notification: { key: 'build', message: 'Build failed' } }));\n`, { mode: 0o700 });
  await writeFile(join(dir, 'pi-note.json'), JSON.stringify({ fieldWatchers: [{ path: watcher, enabled: true }] }));
  // The desktop's role: the only process that runs watchers. Its scheduler timers do not keep a process alive.
  const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `const { startFieldWatchers } = await import(${JSON.stringify(new URL('../watcher-host.ts', import.meta.url).href)}); const host = await startFieldWatchers(); setInterval(() => {}, 1000); process.on('SIGTERM', () => host.close().then(() => process.exit(0)));`],
    { env: process.env, stdio: 'ignore' });
  let changes = 0;
  const peer = await connectPeer(() => { changes++; });
  try {
    const task = await cli('agent', 'add', '--text=Watched task');
    await cli('agent', 'update', String(task.id), '--expected-updated-at', task.updated_at, '--set-json', JSON.stringify({ Build: 'queued' }));
    const meta = { 'native-ui/context': { conversationId: 'reader', state: { selectedId: task.id } }, 'native-ui/features': { fieldEvents: true, fieldWatchers: true } };
    const signal = new AbortController().signal;
    let notices: { message: string }[] = [];
    for (const deadline = Date.now() + 30_000; !notices.length;) {
      assert.ok(Date.now() < deadline, 'The reader never saw the scheduler result');
      await new Promise((resolve) => setTimeout(resolve, 200));
      notices = (await peer.view(meta, signal) as { fieldNotifications?: { message: string }[] }).fieldNotifications ?? [];
    }
    assert.equal(notices[0].message, 'Build failed');
    assert.match((await peer.context(meta, signal)).text, /Build failed|"state":"failed"/);
    for (const deadline = Date.now() + 5000; !changes;) {
      assert.ok(Date.now() < deadline, 'Saved watcher results must refresh open sessions');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The idle scheduler keeps renewing its lease; that must not refresh sessions.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const settled = changes;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(changes, settled);
    // A reader configured without this watcher hides its results but never erases them.
    const other = await FieldAutomation.open({ watchers: () => [] });
    try { assert.deepEqual(other.failures(), []); assert.deepEqual(other.statuses({ ...task, agent_notes: { Build: 'queued' } }), []); } finally { await other.close(); }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await peer.view(meta, signal) as { fieldNotifications?: unknown[] }).fieldNotifications?.length, 1);
  } finally {
    await peer.close();
    if (host.exitCode === null && host.signalCode === null) { const stopped = new Promise((resolve) => host.once('close', resolve)); host.kill('SIGTERM'); await stopped; }
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});
