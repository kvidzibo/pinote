import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { switchToNode, recoverBackendSwitch, preferredBackendEnvironment, runCommand } from '../src/backend-switch.ts';

test('confirmed backend switching preserves data, rolls back failure and recovers an interrupted rollback', async () => {
  for (const mode of ['success', 'rollback', 'interrupted'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'pinote-switch-'));
    try {
      const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), PATH: `${root}/bin:/usr/bin:/bin`, PINOTE_ELECTRON_BACKEND: join(root, 'python-backend') };
      await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin/systemctl'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
      await mkdir(join(root, '.local/bin'), { recursive: true });
      const old = join(root, 'old-note'); await writeFile(old, '#!/bin/sh\nprintf old\\n\n', { mode: 0o700 });
      const cli = join(root, '.local/bin/note'); await symlink(old, cli);
      const bundles = resolve('../backend/dist'), database = join(root, 'data/pinote/notes.db');
      await runCommand(process.execPath, [join(bundles, 'cli.mjs'), '--no-notify', 'Keep all history and IDs'], env);
      const source = await readFile(database);
      await mkdir(join(dirname(database), 'electron'));
      await writeFile(join(dirname(database), 'electron/state.json'), '{"draft":"private draft"}', { mode: 0o600 });
      const dropin = join(root, 'config/systemd/user/pinote.service.d/90-node-backend.conf');
      let active = true, starts = 0, fail = mode !== 'success';
      const commands: string[] = [];
      const dependencies = {
        run: async (executable: string, args: string[], childEnv: NodeJS.ProcessEnv, input?: string) => {
          if (!executable.endsWith('/systemctl')) return runCommand(executable, args, childEnv, input);
          const action = args[1]; commands.push(action);
          if (action === 'show') return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? 123 : 0}\n`;
          if (action === 'stop') active = false;
          if (action === 'start') {
            starts++;
            if (fail && (mode === 'interrupted' || starts === 1)) throw new Error('Injected restart failure');
            active = true;
          }
          return '';
        },
        processEnvironment: async () => ({ ...env, PINOTE_NOTE_COMMAND: active && starts > 0 ? cli : old }),
        listening: async () => {}, wait: async () => {},
      };
      const phases: string[] = [];
      const operation = switchToNode({ env, node: process.execPath, bundles, database }, text => phases.push(text), dependencies);
      if (mode === 'success') {
        await operation;
        assert.match(await runCommand(cli, ['--version'], env), /^pinote 0\.26\.0/);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, undefined);
        assert.match(await readFile(dropin, 'utf8'), /PINOTE_NOTE_COMMAND=/);
        const different = { ...env, PINOTE_ELECTRON_BACKEND: '/another/explicit/backend' };
        assert.equal((await preferredBackendEnvironment(different)).PINOTE_ELECTRON_BACKEND, different.PINOTE_ELECTRON_BACKEND);
      } else {
        await assert.rejects(operation, mode === 'interrupted' ? /rollback could not finish/ : /Injected restart failure/);
        if (mode === 'interrupted') {
          assert.equal(active, false); fail = false;
          await recoverBackendSwitch(env, dependencies);
        }
        assert.equal(await readlink(cli), old);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, env.PINOTE_ELECTRON_BACKEND);
        await assert.rejects(lstat(dropin), { code: 'ENOENT' });
      }
      assert.equal(active, true, 'Previously running service resumes on success or completed rollback');
      assert.deepEqual(await readFile(database), source, 'Switching and rollback never mutate or restore task data');
      await assert.rejects(lstat(join(root, 'state/pinote/backend-switch/pending.json')), { code: 'ENOENT' });
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
