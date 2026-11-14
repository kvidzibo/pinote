import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { switchToNode, recoverBackendSwitch, preferredBackendEnvironment, runCommand } from '../src/backend-switch.ts';

test('confirmed backend switching preserves data, rolls back failure and recovers an interrupted rollback', async () => {
  for (const mode of ['success', 'rollback', 'interrupted', 'wrapper', 'conflict', 'absent-variable', 'deletion', 'deletion-new', 'service-wrapper', 'service-script'] as const) {
    const root = await mkdtemp(join(tmpdir(), "pinote switch-'"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), PATH: `${root}/bin:/usr/bin:/bin`, PINOTE_ELECTRON_BACKEND: join(root, 'python-backend') };
      await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin/systemctl'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
      await mkdir(join(root, '.local/bin'), { recursive: true });
      const old = join(root, 'old-note'); await writeFile(old, '#!/bin/sh\nprintf old\\n\n', { mode: 0o700 });
      if (mode === 'absent-variable') {
        env.PINOTE_NOTE_COMMAND = resolve('../backend/bin/note'); // Desktop-only override must NOT leak.
        await writeFile(join(root, 'bin/note'), '#!/bin/sh\nexport XDG_DATA_HOME=/another/database\nexec note "$@"\n', { mode: 0o700 });
      }
      const cli = join(root, '.local/bin/note'); await symlink(old, cli);
      const bundles = resolve('../backend/dist'), database = join(root, 'data/pinote/notes.db');
      await runCommand(process.execPath, [join(bundles, 'cli.mjs'), '--no-notify', 'Keep all history and IDs'], env);
      const source = await readFile(database);
      await mkdir(join(dirname(database), 'electron'));
      await writeFile(join(dirname(database), 'electron/state.json'), '{"draft":"private draft"}', { mode: 0o600 });
      const script = mode === 'service-script' ? join(root, 'foreign/dist-mcp/mcp/http.js') : resolve('../pi/dist-mcp/mcp/http.js');
      if (mode === 'service-script') { await mkdir(dirname(script), { recursive: true }); await writeFile(script, '// custom service\n'); }
      const dropin = join(root, 'config/systemd/user/pinote.service.d/90-node-backend.conf');
      let active = true, starts = 0, fail = mode === 'rollback' || mode === 'interrupted' || mode === 'deletion' || mode === 'deletion-new';
      const existingCLI = mode === 'wrapper' ? old : mode === 'success' ? resolve('../.venv/bin/note') : resolve('../backend/bin/note');
      const commands: string[] = [];
      const dependencies = {
        updateLock: join(root, 'update-lock/update.lock'),
        processArguments: async () => [process.execPath, script],
        processExecutable: async () => mode === 'service-wrapper' ? '/bin/sh' : process.execPath,
        processDirectory: async () => resolve('..'),
        run: async (executable: string, args: string[], childEnv: NodeJS.ProcessEnv, input?: string) => {
          if (!executable.endsWith('/systemctl')) return runCommand(executable, args, childEnv, input);
          const action = args[1]; commands.push(action);
          if (action === 'show') return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? 123 : 0}\n`;
          if (action === 'stop') active = false;
          if (action === 'start') {
            starts++;
            if (mode === 'deletion' && starts === 1) rmSync(cli);
            if (mode === 'deletion-new' && starts === 1) rmSync(dropin); // Owner deletion after publication must survive rollback.
            if (fail && (mode === 'interrupted' || starts === 1)) throw new Error('Injected restart failure');
            active = true;
          }
          return '';
        },
        processEnvironment: async () => {
          const override = await readFile(dropin, 'utf8').catch(() => '');
          // Model EnvironmentFile keeping its OLD value unless ExecStart's env
          // command explicitly overrides it in the launched server process.
          const captured: NodeJS.ProcessEnv = { ...env, PINOTE_NOTE_COMMAND: active && starts > 0 && override.includes('ExecStart=:/usr/bin/env ') ? cli : existingCLI };
          if (mode === 'absent-variable') delete captured.PINOTE_NOTE_COMMAND;
          return captured;
        },
        listening: async () => {}, wait: async () => {},
      };
      const phases: string[] = [];
      const operation = switchToNode({ env, node: process.execPath, bundles, database }, text => {
        phases.push(text);
        if (mode === 'conflict' && text.startsWith('Installing')) { rmSync(cli); writeFileSync(cli, 'owner changed configuration', { mode: 0o700 }); }
      }, dependencies);
      if (['wrapper', 'absent-variable', 'service-wrapper', 'service-script'].includes(mode)) {
        await assert.rejects(operation, mode.startsWith('service-') ? /documented direct Node HTTP/ : /custom CLI wrapper/);
        assert.equal(active, true); assert.ok(!commands.includes('stop'));
        assert.deepEqual(await readFile(database), source); continue;
      }
      if (mode === 'success') {
        await operation;
        assert.match(await runCommand(cli, ['--version'], env), /^pinote 0\.26\.0/);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, undefined);
        assert.match(await readFile(dropin, 'utf8'), /ExecStart=:\/usr\/bin\/env /);
        const different = { ...env, PINOTE_ELECTRON_BACKEND: '/another/explicit/backend' };
        assert.equal((await preferredBackendEnvironment(different)).PINOTE_ELECTRON_BACKEND, different.PINOTE_ELECTRON_BACKEND);
      } else {
        await assert.rejects(operation, mode === 'interrupted' || mode === 'conflict' || mode === 'deletion' ? /rollback could not finish/ : /Injected restart failure/);
        if (mode === 'interrupted') {
          assert.equal(active, false); fail = false;
          await recoverBackendSwitch(env, dependencies);
        }
        if (mode === 'conflict') assert.equal(await readFile(cli, 'utf8'), 'owner changed configuration');
        else if (mode === 'deletion') await assert.rejects(lstat(cli), { code: 'ENOENT' });
        else assert.equal(await readlink(cli), old);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, env.PINOTE_ELECTRON_BACKEND);
        await assert.rejects(lstat(dropin), { code: 'ENOENT' });
      }
      assert.equal(active, true, 'Previously running service resumes on success or completed rollback');
      assert.deepEqual(await readFile(database), source, 'Switching and rollback never mutate or restore task data');
      if (mode === 'conflict' || mode === 'deletion') assert.ok((await lstat(join(root, 'state/pinote/backend-switch/pending.json'))).isFile());
      else await assert.rejects(lstat(join(root, 'state/pinote/backend-switch/pending.json')), { code: 'ENOENT' });
      const backupRoot = join(root, 'state/pinote/backend-switch/backups');
      const backup = join(backupRoot, (await readdir(backupRoot))[0]);
      assert.equal((await lstat(join(backup, 'notes.db'))).mode & 0o777, 0o600);
      const db = new DatabaseSync(join(backup, 'notes.db'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT text FROM notes').get()!.text, 'Keep all history and IDs'); } finally { db.close(); }
      assert.equal(await readFile(join(backup, 'state.json'), 'utf8'), '{"draft":"private draft"}');
      assert.ok(commands.includes('daemon-reload')); assert.ok(phases.some(text => text.includes('Backing up')));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
