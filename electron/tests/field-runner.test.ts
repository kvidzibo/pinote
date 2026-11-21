import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildFieldRuntime } from '../src/build-field-runtime.ts';
import { FieldRunner, fieldNoteCommand } from '../src/field-runner.ts';

for (const stopWhileOpening of [false, true]) {
  test(`field runner closes exactly once (${stopWhileOpening ? 'during open' : 'after start'})`, async () => {
    const calls: string[] = [];
    type Scheduler = { start(): void; close(): Promise<void> };
    let opened!: (scheduler: Scheduler) => void;
    const pending = new Promise<Scheduler>(resolve => { opened = resolve; });
    const runner = new FieldRunner(() => { calls.push('open'); return pending; }, message => assert.fail(message));
    runner.start();
    runner.start();
    const stopping = stopWhileOpening ? runner.stop() : undefined;
    opened({ start: () => { calls.push('start'); }, close: async () => { calls.push('close'); } });
    await pending;
    assert.equal(runner.stop(), stopping ?? runner.stop());
    await runner.stop();
    runner.start();
    assert.deepEqual(calls, stopWhileOpening ? ['open', 'close'] : ['open', 'start', 'close']);
  });
}

test('CLI selection refuses mismatched databases and unverified override launchers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinote-field-cli-'));
  try {
    const note = join(root, 'note');
    writeFileSync(note, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), PINOTE_NOTE_COMMAND: note, PATH: '/usr/bin:/bin' };
    const backend = { executable: process.execPath, args: [join(root, 'bridge.mjs')] };
    const runtime = () => ({ node: process.execPath, bundles: root });
    await assert.rejects(fieldNoteCommand(root, join(root, 'other/notes.db'), backend, env, runtime), /different database/);
    await assert.rejects(fieldNoteCommand(root, join(root, 'data/pinote/notes.db'), { executable: '/legacy', args: [] }, env, runtime), /custom CLI wrapper/);
    mkdirSync(join(root, 'data/pinote'), { recursive: true });
    symlinkSync(join(root, 'custom.db'), join(root, 'data/pinote/notes.db'));
    await assert.rejects(fieldNoteCommand(root, join(root, 'custom.db'), backend, env, runtime), /cannot pin this database layout/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('relocated field runtime pins the CLI and supervises enabled local watchers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinote-field-runtime-'));
  try {
    const bundles = join(root, 'resources', 'pinote-backend');
    const data = join(root, 'data');
    const config = join(root, 'agent');
    const marker = join(root, 'watched');
    const watcher = join(root, 'watcher');
    const bin = join(root, 'bin');
    cpSync(resolve('../backend/dist'), bundles, { recursive: true });
    await buildFieldRuntime(bundles);
    mkdirSync(data); mkdirSync(config); mkdirSync(bin);
    symlinkSync(data, join(root, 'data-alias'));
    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(watcher, `#!/bin/sh\n/bin/cat > '${marker}'\nprintf '{"state":"checked"}\\n'\n`, { mode: 0o700 });
    writeFileSync(join(config, 'pi-note.json'), JSON.stringify({ fieldWatchers: [{ path: watcher, enabled: true }] }));
    const env = { HOME: root, XDG_DATA_HOME: join(root, 'data-alias'), XDG_STATE_HOME: join(root, 'state'), PI_CODING_AGENT_DIR: config,
      PATH: `${bin}:/usr/bin:/bin`, PINOTE_NOTE_COMMAND: join(root, 'unused-note') };
    const run = (executable: string, args: string[], input?: string) => {
      const result = spawnSync(executable, args, { env, cwd: root, encoding: 'utf8', input, timeout: 10000 });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    for (const name of ['github-pr.mjs', 'forgejo-pr.mjs']) {
      const executable = join(bundles, 'watchers', name);
      assert.equal(JSON.parse(run(executable, [], 'invalid JSON')).state, 'error'); // Offline; also checks executable modes and bundled imports.
    }
    const cli = (...args: string[]) => JSON.parse(run(process.execPath, [join(bundles, 'cli.mjs'), '--no-notify', ...args]));
    const bridge = join(bundles, 'bridge.mjs');
    let task = cli('agent', 'add', '--text', 'Desktop watcher fixture');
    task = cli('agent', 'start', String(task.id), '--expected-updated-at', task.updated_at, '--pi-session-id', 'fixture');
    cli('agent', 'update', String(task.id), '--expected-updated-at', task.updated_at, '--set-json', '{"Next":"review"}');
    const handshake = JSON.parse(run(process.execPath, [bridge], JSON.stringify({ protocol: 1, operation: 'handshake', params: {} })));
    const database = join(data, 'pinote/notes.db');
    assert.equal(handshake.result.database, database);
    const command = { executable: process.execPath, args: [bridge] };
    const runtime = () => ({ bundles, node: process.execPath });
    const bundled = await fieldNoteCommand(bundles, database, command, env, runtime);
    const launcher = join(bin, 'note');
    writeFileSync(launcher, `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS NODE_V8_COVERAGE ELECTRON_RUN_AS_NODE\nexec '${process.execPath}' --disable-warning=ExperimentalWarning '${join(bundles, 'cli.mjs')}' "$@"\n`, { mode: 0o700 });
    const legacy = await fieldNoteCommand(bundles, database, { executable: '/legacy', args: [] }, { ...env, PINOTE_NOTE_COMMAND: launcher }, runtime);
    const retarget = (target: string) => { unlinkSync(env.XDG_DATA_HOME); symlinkSync(target, env.XDG_DATA_HOME); };
    const otherData = join(root, 'other-data');
    mkdirSync(otherData);
    retarget(otherData);
    assert.equal(cli('agent', 'add', '--text', 'Other profile').id, task.id);
    assert.notEqual(cli('agent', 'get', String(task.id)).agent_notes.Next, 'review');
    for (const { noteCommand, noteArgs, noteEnv } of [bundled, legacy]) {
      const result = spawnSync(noteCommand, [...(noteArgs ?? []), '--no-notify', 'agent', 'get', String(task.id)],
        { cwd: root, env: noteEnv, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).agent_notes.Next, 'review');
    }
    retarget(data);

    run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      import { FieldAutomation } from ${JSON.stringify(new URL('../../pi/mcp/field-events.ts', import.meta.url).href)};
      import { desktopFieldRunner } from ${JSON.stringify(new URL('../src/field-runner.ts', import.meta.url).href)};
      const [bundles, database, bridge, marker, task] = process.argv.slice(1);
      const observer = await FieldAutomation.observe({ database });
      const logs = [];
      const runner = desktopFieldRunner(bundles, database, { executable: process.execPath, args: [bridge] }, process.env,
        () => { throw new Error('The bundled CLI does not need an override probe'); }, message => logs.push(message));
      runner.start();
      try {
        const deadline = Date.now() + 5000;
        for (;;) {
          const input = await readFile(marker, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (input?.includes('review') && observer.statuses(JSON.parse(task)).some(status => status.result.state === 'checked' && !status.stale)) break;
          assert.ok(Date.now() < deadline && logs.length === 0, logs.join('\\n') || 'Watcher result was not committed');
          await setTimeout(25);
        }
      } finally { await runner.stop(); await observer.close(); }
      assert.deepEqual(logs, []);
    `, bundles, database, bridge, marker, JSON.stringify(cli('agent', 'get', String(task.id)))]);

    const waitFor = async (condition: () => boolean, reason: string) => {
      const deadline = Date.now() + 8_000;
      while (!condition()) {
        assert.ok(Date.now() < deadline, reason);
        await delay(25);
      }
    };
    const running = (pid: number) => {
      try { return !/^[ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    const pidsPath = join(root, 'watcher.pids');
    writeFileSync(watcher, `#!/usr/bin/env node
      const { spawn } = require('node:child_process');
      const { closeSync, renameSync, writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      closeSync(1); closeSync(2); // No output stream should be needed for crash detection.
      const path = ${JSON.stringify(pidsPath)};
      writeFileSync(path + '.tmp', JSON.stringify([process.ppid, process.pid, child.pid]));
      renameSync(path + '.tmp', path);
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });

    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        import { desktopFieldRunner } from ${JSON.stringify(new URL('../src/field-runner.ts', import.meta.url).href)};
        const [bundles, database, bridge] = process.argv.slice(1);
        const runner = desktopFieldRunner(bundles, database, { executable: process.execPath, args: [bridge] }, process.env,
          () => { throw new Error('Unexpected override probe'); }, console.error);
        process.once('SIGTERM', async () => { await runner.stop(); process.exit(0); });
        runner.start();
        setInterval(() => {}, 1000);
      `, bundles, database, bridge], { cwd: root, env: { ...env, XDG_STATE_HOME: join(root, signal) }, stdio: 'ignore' });
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      host.on('exit', (code, signalled) => { exit = { code, signal: signalled }; });
      let pids: number[] = [];
      try {
        await waitFor(() => {
          try { pids = JSON.parse(readFileSync(pidsPath, 'utf8')); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
        }, `${signal}: watcher did not start`);
        assert.equal(pids.length, 3);
        assert.ok(pids.every(pid => running(pid)), `${signal}: fixture was not running`);
        assert.ok(host.kill(signal));
        await waitFor(() => exit !== undefined, `${signal}: host did not exit`);
        assert.deepEqual(exit, signal === 'SIGTERM' ? { code: 0, signal: null } : { code: null, signal });
        await waitFor(() => pids.every(pid => !running(pid)), `${signal}: watcher group survived its host`);
      } finally {
        if (!exit) host.kill('SIGKILL');
        for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL');
        rmSync(pidsPath, { force: true });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
