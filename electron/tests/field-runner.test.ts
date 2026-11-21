import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildFieldRuntime } from '../src/build-field-runtime.ts';
import { FieldRunner, fieldDatabaseIdentity, fieldNoteCommand } from '../src/field-runner.ts';

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

test('field CLI refuses mismatched databases and cannot pin nonstandard layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'pinote-field-cli-'));
  try {
    const env = { HOME: root, XDG_DATA_HOME: join(root, 'data') };
    assert.throws(() => fieldDatabaseIdentity(join(root, 'other/notes.db'), env), /different database/);
    mkdirSync(join(root, 'data/pinote'), { recursive: true });
    symlinkSync(join(root, 'custom.db'), join(root, 'data/pinote/notes.db'));
    assert.throws(() => fieldDatabaseIdentity(join(root, 'custom.db'), env), /cannot pin this database layout/);
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
      PATH: `${bin}:/usr/bin:/bin`, PINOTE_NOTE_COMMAND: join(bin, 'note') };
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
    assert.throws(() => fieldDatabaseIdentity(database, { ...env, PINOTE_ELECTRON_BACKEND: '/wrapper' }), /bundled desktop bridge/);
    const profile = fieldDatabaseIdentity(database, { ...env, PINOTE_TASK_RESPONSE: '1' });
    const bundled = await fieldNoteCommand(bundles, profile, command);
    const launcher = join(bin, 'note');
    const unexpected = join(root, 'unrelated-note-ran');
    writeFileSync(launcher, `#!/bin/sh\ntouch '${unexpected}'\nexit 1\n`, { mode: 0o700 });
    await assert.rejects(fieldNoteCommand(bundles, profile, { executable: '/legacy', args: [] }), /bundled desktop bridge/);
    assert.equal(bundled.noteEnv.PINOTE_NOTE_COMMAND, undefined);
    assert.equal(bundled.noteEnv.PINOTE_TASK_RESPONSE, undefined);
    const retarget = (target: string) => { unlinkSync(env.XDG_DATA_HOME); symlinkSync(target, env.XDG_DATA_HOME); };
    const otherData = join(root, 'other-data');
    mkdirSync(otherData);
    retarget(otherData);
    assert.equal(profile.matches(), false, 'Desktop bridge now selects a different database');
    assert.equal(cli('agent', 'add', '--text', 'Other profile').id, task.id);
    assert.notEqual(cli('agent', 'get', String(task.id)).agent_notes.Next, 'review');
    {
      const { noteCommand, noteArgs, noteEnv } = bundled;
      const result = spawnSync(noteCommand, [...(noteArgs ?? []), '--no-notify', 'agent', 'get', String(task.id)],
        { cwd: root, env: noteEnv, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).agent_notes.Next, 'review');
    }
    assert.throws(() => readFileSync(unexpected), { code: 'ENOENT' });
    retarget(data);
    assert.equal(profile.matches(), false, 'Retargeting back cannot rearm this session');

    run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      import { FieldAutomation } from ${JSON.stringify(new URL('../../pi/mcp/field-events.ts', import.meta.url).href)};
      import { desktopFieldRunner, fieldDatabaseIdentity } from ${JSON.stringify(new URL('../src/field-runner.ts', import.meta.url).href)};
      const [bundles, database, bridge, marker, task] = process.argv.slice(1);
      const observer = await FieldAutomation.observe({ database });
      const logs = [];
      const runner = desktopFieldRunner(bundles, fieldDatabaseIdentity(database, process.env), { executable: process.execPath, args: [bridge] },
        message => logs.push(message));
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
        import { desktopFieldRunner, fieldDatabaseIdentity } from ${JSON.stringify(new URL('../src/field-runner.ts', import.meta.url).href)};
        const [bundles, database, bridge] = process.argv.slice(1);
        const runner = desktopFieldRunner(bundles, fieldDatabaseIdentity(database, process.env), { executable: process.execPath, args: [bridge] },
          console.error);
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

test('desktop stops on notes database replacement without running or publishing B’s work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pinote-field-replacement-'));
  try {
    const bundles = join(root, 'bundles');
    cpSync(resolve('../backend/dist'), bundles, { recursive: true });
    await buildFieldRuntime(bundles);
    const cli = join(bundles, 'cli.mjs');
    renameSync(cli, join(bundles, 'actual-cli.mjs'));
    // Gate a read after the runner's pre-check. It deliberately returns B's
    // real CLI output if the parent is switched while the read is blocked.
    writeFileSync(cli, `
      import { appendFileSync, existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      appendFileSync(process.env.HOME + '/reads', JSON.stringify(process.argv.slice(2)) + '\\n');
      if (process.env.FIXTURE_STAGE === 'read') {
        while (!existsSync(process.env.HOME + '/release')) await setTimeout(10);
      }
      await import('./actual-cli.mjs');
    `);
    for (const stage of ['idle', 'read', 'watcher', 'missing'] as const) {
      const home = join(root, stage);
      const a = join(home, 'A'), b = join(home, 'B');
      const agent = join(home, 'agent'), watcher = join(home, 'watcher');
      const env = { HOME: home, XDG_DATA_HOME: a, XDG_STATE_HOME: join(home, 'state'), PI_CODING_AGENT_DIR: agent,
        PATH: '/usr/bin:/bin', FIXTURE_STAGE: stage };
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, 'pi-note.json'), JSON.stringify({ fieldWatchers: [{ path: watcher, enabled: true }] }));
      writeFileSync(watcher, `#!${process.execPath}
        const fs = require('node:fs');
        const input = JSON.parse(fs.readFileSync(0, 'utf8'));
        fs.appendFileSync(${JSON.stringify(join(home, 'calls'))}, input.value + '\\n');
        fs.writeFileSync(${JSON.stringify(join(home, 'pid'))}, String(process.pid));
        if (${JSON.stringify(stage)} === 'watcher') setInterval(() => {}, 1000);
        else console.log(JSON.stringify({ state: 'checked', notification: { key: input.value, message: input.value } }));
      `, { mode: 0o700 });
      const run = (args: string[], overrides = env) => {
        const result = spawnSync(process.execPath, args, { cwd: home, env: overrides, encoding: 'utf8', timeout: 12_000 });
        assert.equal(result.status, 0, `${stage}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
        return result.stdout;
      };
      const seed = (data: string, value: string) => {
        const task = (...args: string[]) => JSON.parse(run([join(bundles, 'actual-cli.mjs'), '--no-notify', 'agent', ...args], { ...env, XDG_DATA_HOME: data }));
        const added = task('add', '--text', 'Replacement profile fixture');
        const started = task('start', String(added.id), '--expected-updated-at', added.updated_at, '--pi-session-id', 'fixture');
        task('update', String(added.id), '--expected-updated-at', started.updated_at, '--set-json', JSON.stringify({ Next: value }));
      };
      if (stage !== 'missing') seed(a, 'original');
      seed(b, 'replacement');
      run(['--experimental-strip-types', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { existsSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
        import { dirname, join } from 'node:path';
        import { DatabaseSync } from 'node:sqlite';
        import { setTimeout } from 'node:timers/promises';
        import { desktopFieldRunner, fieldDatabaseIdentity } from ${JSON.stringify(new URL('../src/field-runner.ts', import.meta.url).href)};
        import { fieldAutomationPath } from ${JSON.stringify(new URL('../../pi/mcp/field-events.ts', import.meta.url).href)};
        const [bundles, a, b] = process.argv.slice(1);
        const stage = process.env.FIXTURE_STAGE;
        const database = join(a, 'pinote/notes.db'), other = join(b, 'pinote/notes.db');
        const statePath = fieldAutomationPath({ database }), otherState = fieldAutomationPath({ database: other });
        const file = name => join(process.env.HOME, name);
        const read = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
        const wait = async (condition, reason) => {
          const deadline = Date.now() + 6000;
          while (!condition()) { assert.ok(Date.now() < deadline, reason); await setTimeout(25); }
        };
        const profile = fieldDatabaseIdentity(database, process.env);
        const logs = [];
        const runner = desktopFieldRunner(bundles, profile, { executable: process.execPath, args: ['bundled'] },
          message => logs.push(message));
        let state;
        const query = sql => state.prepare(sql).get();
        try {
          if (stage === 'missing') {
            const reserved = statSync(database, { bigint: true });
            assert.equal(reserved.size, 0n);
            // The initial schema creation must preserve the reserved inode.
            const { execFileSync } = await import('node:child_process');
            execFileSync(process.execPath, [join(bundles, 'actual-cli.mjs'), '--no-notify', 'field-events']);
            assert.equal(statSync(database, { bigint: true }).ino, reserved.ino);
            assert.ok(profile.matches());
            renameSync(database, database + '.saved');
            renameSync(other, database);
            runner.start();
            await wait(() => logs.some(log => log.includes('Cannot start')), 'replacement was not rejected at startup');
            assert.ok(!existsSync(statePath));
            assert.equal(read('reads'), '');
          } else {
            runner.start();
            await wait(() => read('reads'), 'runner did not reach intake');
            state = new DatabaseSync(statePath, { readOnly: true });
            state.exec('PRAGMA busy_timeout=1000');
            if (stage === 'idle') {
              await wait(() => query('SELECT count(*) AS n FROM fw_notices').n === 1, 'original notice was not published');
              assert.ok(query('SELECT active_until FROM fw_publication').active_until > Date.now());
            }
            if (stage === 'watcher') await wait(() => read('pid'), 'original watcher did not start');
            assert.deepEqual(logs, []);
            const reads = read('reads');
            const cursor = query('SELECT cursor FROM fw_watchers').cursor;
            if (stage === 'watcher') {
              // Same canonical path and parent, but a different file inode.
              renameSync(database, database + '.saved');
              renameSync(other, database);
            } else {
              renameSync(dirname(database), join(a, 'original'));
              symlinkSync(dirname(other), dirname(database));
              if (stage === 'read') writeFileSync(file('release'), '');
            }
            await wait(() => logs.some(log => log.includes('identity changed')) &&
              query('SELECT active_until FROM fw_publication').active_until === 0 &&
              query('SELECT lease_until FROM fw_scheduler').lease_until === 0, 'runner did not stop and withdraw its publication');
            assert.equal(read('reads'), reads, 'runner started a new CLI read after replacement');
            assert.equal(query('SELECT cursor FROM fw_watchers').cursor, cursor, 'runner consumed replacement rows');
            assert.equal(query('SELECT count(*) AS n FROM fw_notices').n, stage === 'idle' ? 1 : 0);
            assert.equal(read('calls'), stage === 'read' ? '' : 'original\\n');
            if (stage === 'watcher') await wait(() => {
              try { return /^[ZX]/.test(readFileSync('/proc/' + read('pid') + '/stat', 'utf8').split(') ').at(-1)); }
              catch (error) { if (error.code === 'ENOENT') return true; throw error; }
            }, 'in-flight watcher survived replacement');
          }
          assert.ok(!existsSync(otherState), 'runner opened the replacement state namespace');
          assert.ok(!profile.matches(), 'replacement was considered valid');
        } finally { await runner.stop(); state?.close(); }
      `, bundles, a, b]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
