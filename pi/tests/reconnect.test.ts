import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { connectPeer, type PeerFactory } from '../extension/client.ts';
import { PinoteSession } from '../extension/session.ts';

async function until(condition: () => boolean, message: string, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('two sessions automatically recover from an unavailable CLI without replaying writes', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-reconnect-'));
  const names = ['PINOTE_NOTE_COMMAND', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR'];
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, {
    PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../backend/bin/note', import.meta.url)),
    XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: pathToFileURL(dir).href,
  });
  const exec = promisify(execFile);
  const cli = async (...args: string[]) => JSON.parse((await exec(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args], { timeout: 5000 })).stdout);
  const sessions: PinoteSession[] = [];
  const calls: string[] = [];
  // Observe real peers without replacing engine behavior or driving recovery.
  const factory: PeerFactory = async (...args) => {
    const peer = await connectPeer(...args);
    return {
      ...peer,
      view: (...args) => { calls.push('view'); return peer.view(...args); },
      context: (...args) => { calls.push('context'); return peer.context(...args); },
      action: (...args) => { calls.push('action'); return peer.action(...args); },
      tool: (...args) => { calls.push('tool'); return peer.tool(...args); },
    };
  };
  try {
    const tasks = await Promise.all(['First isolated task', 'Second isolated task'].map(text => cli('agent', 'add', '--text', text)));
    const piIds = ['12345678-1234-4234-8234-123456789012', '12345678-1234-4234-8234-123456789013'];
    for (let i = 0; i < tasks.length; i++) {
      const session = new PinoteSession(() => {}, factory);
      sessions.push(session);
      await session.start([], `conversation-${i}`, undefined, piIds[i]);
      const view = session.view!;
      const select = view.controls.find(control => control.id === `select:${tasks[i].id}`);
      assert.ok(select);
      await session.action(view, select);
      assert.equal(session.view?.state.selectedId, tasks[i].id);
    }
    const saved = sessions.map(session => session.snapshot()!);
    assert.notEqual(saved[0].contextId, saved[1].contextId);
    const before = await Promise.all(tasks.map(task => cli('agent', 'get', String(task.id))));
    before.forEach((task, i) => {
      assert.equal(task.state, 'in_progress');
      assert.deepEqual(task['pi-sessions'], [piIds[i]]);
    });
    const listBefore = await cli('list', '--all', '--json');
    const command = process.env.PINOTE_NOTE_COMMAND!;
    process.env.PINOTE_NOTE_COMMAND = join(dir, 'missing-note');
    await Promise.all(sessions.map(session => assert.rejects(session.refresh())));
    assert.ok(sessions.every(session => session.view === undefined), 'Both sessions must become unavailable while the CLI is missing');
    sessions.forEach((session, i) => assert.deepEqual(session.snapshot(), saved[i]));
    const recoveryStart = calls.length;
    process.env.PINOTE_NOTE_COMMAND = command;
    // No refresh, context, tool, action or start calls may trigger these reads.
    await until(() => sessions.every(session => !!session.view), 'Both sessions must recover automatically');
    sessions.forEach((session, i) => {
      assert.equal(session.view?.state.selectedId, tasks[i].id);
      assert.equal(session.snapshot()?.contextId, saved[i].contextId);
    });
    const recoveredCalls = calls.slice(recoveryStart);
    assert.ok(recoveredCalls.length >= 2);
    assert.ok(recoveredCalls.every(call => call === 'view'), 'Recovery only reads the view; actions and tools must never replay');
    const after = await Promise.all(tasks.map(task => cli('agent', 'get', String(task.id))));
    assert.deepEqual(after.map(task => task.updated_at), before.map(task => task.updated_at), 'Recovery must not change task revisions');
    assert.deepEqual(after, before, 'Task contents and independent Pi session associations remain unchanged');
    assert.deepEqual(await cli('list', '--all', '--json'), listBefore, 'Recovery must not create or remove tasks');
  } finally {
    try { await Promise.allSettled(sessions.map(session => session.stop())); }
    finally {
      names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
      await rm(dir, { recursive: true, force: true });
    }
  }
});
