import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('relocated field runtime polls the desktop CLI and runs an enabled local watcher', async () => {
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
    writeFileSync(watcher, `#!/bin/sh\n/bin/cat > '${marker}'\nprintf '{}\\n'\n`, { mode: 0o700 });
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
    assert.equal(handshake.result.database, join(data, 'pinote/notes.db'));
    run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      import { desktopFieldRunner } from ${JSON.stringify(new URL('../src/field-runner.ts', import.meta.url).href)};
      const [bundles, database, bridge, marker] = process.argv.slice(1);
      const logs = [];
      const runner = desktopFieldRunner(bundles, database, { executable: process.execPath, args: [bridge] }, process.env,
        () => { throw new Error('The bundled CLI does not need an override probe'); }, message => logs.push(message));
      runner.start();
      try {
        const deadline = Date.now() + 5000;
        for (;;) {
          const input = await readFile(marker, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
          if (input?.includes('review')) break;
          assert.ok(Date.now() < deadline && logs.length === 0, logs.join('\\n') || 'Watcher was not invoked');
          await setTimeout(25);
        }
      } finally { await runner.stop(); }
      assert.deepEqual(logs, []);
    `, bundles, handshake.result.database, bridge, marker]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
