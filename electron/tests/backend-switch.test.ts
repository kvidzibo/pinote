import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { switchToNode, recoverBackendSwitch, preferredBackendEnvironment, runCommand } from '../src/backend-switch.ts';

let bundles: string;
before(async () => {
  bundles = await mkdtemp(join(tmpdir(), 'pinote-switch-bundles-'));
  for (const artifact of ['cli.mjs', 'bridge.mjs']) await symlink(resolve('../backend/dist', artifact), join(bundles, artifact));
});
after(async () => { if (bundles) await rm(bundles, { recursive: true, force: true }); });

test('startup never uses a sibling preference or journal through symlink/..', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinote-startup-'));
  try {
    await mkdir(join(root, 'physical/nested'), { recursive: true });
    await symlink('physical/nested', join(root, 'link'));
    const env = { HOME: root, XDG_CONFIG_HOME: `${root}/link/../config`, XDG_STATE_HOME: `${root}/link/../state` };
    await assert.rejects(preferredBackendEnvironment(env), /parent-directory/);
    await assert.rejects(recoverBackendSwitch(env), /parent-directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('confirmed backend switching preserves data, rolls back failure and recovers an interrupted rollback', async () => {
  for (const mode of ['python', 'node', 'rollback', 'interrupted', 'conflict', 'deletion', 'changed-after-install', 'loader', 'node-options', 'node-wrapper', 'relative-path', 'missing-flock', 'user-wrapper', 'lossy-launcher', 'relative-home', 'pip', 'pip-lazy', 'interpreter-shim'] as const) {
    const root = await mkdtemp(join(tmpdir(), mode === 'interpreter-shim' ? 'pinote-shim-' : "pinote switch-'"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), PATH: `${root}/bin:/usr/bin:/bin`, PINOTE_ELECTRON_BACKEND: join(root, 'python-backend') };
      // Drop node:test's NODE_TEST_CONTEXT and the test runner's runtime hooks.
      // The injection fixture is explicit below.
      for (const key of Object.keys(env)) if (/^(LD_|NODE_|ELECTRON_|PYTHON)/.test(key) || ['GCONV_PATH', 'GLIBC_TUNABLES'].includes(key)) delete env[key];
      await mkdir(join(root, 'bin'));
      if (mode === 'node-wrapper') await writeFile(join(root, 'bin/node'), '#!/bin/sh\nexport XDG_DATA_HOME=/different\nexit 1\n', { mode: 0o700 });
      else await symlink(process.execPath, join(root, 'bin/node'));
      await mkdir(join(root, '.local/bin'), { recursive: true });
      const custom = join(root, 'old-note'); await writeFile(custom, '#!/bin/sh\nprintf old\\n\n', { mode: 0o700 });
      const isPip = mode === 'pip' || mode === 'pip-lazy' || mode === 'interpreter-shim';
      const old = isPip ? join(root, 'pip-note') : mode === 'user-wrapper' ? custom : mode === 'node' || mode === 'node-wrapper' ? resolve('../backend/bin/note') : resolve('../.venv/bin/note');
      if (isPip) {
        const entry = mode === 'pip' ? "from pinote.cli import main\nif __name__ == '__main__':" : "if __name__ == '__main__':\n    from pinote.cli import main";
        const interpreter = mode === 'interpreter-shim' ? join(root, 'bin/python') : resolve('../.venv/bin/python');
        if (mode === 'interpreter-shim') await writeFile(interpreter, `#!/bin/sh\ntouch '${root}/shim-ran'\nexit 1\n`, { mode: 0o700 });
        await writeFile(old, `#!${interpreter}\n# -*- coding: utf-8 -*-\nimport re\nimport sys\n${entry}\n    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n    sys.exit(main())\n`, { mode: 0o700 });
      }
      const cli = join(root, '.local/bin/note');
      const invalid = Buffer.concat([Buffer.from(`${root}/note-`), Buffer.from([0xff])]);
      if (mode === 'lossy-launcher') {
        await writeFile(invalid, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        await symlink(old, join(root, 'note-�')); await symlink(invalid, cli);
      } else await symlink(old, cli);
      const database = join(root, 'data/pinote/notes.db');
      await runCommand(process.execPath, [join(bundles, 'cli.mjs'), '--no-notify', 'Keep all history and IDs'], env);
      const source = await readFile(database);
      await mkdir(join(dirname(database), 'electron'));
      await writeFile(join(dirname(database), 'electron/state.json'), '{"draft":"private draft"}', { mode: 0o600 });
      // Common desktop settings (a CUDA profile, a Node or Electron hint) must not block the switch.
      if (mode === 'python') Object.assign(env, { LD_LIBRARY_PATH: '/usr/local/cuda/lib64', NODE_ENV: 'production', ELECTRON_OZONE_PLATFORM_HINT: 'auto' });
      if (mode === 'loader') env.LD_PRELOAD = join(root, 'missing-injection.so');
      if (mode === 'node-options') env.NODE_OPTIONS = '--max-old-space-size=4096';
      if (mode === 'relative-path') env.PATH = `first:${env.PATH}`;
      if (mode === 'relative-home') env.HOME = 'profile';
      if (mode === 'missing-flock') env.PATH = join(root, 'bin');
      const fails = mode === 'rollback' || mode === 'interrupted' || mode === 'deletion';
      const dependencies = {
        updateLock: join(root, 'update-lock/update.lock'),
        run: async (executable: string, args: string[], childEnv: NodeJS.ProcessEnv, input?: string) => {
          assert.doesNotMatch(executable, /\/(systemctl|busctl)$/, 'Switching never inspects or controls a service');
          // The installed launcher is first run to verify its version.
          if (executable === cli && fails) {
            if (mode === 'deletion') rmSync(cli); // Owner deletion after publication must survive rollback.
            throw new Error('Injected verification failure');
          }
          const output = await runCommand(executable, args, childEnv, input);
          // An owner edit after a passed verification must still block the commit.
          if (executable === cli && mode === 'changed-after-install') writeFileSync(cli, '#!/bin/sh\nexit 99\n');
          return output;
        },
      };
      const phases: string[] = [];
      const operation = switchToNode({ env, node: process.execPath, bundles, database }, text => {
        phases.push(text);
        if (mode === 'conflict' && text.startsWith('Installing')) { rmSync(cli); writeFileSync(cli, 'owner changed configuration', { mode: 0o700 }); }
        if (mode === 'interrupted' && text.startsWith('Switch failed.')) throw new Error('Injected interruption before rollback');
      }, dependencies);
      const pending = join(root, 'state/pinote/backend-switch/pending.json');
      if (mode === 'interpreter-shim') {
        await assert.rejects(operation, /interpreter shim/);
        await assert.rejects(lstat(join(root, 'shim-ran')), { code: 'ENOENT' });
        assert.equal(await readlink(cli), old); continue;
      }
      if (mode === 'lossy-launcher') {
        await assert.rejects(operation, /encoding|UTF-8/i);
        assert.deepEqual(await readlink(cli, { encoding: 'buffer' }), invalid);
        assert.deepEqual(await readFile(database), source);
        continue;
      }
      if (['loader', 'node-options', 'node-wrapper', 'relative-path', 'missing-flock', 'user-wrapper', 'relative-home'].includes(mode)) {
        await assert.rejects(operation, mode === 'relative-home' ? /absolute HOME/ : mode === 'relative-path' ? /absolute PATH/ : mode === 'missing-flock' ? /flock/ : mode === 'node-wrapper' ? /different Node runtime/ : mode === 'loader' ? /runtime injection setting LD_PRELOAD/ : mode === 'node-options' ? /runtime injection setting NODE_OPTIONS/ : /custom CLI wrapper/);
        if (mode !== 'relative-home') { assert.equal(await readlink(cli), old); await assert.rejects(lstat(pending), { code: 'ENOENT' }); }
        assert.deepEqual(await readFile(database), source); continue;
      }
      if (mode === 'python' || mode === 'node' || isPip) {
        await operation;
        assert.match(await runCommand(cli, ['--version'], env), /^pinote 0\.26\.0/);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, undefined);
        const different = { ...env, PINOTE_ELECTRON_BACKEND: '/another/explicit/backend' };
        assert.equal((await preferredBackendEnvironment(different)).PINOTE_ELECTRON_BACKEND, different.PINOTE_ELECTRON_BACKEND);
      } else {
        await assert.rejects(operation, mode === 'conflict' || mode === 'deletion' || mode === 'changed-after-install' ? /rollback could not finish/ : mode === 'interrupted' ? /Injected interruption before rollback/ : /Injected verification failure/);
        if (mode === 'interrupted') {
          assert.equal(JSON.parse(await readFile(pending, 'utf8')).complete, false);
          await recoverBackendSwitch(env, dependencies);
        }
        if (mode === 'conflict') assert.equal(await readFile(cli, 'utf8'), 'owner changed configuration');
        else if (mode === 'deletion') await assert.rejects(lstat(cli), { code: 'ENOENT' });
        else if (mode === 'changed-after-install') assert.equal(await readFile(cli, 'utf8'), '#!/bin/sh\nexit 99\n');
        else assert.equal(await readlink(cli), old);
        if (mode !== 'changed-after-install') assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, env.PINOTE_ELECTRON_BACKEND);
      }
      await assert.rejects(lstat(join(root, 'config/systemd')), { code: 'ENOENT' });
      assert.deepEqual(await readFile(database), source, 'Switching and rollback never mutate or restore task data');
      if (mode === 'conflict' || mode === 'deletion' || mode === 'changed-after-install') assert.ok((await lstat(pending)).isFile());
      else await assert.rejects(lstat(pending), { code: 'ENOENT' });
      const backupRoot = join(root, 'state/pinote/backend-switch/backups');
      const backup = join(backupRoot, (await readdir(backupRoot))[0]);
      assert.equal((await lstat(join(backup, 'notes.db'))).mode & 0o777, 0o600);
      const db = new DatabaseSync(join(backup, 'notes.db'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT text FROM notes').get()!.text, 'Keep all history and IDs'); } finally { db.close(); }
      assert.equal(await readFile(join(backup, 'state.json'), 'utf8'), '{"draft":"private draft"}');
      assert.ok(phases.some(text => text.includes('Backing up')));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('an interrupted switch from a version that configured pinote.service is left for that version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinote-switch-legacy-'));
  try {
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), PATH: '/usr/bin:/bin' };
    const state = join(root, 'state/pinote/backend-switch'), pending = join(state, 'pending.json');
    await mkdir(state, { recursive: true, mode: 0o700 });
    const journal = JSON.stringify({ version: 1, complete: false, backup: join(state, 'backups/previous'), service: { present: true, active: true, pid: 1 }, files: [] });
    await writeFile(pending, journal, { mode: 0o600 });
    await assert.rejects(recoverBackendSwitch(env), /earlier Pinote.*pinote\.service/);
    assert.equal(await readFile(pending, 'utf8'), journal);
  } finally { await rm(root, { recursive: true, force: true }); }
});
