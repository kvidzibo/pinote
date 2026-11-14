import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { connectPeer, remoteConfig, type PeerFactory } from '../remote/client.ts';
import { RemoteSession } from '../remote/session.ts';

async function until(condition: () => boolean, message: string, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('two remote sessions automatically recover from a server restart without replaying writes', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-reconnect-'));
  const names = ['PINOTE_NOTE_COMMAND', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR'];
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, {
    PINOTE_NOTE_COMMAND: fileURLToPath(new URL('../../.venv/bin/note', import.meta.url)),
    XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: pathToFileURL(dir).href,
  });
  const exec = promisify(execFile);
  const cli = async (...args: string[]) => JSON.parse((await exec(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args], { timeout: 5000 })).stdout);
  const { startPinoteHttpServer } = await import('../mcp/http.ts');
  let service: Awaited<ReturnType<typeof startPinoteHttpServer>> | undefined;
  const sessions: RemoteSession[] = [];
  const calls: string[] = [];
  // Observe real peers without replacing transport behavior or driving recovery.
  const factory: PeerFactory = async (...args) => {
    const peer = await connectPeer(...args);
    return {
      ...peer,
      read: (...args) => { calls.push(`read:${args[0]}`); return peer.read(...args); },
      action: (...args) => { calls.push('action'); return peer.action(...args); },
      tool: (...args) => { calls.push('tool'); return peer.tool(...args); },
    };
  };
  try {
    const tasks = await Promise.all(['First isolated task', 'Second isolated task'].map(text => cli('agent', 'add', '--text', text)));
    const token = 'reconnect-integration-secret-'.repeat(3);
    const options = { token, host: '127.0.0.1', logPath: join(dir, 'app.log') };
    service = await startPinoteHttpServer({ ...options, port: 0 });
    const url = service.url;
    const config = remoteConfig({ PINOTE_URL: url, PINOTE_TOKEN: token });
    const piIds = ['12345678-1234-4234-8234-123456789012', '12345678-1234-4234-8234-123456789013'];
    for (let i = 0; i < tasks.length; i++) {
      const session = new RemoteSession(config, () => {}, factory);
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
    const recoveryStart = calls.length;
    await service.close();
    await until(() => sessions.every(session => session.view === undefined), 'Both idle sessions must become unavailable after shutdown', 5000);
    sessions.forEach((session, i) => assert.deepEqual(session.snapshot(), saved[i]));
    service = await startPinoteHttpServer({ ...options, port: Number(new URL(url).port) });
    assert.equal(service.url, url);
    // No refresh, context, tool, action or start calls may trigger these reads.
    await until(() => sessions.every(session => !!session.view), 'Both sessions must recover automatically on the same endpoint');
    sessions.forEach((session, i) => {
      assert.equal(session.view?.state.selectedId, tasks[i].id);
      assert.equal(session.snapshot()?.contextId, saved[i].contextId);
    });
    const recoveredCalls = calls.slice(recoveryStart);
    assert.ok(recoveredCalls.length >= 2);
    assert.ok(recoveredCalls.every(call => call === 'read:pinote://ui'), 'Recovery only reads the view; actions and tools must never replay');
    const after = await Promise.all(tasks.map(task => cli('agent', 'get', String(task.id))));
    assert.deepEqual(after.map(task => task.updated_at), before.map(task => task.updated_at), 'Recovery must not change task revisions');
    assert.deepEqual(after, before, 'Task contents and independent Pi session associations remain unchanged');
    assert.deepEqual(await cli('list', '--all', '--json'), listBefore, 'Recovery must not create or remove tasks');
  } finally {
    try {
      await Promise.allSettled(sessions.map(session => session.stop()));
      await service?.close();
    } finally {
      names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
      await rm(dir, { recursive: true, force: true });
    }
  }
});
