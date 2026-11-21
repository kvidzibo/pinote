import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rename, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { checkSwitchEnvironment, switchToNode, recoverBackendSwitch, preferredBackendEnvironment, processEnvironment, runCommand } from '../src/backend-switch.ts';

let bundles: string;
before(async () => {
  bundles = await mkdtemp(join(tmpdir(), 'pinote-switch-bundles-'));
  for (const artifact of ['cli.mjs', 'bridge.mjs']) await symlink(resolve('../backend/dist', artifact), join(bundles, artifact));
  await build({ entryPoints: ['src/backend-switch-guard.ts'], outfile: join(bundles, 'switch-guard.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
});
after(async () => { if (bundles) await rm(bundles, { recursive: true, force: true }); });

test('preflight without a user CLI checks the lock helper and service overrides before Node discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinote-preflight-'));
  const env = { HOME: root, PATH: root, PINOTE_NODE: join(root, 'missing-node') };
  const child = spawn('/usr/bin/sleep', ['60'], { env: { ...env, LD_LIBRARY_PATH: root } });
  try {
    await once(child, 'spawn');
    const preview = () => checkSwitchEnvironment(env, bundles, root, async file => {
      assert.equal(file, '/usr/bin/systemctl');
      return `LoadState=loaded\nActiveState=active\nMainPID=${child.pid}\n`;
    });
    const flock = join(root, 'flock');
    await symlink('/usr/bin/true', flock);
    await assert.rejects(preview(), /system flock on the desktop PATH/);
    await assert.rejects(switchToNode({ env, node: env.PINOTE_NODE, database: root, bundles }, () => {}, { updateLock: join(root, 'locks/update.lock') }), /system flock on the desktop PATH/);
    await rm(flock); await symlink('/usr/bin/flock', flock);
    await assert.rejects(preview(), error => error instanceof Error && error.message.includes('pinote.service environment sets LD_LIBRARY_PATH') && !error.message.includes(root));
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

// The double runs the effective, daemon-reloaded ExecStart with one snapshot
// of the unit environment. The disposable HTTP entry opens a listener and
// logs every time HTTP code is reached, independently of systemctl attempts.
async function unitDouble(root: string, dropin: string) {
  const script = join(root, 'pi/dist-mcp/mcp/http.js'), marker = join(root, 'http-starts');
  const guard = join(dirname(dropin), '99-pinote-switch-guard.conf');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, `
const { appendFileSync } = require('node:fs');
const { createServer } = require('node:http');
appendFileSync(${JSON.stringify(marker)}, process.env.XDG_DATA_HOME + '\\n');
createServer().listen(0, '127.0.0.1', () => process.stdout.write('listening\\n'));
`);
  const base = [process.execPath, script];
  let command = base, flags: string[] = [], restart = 'on-failure', unset: string[] = [];
  let http: ReturnType<typeof spawn> | undefined;
  const text = (file: string) => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const readCommand = (line: string) => line.match(/"(?:[^"\\]|\\.)*"|\S+/g)!.map(token => (token.startsWith('"') ? JSON.parse(token) as string : token).replaceAll('%%', '%'));
  return {
    script, guard,
    async arguments() { return http?.pid ? (await readFile(`/proc/${http.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean) : base; },
    get pid() { return http?.pid; },
    async reload(ignoreGuard = false) {
      command = base; flags = []; restart = 'on-failure'; unset = [];
      for (const line of `${await text(dropin)}\n${ignoreGuard ? '' : await text(guard)}`.split('\n')) {
        if (line.startsWith('ExecStart=:')) { command = readCommand(line.slice('ExecStart=:'.length)); flags = ['no-env-expand']; }
        if (line.startsWith('Restart=')) restart = line.slice('Restart='.length);
        if (line.startsWith('UnsetEnvironment=')) unset = line.slice('UnsetEnvironment='.length).split(' ');
      }
    },
    property(name: string, wrapper?: string) {
      const properties: Record<string, [string, unknown]> = {
        ExecStartEx: ['a(sasasttttuii)', [[wrapper ?? command[0], command, flags]]],
        WorkingDirectory: ['s', root], Restart: ['s', restart], RestartForceExitStatus: ['(aiai)', [[], []]], UnsetEnvironment: ['as', unset],
      };
      const [type, data] = properties[name] ?? ['a(sasasttttuii)', []];
      return JSON.stringify({ type, data });
    },
    async start(environment: NodeJS.ProcessEnv) {
      const env = { ...environment };
      for (const name of unset) delete env[name];
      const child = http = spawn(command[0], command.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((ok, fail) => {
        let stdout = '', stderr = '';
        const timer = setTimeout(() => fail(new Error('Test HTTP startup timed out')), 10000);
        const clear = () => clearTimeout(timer);
        child.stderr!.on('data', data => { stderr += data; });
        child.stdout!.on('data', data => { stdout += data; if (stdout.includes('listening\n')) { clear(); ok(); } });
        child.once('error', error => { clear(); fail(error); });
        child.once('close', code => { clear(); fail(new Error(`ExecStart exited (${code}): ${stderr}`)); });
      });
    },
    async stop() {
      if (http && http.exitCode === null && http.signalCode === null) { const exited = once(http, 'close'); http.kill(); await exited; }
      http = undefined;
    },
    async httpStarts() { return (await text(marker)).split('\n').filter(Boolean); },
  };
}

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
  for (const mode of ['success', 'no-service', 'fallback-db', 'rollback', 'interrupted', 'wrapper', 'conflict', 'absent-variable', 'deletion', 'deletion-new', 'service-wrapper', 'service-script', 'loader', 'node-wrapper', 'relative-path', 'missing-flock', 'unit-wrapper', 'user-wrapper', 'lossy-launcher', 'relative-home', 'isolated-service', 'pip', 'pip-lazy', 'interpreter-shim', 'changed-after-start'] as const) {
    // This optional kernel check requires unprivileged user/mount namespaces.
    if (mode === 'isolated-service' && !process.env.PINOTE_TEST_UNSHARE) continue;
    const root = await mkdtemp(join(tmpdir(), mode === 'interpreter-shim' ? 'pinote-shim-' : "pinote switch-'"));
    let injected: ReturnType<typeof spawn> | undefined, unit: Awaited<ReturnType<typeof unitDouble>> | undefined;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), PATH: `${root}/bin:/usr/bin:/bin`, PINOTE_ELECTRON_BACKEND: join(root, 'python-backend') };
      // A real service does not inherit node:test's NODE_TEST_CONTEXT or the
      // test runner's runtime hooks. Keep the injection fixture explicit below.
      for (const key of Object.keys(env)) if (/^(LD_|NODE_|ELECTRON_|PYTHON)/.test(key) || ['GCONV_PATH', 'GLIBC_TUNABLES'].includes(key)) delete env[key];
      await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin/systemctl'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
      if (mode === 'node-wrapper') await writeFile(join(root, 'bin/node'), '#!/bin/sh\nexport XDG_DATA_HOME=/different\nexit 1\n', { mode: 0o700 });
      else await symlink(process.execPath, join(root, 'bin/node'));
      await mkdir(join(root, '.local/bin'), { recursive: true });
      const custom = join(root, 'old-note'); await writeFile(custom, '#!/bin/sh\nprintf old\\n\n', { mode: 0o700 });
      const isPip = mode === 'pip' || mode === 'pip-lazy' || mode === 'interpreter-shim';
      const old = isPip ? join(root, 'pip-note') : mode === 'user-wrapper' ? custom : mode === 'no-service' ? resolve('../backend/bin/note') : resolve('../.venv/bin/note');
      if (isPip) {
        const entry = mode === 'pip' ? "from pinote.cli import main\nif __name__ == '__main__':" : "if __name__ == '__main__':\n    from pinote.cli import main";
        const interpreter = mode === 'interpreter-shim' ? join(root, 'bin/python') : resolve('../.venv/bin/python');
        if (mode === 'interpreter-shim') await writeFile(interpreter, `#!/bin/sh\ntouch '${root}/shim-ran'\nexit 1\n`, { mode: 0o700 });
        await writeFile(old, `#!${interpreter}\n# -*- coding: utf-8 -*-\nimport re\nimport sys\n${entry}\n    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n    sys.exit(main())\n`, { mode: 0o700 });
      }
      if (mode === 'absent-variable') {
        env.PINOTE_NOTE_COMMAND = resolve('../backend/bin/note'); // Desktop-only override must NOT leak.
        await writeFile(join(root, 'bin/note'), '#!/bin/sh\nexport XDG_DATA_HOME=/another/database\nexec note "$@"\n', { mode: 0o700 });
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
      if (mode === 'fallback-db') {
        await rm(cli);
        const bin = join(root, 'fallback/bin'), dist = join(root, 'fallback/dist');
        await mkdir(bin, { recursive: true }); await mkdir(dist);
        await writeFile(join(bin, 'note'), await readFile(resolve('../backend/bin/note')), { mode: 0o700 });
        await symlink(join(bin, 'note'), join(root, 'bin/note'));
        await writeFile(join(dist, 'bridge.mjs'), `console.log(JSON.stringify({protocol:1,ok:true,result:{version:'test',database:${JSON.stringify(join(root, 'other.db'))}}}))`);
      }
      if (mode === 'isolated-service') {
        injected = spawn('unshare', ['-Urmn', process.execPath, '-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { env, stdio: ['ignore', 'pipe', 'ignore'] });
        const first = await injected.stdout![Symbol.asyncIterator]().next();
        assert.equal(first.value?.toString(), 'ready', 'unshare must be available for this opt-in check');
      }
      if (mode === 'loader') {
        injected = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { ...env, LD_PRELOAD: join(root, 'missing-injection.so') }, stdio: 'ignore' });
        await once(injected, 'spawn');
      }
      await mkdir(join(dirname(database), 'electron'));
      await writeFile(join(dirname(database), 'electron/state.json'), '{"draft":"private draft"}', { mode: 0o600 });
      const dropin = join(root, 'config/systemd/user/pinote.service.d/90-node-backend.conf');
      const manager = unit = await unitDouble(root, dropin);
      const script = mode === 'service-script' ? join(root, 'foreign/dist-mcp/mcp/http.js') : manager.script;
      let active = mode !== 'no-service', starts = 0, fail = mode === 'rollback' || mode === 'interrupted' || mode === 'deletion' || mode === 'deletion-new';
      const existingCLI = mode === 'wrapper' ? custom : isPip ? old : mode === 'success' ? resolve('../.venv/bin/note') : resolve('../backend/bin/note');
      const commands: string[] = [];
      let warmingUp = true;
      const dependencies = {
        updateLock: join(root, 'update-lock/update.lock'),
        processArguments: async () => manager.pid ? manager.arguments() : [process.execPath, script],
        processExecutable: async () => mode === 'service-wrapper' ? '/bin/sh' : process.execPath,
        processDirectory: async () => root,
        run: async (executable: string, args: string[], childEnv: NodeJS.ProcessEnv, input?: string) => {
          if (executable === '/usr/bin/busctl') return manager.property(args.at(-1)!, mode === 'unit-wrapper' ? custom : undefined);
          if (!executable.endsWith('/systemctl')) return runCommand(executable, args, childEnv, input);
          const action = args[1]; commands.push(action);
          if (action === 'show' && ['user-wrapper', 'lossy-launcher', 'no-service', 'fallback-db'].includes(mode)) return 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n';
          if (action === 'show') return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? manager.pid || injected?.pid || process.pid : 0}\n`;
          if (action === 'stop') { active = false; await manager.stop(); }
          if (action === 'daemon-reload') await manager.reload();
          if (action === 'start') {
            starts++;
            if (mode === 'deletion' && starts === 1) rmSync(cli);
            if (mode === 'deletion-new' && starts === 1) rmSync(dropin); // Owner deletion after publication must survive rollback.
            if (fail && (mode === 'interrupted' || starts === 1)) throw new Error('Injected restart failure');
            await manager.start({ ...env, PINOTE_NOTE_COMMAND: existingCLI });
            if (mode === 'changed-after-start') await writeFile(cli, '#!/bin/sh\nexit 99\n');
            active = true;
          }
          return '';
        },
        processEnvironment: mode === 'loader' ? undefined : async () => {
          if (manager.pid) return processEnvironment(manager.pid);
          const captured: NodeJS.ProcessEnv = { ...env, PINOTE_NOTE_COMMAND: existingCLI };
          if (mode === 'absent-variable') delete captured.PINOTE_NOTE_COMMAND;
          if (mode === 'relative-path') captured.PATH = `first:${env.PATH}`;
          if (mode === 'relative-home') { captured.HOME = 'profile'; delete captured.XDG_DATA_HOME; }
          if (mode === 'missing-flock') captured.PATH = join(root, 'bin');
          return captured;
        },
        listening: async () => {
          if (mode === 'success' && starts && warmingUp) { warmingUp = false; throw new Error('Listener is still starting'); }
        }, wait: async () => {},
      };
      const phases: string[] = [];
      const desktopEnv = { ...env, PATH: `${root}/.local/bin:${env.PATH}`, PINOTE_NODE: process.execPath };
      if (mode === 'success' && process.env.PINOTE_TEST_SYSTEM_CUDA === '1') Object.assign(desktopEnv, { LD_LIBRARY_PATH: '/usr/local/cuda/lib64' });
      if (mode === 'fallback-db') {
        assert.equal(await checkSwitchEnvironment(desktopEnv, bundles, database, async (file, args, env, input) => {
          assert.equal(file, '/usr/bin/systemctl', 'Preview never executes the fallback installation');
          return dependencies.run(file, args, env, input);
        }), 'absent');
      }
      const operation = switchToNode({ env: desktopEnv, node: process.execPath, bundles, database }, text => {
        phases.push(text);
        if (mode === 'conflict' && text.startsWith('Installing')) { rmSync(cli); writeFileSync(cli, 'owner changed configuration', { mode: 0o700 }); }
      }, dependencies);
      if (mode === 'fallback-db') {
        await assert.rejects(operation, /different database/);
        await assert.rejects(lstat(cli), { code: 'ENOENT' });
        await assert.rejects(lstat(join(root, 'config/pinote/backend.json')), { code: 'ENOENT' });
        assert.deepEqual(await readFile(database), source);
        continue;
      }
      if (mode === 'changed-after-start') {
        await assert.rejects(operation, /rollback could not finish/);
        assert.equal(active, false);
        assert.equal(await readFile(cli, 'utf8'), '#!/bin/sh\nexit 99\n');
        assert.ok((await lstat(join(root, 'state/pinote/backend-switch/pending.json'))).isFile());
        continue;
      }
      if (mode === 'interpreter-shim') {
        await assert.rejects(operation, /interpreter shim/);
        await assert.rejects(lstat(join(root, 'shim-ran')), { code: 'ENOENT' });
        assert.ok(!commands.includes('stop')); assert.equal(await readlink(cli), old); continue;
      }
      if (mode === 'isolated-service') {
        await assert.rejects(operation, /filesystem|EACCES|EPERM/);
        assert.ok(!commands.includes('stop')); assert.equal(await readlink(cli), old); continue;
      }
      if (mode === 'lossy-launcher') {
        await assert.rejects(operation, /encoding|UTF-8/i);
        assert.deepEqual(await readlink(cli, { encoding: 'buffer' }), invalid);
        assert.deepEqual(await readFile(database), source);
        continue;
      }
      if (['wrapper', 'absent-variable', 'service-wrapper', 'service-script', 'loader', 'node-wrapper', 'relative-path', 'missing-flock', 'unit-wrapper', 'user-wrapper', 'relative-home'].includes(mode)) {
        await assert.rejects(operation, mode === 'relative-home' ? /absolute HOME/ : mode === 'relative-path' ? /absolute pinote\.service PATH/ : mode === 'missing-flock' ? /flock/ : mode === 'node-wrapper' ? /different Node runtime/ : mode === 'loader' ? /pinote\.service environment sets LD_PRELOAD/ : mode.startsWith('service-') || mode === 'unit-wrapper' ? /documented direct Node HTTP/ : /custom CLI wrapper/);
        assert.equal(active, true); assert.ok(!commands.includes('stop'));
        assert.deepEqual(await readFile(database), source); continue;
      }
      if (mode === 'success' || mode === 'no-service' || isPip) {
        await operation;
        if (mode === 'success') {
          assert.equal(await checkSwitchEnvironment(desktopEnv, bundles, database, dependencies.run), 'matches');
          const directPreview = (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) =>
            file === '/usr/bin/busctl' && args.at(-1) === 'ExecStartEx'
              ? Promise.resolve(JSON.stringify({type:'a(sasasttttuii)', data:[[process.execPath,[process.execPath,script],[]]]}))
              : dependencies.run(file, args, env, input);
          assert.equal(await checkSwitchEnvironment(desktopEnv, bundles, database, directPreview), 'different');
          await chmod(cli, 0o755);
          await assert.rejects(checkSwitchEnvironment(desktopEnv, bundles, database, dependencies.run), /already managed/);
          await chmod(cli, 0o700);
          await assert.rejects(checkSwitchEnvironment(desktopEnv, bundles, join(root, 'other.db'), dependencies.run), /same database/);
        }
        assert.match(await runCommand(cli, ['--version'], env), /^pinote 0\.26\.0/);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, undefined);
        if (mode === 'no-service') await assert.rejects(lstat(dropin), { code: 'ENOENT' });
        else assert.match(await readFile(dropin, 'utf8'), /ExecStart=:\/usr\/bin\/env /);
        const different = { ...env, PINOTE_ELECTRON_BACKEND: '/another/explicit/backend' };
        assert.equal((await preferredBackendEnvironment(different)).PINOTE_ELECTRON_BACKEND, different.PINOTE_ELECTRON_BACKEND);
      } else {
        await assert.rejects(operation, mode === 'interrupted' || mode === 'conflict' || mode === 'deletion' ? /rollback could not finish/ : /Injected restart failure/);
        if (mode === 'interrupted') {
          assert.equal(active, false); fail = false;
          await assert.rejects(recoverBackendSwitch({ ...env, LD_LIBRARY_PATH: root }, () => ({ node: process.execPath, bundles }), dependencies), /desktop environment sets LD_LIBRARY_PATH/);
          await recoverBackendSwitch(env, () => ({ node: process.execPath, bundles }), dependencies);
        }
        if (mode === 'conflict') assert.equal(await readFile(cli, 'utf8'), 'owner changed configuration');
        else if (mode === 'deletion') await assert.rejects(lstat(cli), { code: 'ENOENT' });
        else assert.equal(await readlink(cli), old);
        assert.equal((await preferredBackendEnvironment(env)).PINOTE_ELECTRON_BACKEND, env.PINOTE_ELECTRON_BACKEND);
        await assert.rejects(lstat(dropin), { code: 'ENOENT' });
      }
      assert.equal(active, !['conflict', 'deletion', 'no-service'].includes(mode), 'Unverified rollback stays stopped; a completed rollback resumes the service');
      assert.equal((await manager.httpStarts()).length, active ? 1 : 0);
      await assert.rejects(lstat(manager.guard), { code: 'ENOENT' });
      assert.deepEqual(await readFile(database), source, 'Switching and rollback never mutate or restore task data');
      if (mode === 'conflict' || mode === 'deletion') assert.ok((await lstat(join(root, 'state/pinote/backend-switch/pending.json'))).isFile());
      else await assert.rejects(lstat(join(root, 'state/pinote/backend-switch/pending.json')), { code: 'ENOENT' });
      const backupRoot = join(root, 'state/pinote/backend-switch/backups');
      const backup = join(backupRoot, (await readdir(backupRoot))[0]);
      assert.equal((await lstat(join(backup, 'notes.db'))).mode & 0o777, 0o600);
      const db = new DatabaseSync(join(backup, 'notes.db'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT text FROM notes').get()!.text, 'Keep all history and IDs'); } finally { db.close(); }
      assert.equal(await readFile(join(backup, 'state.json'), 'utf8'), '{"draft":"private draft"}');
      assert.equal(commands.includes('daemon-reload'), mode !== 'no-service'); assert.ok(phases.some(text => text.includes('Backing up')));
    } finally {
      await unit?.stop();
      if (injected && injected.exitCode === null && injected.signalCode === null) { const exited = once(injected, 'exit'); injected.kill('SIGTERM'); await exited; }
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('systemd guards forward and recovery starts before HTTP sees an edited EnvironmentFile', async t => {
  for (const mode of ['immediate', 'startup', 'guard-not-loaded', 'owner-guard-edit'] as const) await t.test(mode, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pinote-switch-profile-'));
    let unit: Awaited<ReturnType<typeof unitDouble>> | undefined;
    try {
      const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'profile-a'), PATH: `${root}/.local/bin:${root}/bin:/usr/bin:/bin` };
      const profileB = join(root, 'profile-b');
      const database = join(env.XDG_DATA_HOME, 'pinote/notes.db'), databaseB = join(profileB, 'pinote/notes.db');
      const runtime = { node: process.execPath, bundles }, old = resolve('../backend/bin/note');
      const cli = join(root, '.local/bin/note'), dropin = join(env.XDG_CONFIG_HOME, 'systemd/user/pinote.service.d/90-node-backend.conf');
      const manager = unit = await unitDouble(root, dropin);
      const environmentFile = join(root, 'service.env');
      const pending = join(env.XDG_STATE_HOME, 'pinote/backend-switch/pending.json');
      await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin/systemctl'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
      await symlink(runtime.node, join(root, 'bin/node'));
      await mkdir(dirname(cli), { recursive: true }); await symlink(old, cli);
      for (const [profile, note] of [[env.XDG_DATA_HOME, 'Original task'], [profileB, 'Other profile task']]) {
        await runCommand(runtime.node, [join(runtime.bundles, 'cli.mjs'), '--no-notify', note], { ...env, XDG_DATA_HOME: profile });
      }
      const source = await readFile(database), other = await readFile(databaseB);
      // The old process saw A. Only at start does systemd read the edited file.
      const edited = `XDG_DATA_HOME=${profileB}\n`;
      await writeFile(environmentFile, edited);
      let active = true, ignoreGuard = mode === 'guard-not-loaded';
      const starts: string[] = [];
      const dependencies = {
        updateLock: join(root, 'update-lock/update.lock'),
        processArguments: manager.arguments,
        processExecutable: async () => runtime.node,
        processDirectory: async () => root,
        processEnvironment: async () => manager.pid ? processEnvironment(manager.pid) : { ...env, PINOTE_NOTE_COMMAND: old },
        listening: async () => {}, wait: async () => {},
        run: async (executable: string, args: string[], childEnv: NodeJS.ProcessEnv, input?: string) => {
          if (executable === '/usr/bin/busctl') return manager.property(args.at(-1)!);
          if (!executable.endsWith('/systemctl')) return runCommand(executable, args, childEnv, input);
          if (args[1] === 'show') return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? manager.pid || process.pid : 0}\n`;
          if (args[1] === 'stop') { active = false; await manager.stop(); }
          if (args[1] === 'daemon-reload') await manager.reload(ignoreGuard);
          if (args[1] === 'start') {
            const runningData = (await readFile(environmentFile, 'utf8')).trimEnd().slice('XDG_DATA_HOME='.length);
            starts.push(runningData);
            await manager.start({ ...env, XDG_DATA_HOME: runningData, PINOTE_NOTE_COMMAND: old });
            active = true;
          }
          return '';
        },
      };
      const changed = /Cannot verify the restored service database.*EnvironmentFile.*service was stopped.*pending\.json/;
      const ownerEdit = '# owner edit to the guard\n';
      const operation = switchToNode({ env, ...runtime, database }, message => {
        if (!message.startsWith('Switch failed.')) return;
        if (mode === 'startup') throw new Error('Injected interruption before rollback');
        if (mode === 'owner-guard-edit') writeFileSync(manager.guard, ownerEdit);
      }, dependencies);
      if (mode === 'startup') {
        await assert.rejects(operation, /Injected interruption before rollback/);
        assert.equal(active, false);
        assert.deepEqual(starts, [profileB]);
        assert.deepEqual(await manager.httpStarts(), []);
        assert.ok((await lstat(manager.guard)).isFile());
        await assert.rejects(recoverBackendSwitch(env, () => runtime, dependencies), changed);
      } else if (mode === 'owner-guard-edit') {
        await assert.rejects(operation, /concurrent configuration changes/);
        assert.equal(await readFile(manager.guard, 'utf8'), ownerEdit);
        await assert.rejects(recoverBackendSwitch(env, () => runtime, dependencies), /concurrent configuration changes/);
        assert.equal(await readFile(manager.guard, 'utf8'), ownerEdit);
        await rm(manager.guard); // Owner resolves the configuration conflict.
      } else await assert.rejects(operation, changed);

      assert.deepEqual(starts, mode === 'guard-not-loaded' ? [] : mode === 'owner-guard-edit' ? [profileB] : [profileB, profileB]);
      assert.deepEqual(await manager.httpStarts(), [], 'Neither the forward guard nor the restored guard may enter HTTP on profile B');
      assert.equal(active, false);
      assert.equal(await readlink(cli), old);
      await assert.rejects(lstat(dropin), { code: 'ENOENT' });
      const journal = JSON.parse(await readFile(pending, 'utf8'));
      assert.equal(journal.originalDatabase.path, database);
      assert.equal(journal.complete, false);
      assert.equal(await readFile(environmentFile, 'utf8'), edited, 'Recovery must preserve the owner’s EnvironmentFile edit');
      assert.deepEqual(await readFile(database), source);
      assert.deepEqual(await readFile(databaseB), other);

      await writeFile(environmentFile, `XDG_DATA_HOME=${env.XDG_DATA_HOME}\n`);
      ignoreGuard = false;
      if (mode === 'immediate') {
        // Even at the original path, a replacement file is not the original database.
        await rename(database, `${database}.original`);
        await writeFile(database, source);
        await assert.rejects(recoverBackendSwitch(env, () => runtime, dependencies), changed);
        assert.deepEqual(await manager.httpStarts(), []);
        assert.equal(active, false);
        await rename(`${database}.original`, database);
      }
      await recoverBackendSwitch(env, () => runtime, dependencies);
      assert.equal(active, true);
      assert.deepEqual(await manager.httpStarts(), [env.XDG_DATA_HOME]);
      await assert.rejects(lstat(manager.guard), { code: 'ENOENT' });
      await assert.rejects(lstat(pending), { code: 'ENOENT' });
    } finally { await unit?.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
