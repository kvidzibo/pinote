import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, openSync, accessSync, statSync } from 'node:fs';
import { access, chmod, link, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { backendEnvironment } from './backend-command.ts';

// Only main-process values enter this installer. No renderer-supplied paths,
// executable names, service names or shell commands are accepted.
export type SwitchOptions = { env: NodeJS.ProcessEnv; node: string; bundles: string; database: string };
type Run = (executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => Promise<string>;
type Service = { present: boolean; active: boolean; pid: number };
type SavedFile = { path: string; kind: 'missing' | 'file' | 'link'; data: string; mode: number; replacement: string; replacementMode: number; stash?: string; publishIntent?: boolean };
type Journal = { version: 1; complete: boolean; backup: string; service: Service; files: SavedFile[] };
export type SwitchDependencies = { run?: Run; processEnvironment?: (pid: number) => Promise<NodeJS.ProcessEnv>; processArguments?: (pid: number) => Promise<string[]>; processExecutable?: (pid: number) => Promise<string>; processDirectory?: (pid: number) => Promise<string>; updateLock?: string; listening?: (env: NodeJS.ProcessEnv) => Promise<void>; wait?: () => Promise<void> };
const limit = 1024 * 1024;
const xdg = (env: NodeJS.ProcessEnv, name: string, fallback: string) => env[name] && isAbsolute(env[name]!) ? env[name]! : join(env.HOME || homedir(), fallback);
function locations(env: NodeJS.ProcessEnv) {
  const home = env.HOME || homedir();
  return { home, cli: join(home, '.local/bin/note'), preference: join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'pinote/backend.json'),
    dropin: join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'systemd/user/pinote.service.d/90-node-backend.conf'),
    state: join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'pinote/backend-switch'),
    updater: join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'pi-updates') };
}
export async function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((ok, fail) => {
    const child = execFile(executable, args, { env: backendEnvironment(env), timeout: 60000, maxBuffer: limit }, (error, stdout) => {
      if (error) fail(new Error(`Backend switch command failed: ${executable.split('/').at(-1)} ${args[0] || ''}.`));
      else ok(stdout);
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(input);
  });
}
function executable(env: NodeJS.ProcessEnv, name: string): string {
  // The actual executable is checked by execFile; never search relative PATHs.
  const paths = (env.PATH || '').split(':').filter(isAbsolute);
  for (const path of paths) {
    try { accessSync(join(path, name), constants.X_OK); if (statSync(join(path, name)).isFile()) return join(path, name); } catch { /* Try next absolute directory. */ }
  }
  throw new Error(`Backend switching requires ${name} on an absolute PATH.`);
}
async function safeDirectory(path: string, privatePath = false): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & (privatePath ? 0o077 : 0o002))) throw new Error('Unsafe backend-switch directory; repair its ownership or permissions first.');
  if (await realpath(path) !== resolve(path)) throw new Error('Backend-switch directories must not contain symlinks.');
}
async function atomic(path: string, text: string | Buffer, mode = 0o600): Promise<void> {
  await safeDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode, flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function snapshot(path: string, replacement: string, replacementMode: number, allowLink = false): Promise<SavedFile> {
  try {
    const stat = await lstat(path);
    if (stat.uid !== process.getuid!()) throw new Error('A switch target is not owned by this user.');
    if (allowLink && stat.isSymbolicLink()) return { path, kind: 'link', data: await readlink(path), mode: 0, replacement, replacementMode };
    if (!stat.isFile() || stat.size > limit) throw new Error('A switch target is not a bounded regular file.');
    return { path, kind: 'file', data: (await readFile(path)).toString('base64'), mode: stat.mode & 0o777, replacement, replacementMode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, kind: 'missing', data: '', mode: 0, replacement, replacementMode };
  }
}
async function originalMatches(file: SavedFile): Promise<boolean> {
  const current = await snapshot(file.path, '', 0, file.kind === 'link');
  return current.kind === file.kind && current.data === file.data && current.mode === file.mode;
}
function sameFile(a: SavedFile, b: SavedFile): boolean { return a.kind === b.kind && a.data === b.data && a.mode === b.mode; }
const conflict = () => new Error('Configuration changed concurrently; its contents were preserved for recovery.');
async function install(file: SavedFile, persistIntent: () => Promise<void>): Promise<void> {
  const temp = `${file.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, file.replacement, { mode: file.replacementMode, flag: 'wx' });
    if (file.kind !== 'missing') {
      // Capture the actual inode, not just a prior snapshot. The hidden original
      // stays on the same filesystem and preserves even an editor's open FD.
      await rename(file.path, file.stash!);
      if (!sameFile(await snapshot(file.stash!, '', 0, true), file)) {
        await link(file.stash!, file.path).catch(() => {});
        throw conflict();
      }
    }
    // Persist intent before publishing. A subsequently missing target is then
    // an owner deletion or an ambiguous interruption, never permission to recreate it.
    file.publishIntent = true;
    try { await persistIntent(); } catch (error) { file.publishIntent = false; throw error; }
    // Atomic create-if-absent: never rename over a concurrent writer's file.
    try { await link(temp, file.path); }
    catch (error) { file.publishIntent = false; await persistIntent(); throw error; }
  } finally { await rm(temp, { force: true }); }
}
async function restore(file: SavedFile): Promise<void> {
  if (await originalMatches(file)) return;
  const now = await snapshot(file.path, '', 0, true);
  if (now.kind === 'missing' && file.kind !== 'missing') {
    if (file.publishIntent) throw conflict();
    await link(file.stash!, file.path); return;
  }
  const ours = (value: SavedFile) => value.kind === 'file' && value.data === Buffer.from(file.replacement).toString('base64') && value.mode === file.replacementMode;
  if (!ours(now)) throw conflict();
  const captured = join(dirname(file.path), `.${basename(file.path)}.pinote-switch-${randomUUID()}.rollback`);
  await rename(file.path, captured);
  if (!ours(await snapshot(captured, '', 0, true))) {
    await link(captured, file.path).catch(() => {});
    throw conflict();
  }
  if (file.kind !== 'missing') {
    try { await link(file.stash!, file.path); }
    catch (error) { await link(captured, file.path).catch(() => {}); throw error; }
  }
  // Keep captured originals/replacements named in their directory for recovery;
  // unlinking them could discard a concurrent editor's still-open inode.
}
export async function preferredBackendEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  try {
    const path = locations(env).preference, stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.size > 8192 || (stat.mode & 0o022)) throw new Error('Unsafe backend preference.');
    const preference = JSON.parse(await readFile(path, 'utf8'));
    if (preference.version !== 1 || preference.backend !== 'node' || !(preference.ignoredOverride === null || typeof preference.ignoredOverride === 'string' && isAbsolute(preference.ignoredOverride))) throw new Error('Invalid backend preference.');
    const clean = { ...env };
    // Ignore only the exact legacy override the user explicitly replaced.
    // A different, deliberately supplied diagnostic override still takes priority.
    if ((env.PINOTE_ELECTRON_BACKEND ?? null) === preference.ignoredOverride) delete clean.PINOTE_ELECTRON_BACKEND;
    return clean;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return env; throw error; }
}
export async function hasBackendPreference(env: NodeJS.ProcessEnv): Promise<boolean> {
  const effective = await preferredBackendEnvironment(env);
  try { await access(locations(env).preference); return effective.PINOTE_ELECTRON_BACKEND === undefined; }
  catch { return false; }
}
async function service(run: Run, env: NodeJS.ProcessEnv): Promise<Service> {
  const text = await run(executable(env, 'systemctl'), ['--user', 'show', 'pinote.service', '--property=LoadState,ActiveState,MainPID', '--no-pager'], env);
  const values = Object.fromEntries(text.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (!['loaded', 'not-found'].includes(values.LoadState) || !['active', 'inactive', 'failed'].includes(values.ActiveState) || !/^\d+$/.test(values.MainPID || '')) throw new Error('The existing Pinote service is unavailable or changing state; retry when it has settled.');
  return { present: values.LoadState === 'loaded', active: values.ActiveState === 'active', pid: Number(values.MainPID) };
}
async function processEnvironment(pid: number): Promise<NodeJS.ProcessEnv> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Cannot verify the running Pinote service.');
  const raw = await readFile(`/proc/${pid}/environ`);
  if (raw.length > limit) throw new Error('Cannot verify the running Pinote service.');
  const allowed = new Set(['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PINOTE_NOTE_COMMAND', 'PINOTE_HOST', 'PINOTE_PORT', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE', 'PYTHONNOUSERSITE', 'PYTHONSAFEPATH', 'NODE_OPTIONS']);
  return Object.fromEntries(raw.toString().split('\0').map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }).filter(([name]) => allowed.has(name)));
}
async function listening(env: NodeJS.ProcessEnv): Promise<void> {
  const hosts: Record<string, string> = { '127.0.0.1': '127.0.0.1', '0.0.0.0': '127.0.0.1', '::': '::1', '::1': '::1' };
  const host = hosts[env.PINOTE_HOST || '127.0.0.1'], port = Number(env.PINOTE_PORT || 8765);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Automatic switching supports a fixed local Pinote listener only.');
  await new Promise<void>((ok, fail) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); ok(); });
    socket.once('error', () => { socket.destroy(); fail(new Error('Pinote service is not listening after restart.')); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error('Pinote service readiness timed out.')); });
  });
}
async function probe(options: SwitchOptions, run: Run, env = options.env): Promise<string> {
  const raw = await run(options.node, [join(options.bundles, 'bridge.mjs')], env, JSON.stringify({ protocol: 1, operation: 'handshake', params: {} }));
  const value = JSON.parse(raw);
  if (value.protocol !== 1 || value.ok !== true || typeof value.result?.database !== 'string' || typeof value.result?.version !== 'string' || resolve(value.result.database) !== resolve(options.database)) throw new Error('The new backend does not resolve to the same database; nothing will be switched.');
  return value.result.version;
}
async function verifyExistingCLI(options: SwitchOptions, run: Run, env: NodeJS.ProcessEnv): Promise<void> {
  if (['PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE', 'NODE_OPTIONS'].some(key => env[key])) throw new Error('Custom service runtime injection settings require manual database verification.');
  const command = env.PINOTE_NOTE_COMMAND || 'note';
  if (command !== 'note' && !isAbsolute(command)) throw new Error('The service CLI must be a trusted absolute executable.');
  const path = await realpath(command === 'note' ? executable(env, 'note') : command);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 8192) throw new Error('The existing service CLI cannot be verified safely.');
  const text = await readFile(path, 'utf8');
  const pythonBody = 'import sys\nfrom pinote.cli import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())';
  const first = text.split('\n')[0];
  const body = text.slice(first.length + 1).replace(/^# -\*- coding: utf-8 -\*-\n/, '').trim();
  if (/^#!\/[^\r\n]*\/python(?:3(?:\.\d+)?)?$/.test(first) && body === pythonBody) {
    const code = 'import json,sys; from pathlib import Path; sys.path.__setitem__(0, str(Path(sys.argv[1]).parent)) if not sys.flags.safe_path else None; from pinote.paths import Paths; print(json.dumps(str(Paths.discover().database.resolve())))';
    const database = JSON.parse(await run(first.slice(2), ['-c', code, path], env));
    if (typeof database !== 'string' || resolve(database) !== resolve(options.database)) throw new Error('The existing service CLI uses a different database; the switch was blocked.');
    return;
  }
  const nodeEntry = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning\nconst [major, minor] = process.versions.node.split('.').map(Number);\nif (major < 22 || major === 22 && minor < 19) {\n  console.error('Pinote requires Node.js 22.19.0 or newer.'); process.exitCode = 1;\n} else {\n  await import('../dist/cli.mjs');\n}\n";
  if (text === nodeEntry) { await probe({ ...options, bundles: resolve(dirname(path), '../dist') }, run, env); return; }
  if (text === targets(options, undefined)[0].text) { await probe(options, run, env); return; }
  // Never execute an arbitrary wrapper to discover its database: even a read
  // command may activate reminders or hide an XDG override inside the script.
  throw new Error('The existing service uses a custom CLI wrapper. Automatic database verification is unavailable; keep it unchanged and review that wrapper before switching.');
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function systemdQuote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Unsupported service command path.');
  return JSON.stringify(value.replaceAll('%', '%%'));
}
function targets(options: SwitchOptions, serviceArguments: string[] | undefined) {
  const paths = locations(options.env);
  const launcher = `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS NODE_V8_COVERAGE ELECTRON_RUN_AS_NODE\nexec ${shellQuote(options.node)} --disable-warning=ExperimentalWarning ${shellQuote(join(options.bundles, 'cli.mjs'))} "$@"\n`;
  const command = paths.cli.replaceAll('%', '%%');
  if (/[\r\n\0]/.test(command)) throw new Error('Unsupported CLI installation path.');
  return [
    { path: paths.cli, text: launcher, mode: 0o700, link: true },
    ...(serviceArguments ? [{ path: paths.dropin, text: `[Service]\nEnvironment=${JSON.stringify(`PINOTE_NOTE_COMMAND=${command}`)}\nExecStart=\nExecStart=:/usr/bin/env ${[`PINOTE_NOTE_COMMAND=${paths.cli}`, ...serviceArguments].map(systemdQuote).join(' ')}\n`, mode: 0o600, link: false }] : []),
    { path: paths.preference, text: JSON.stringify({ version: 1, backend: 'node', ignoredOverride: options.env.PINOTE_ELECTRON_BACKEND ?? null }), mode: 0o600, link: false },
  ];
}
async function acquire(env: NodeJS.ProcessEnv, updateLock = `/tmp/pi-extension-update-${process.getuid!()}/update.lock`): Promise<() => void> {
  const paths = locations(env), fds: number[] = [];
  try {
    for (const path of [join(paths.updater, 'operation.lock'), join(paths.updater, 'pinote-toggle.lock'), updateLock, join(paths.state, 'switch.lock')]) {
      await safeDirectory(dirname(path), true);
      const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); fds.push(fd);
      // A short helper acquires the shared open-file-description lock, retained
      // by this process. Other subprocesses never inherit these descriptors.
      await new Promise<void>((ok, fail) => {
        const child = spawn(executable(env, 'flock'), ['-n', '-E', '75', '3'], { env: backendEnvironment(env), timeout: 5000, stdio: ['ignore', 'ignore', 'ignore', fd] });
        child.once('error', fail);
        child.once('close', code => code === 0 ? ok() : fail(new Error('An update or desktop operation is running; retry after it finishes.')));
      });
    }
    return () => { for (const fd of fds.reverse()) closeSync(fd); };
  } catch (error) { for (const fd of fds.reverse()) closeSync(fd); throw error; }
}
async function loadJournal(env: NodeJS.ProcessEnv): Promise<Journal | undefined> {
  const paths = locations(env), path = join(paths.state, 'pending.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.size > 6 * limit || (stat.mode & 0o077)) throw new Error('Unsafe switch recovery journal.');
    const journal = JSON.parse(await readFile(path, 'utf8')) as Journal;
    const expected = [paths.cli, paths.dropin, paths.preference];
    if (journal.version !== 1 || typeof journal.complete !== 'boolean' || !journal.service || typeof journal.service.active !== 'boolean' || typeof journal.service.present !== 'boolean' || !Array.isArray(journal.files) || ![2, 3].includes(journal.files.length) || new Set(journal.files.map(f => f.path)).size !== journal.files.length || !journal.files.every(f => expected.includes(f.path) && ['missing', 'file', 'link'].includes(f.kind) && (f.kind !== 'link' || f.path === paths.cli) && typeof f.data === 'string' && f.data.length <= 2 * limit && typeof f.replacement === 'string' && f.replacement.length < 16384 && typeof f.publishIntent === 'boolean' && typeof f.stash === 'string' && dirname(f.stash) === dirname(f.path) && basename(f.stash).startsWith('.' + basename(f.path) + '.pinote-switch-') && Number.isInteger(f.mode) && f.mode >= 0 && f.mode <= 0o777 && [0o600, 0o700].includes(f.replacementMode)) || typeof journal.backup !== 'string' || dirname(journal.backup) !== join(paths.state, 'backups')) throw new Error('Invalid switch recovery journal; preserve it for manual recovery.');
    return journal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function rollback(env: NodeJS.ProcessEnv, journal: Journal, run: Run): Promise<void> {
  const systemctl = executable(env, 'systemctl');
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
  if (journal.service.present) await attempt(() => run(systemctl, ['--user', 'stop', 'pinote.service'], env));
  for (const file of [...journal.files].reverse()) await attempt(() => restore(file));
  if (journal.service.present) {
    await attempt(() => run(systemctl, ['--user', 'daemon-reload'], env));
    if (journal.service.active) await attempt(() => run(systemctl, ['--user', 'start', 'pinote.service'], env));
  }
  if (journal.service.active) await attempt(async () => { if (!(await service(run, env)).active) throw new Error('The prior service could not be resumed.'); });
  if (failures.length) throw new Error('Configuration recovery needs repair; service restoration was attempted.');
  await atomic(join(journal.backup, 'manifest.json'), JSON.stringify({ ...journal, recovered: true }));
  await rm(join(locations(env).state, 'pending.json'));
}
export async function recoverBackendSwitch(env: NodeJS.ProcessEnv, dependencies: SwitchDependencies = {}): Promise<void> {
  if (!await loadJournal(env)) return;
  const release = await acquire(env, dependencies.updateLock);
  try {
    const journal = await loadJournal(env); if (!journal) return;
    if (!journal.complete) await rollback(env, journal, dependencies.run || runCommand);
    else await rm(join(locations(env).state, 'pending.json'));
  } finally { release(); }
}
export async function switchToNode(options: SwitchOptions, progress: (message: string) => void, dependencies: SwitchDependencies = {}): Promise<void> {
  const { env } = options, paths = locations(env), run = dependencies.run || runCommand;
  const release = await acquire(env, dependencies.updateLock);
  let journal: Journal | undefined;
  try {
    if (await loadJournal(env)) throw new Error('An interrupted switch needs recovery; restart Pinote before trying again.');
    progress('Checking the bundled Node runtime and existing service…');
    const targetVersion = await probe(options, run);
    const version = (await run(options.node, [join(options.bundles, 'cli.mjs'), '--version'], env)).trim();
    if (version !== `pinote ${targetVersion}`) throw new Error('Bundled CLI verification failed.');
    const before = await service(run, env);
    if (before.present && !before.active) throw new Error('The installed Pinote service is stopped. Leave it stopped; switch when it is running so its database can be verified.');
    let serviceArguments: string[] | undefined;
    if (before.active) {
      await access('/usr/bin/env', constants.X_OK);
      serviceArguments = await (dependencies.processArguments || (async pid => (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').filter(Boolean)))(before.pid);
      if (serviceArguments.length !== 2 || !isAbsolute(serviceArguments[0]) || !isAbsolute(serviceArguments[1]) || !serviceArguments[1].endsWith('/dist-mcp/mcp/http.js')) throw new Error('Automatic switching requires the documented direct Node HTTP service command.');
      let documented = false;
      try {
        const runtime = await realpath(options.node);
        const running = await realpath(await (dependencies.processExecutable || (pid => readlink(`/proc/${pid}/exe`)))(before.pid));
        const cwd = await (dependencies.processDirectory || (pid => readlink(`/proc/${pid}/cwd`)))(before.pid);
        documented = running === runtime && await realpath(serviceArguments[0]) === runtime && await realpath(serviceArguments[1]) === await realpath(join(cwd, 'pi/dist-mcp/mcp/http.js'));
      } catch { /* An unverifiable process must not be stopped or reconfigured. */ }
      if (!documented) throw new Error('Automatic switching requires the documented direct Node HTTP service in its project working directory, using the same trusted Node runtime as Electron.');
      const serviceEnv = await (dependencies.processEnvironment || processEnvironment)(before.pid);
      await verifyExistingCLI(options, run, serviceEnv);
      await (dependencies.listening || listening)(serviceEnv);
    }
    const files: SavedFile[] = [];
    for (const target of targets(options, serviceArguments)) {
      await safeDirectory(dirname(target.path));
      files.push(await snapshot(target.path, target.text, target.mode, target.link));
    }
    const backup = join(paths.state, 'backups', randomUUID()); await safeDirectory(backup, true);
    for (const file of files) {
      file.stash = join(dirname(file.path), `.${basename(file.path)}.pinote-switch-${randomUUID()}.previous`);
      file.publishIntent = false;
    }
    journal = { version: 1, complete: false, backup, service: before, files };
    await atomic(join(paths.state, 'pending.json'), JSON.stringify(journal));
    await atomic(join(backup, 'manifest.json'), JSON.stringify(journal));
    progress('Backing up configuration, SQLite and saved Electron drafts…');
    if (before.active) await run(executable(env, 'systemctl'), ['--user', 'stop', 'pinote.service'], env);
    // SQLite's online backup API keeps a concurrent CLI writer from producing a
    // torn copy. The source is read-only; journal mode and schema are unchanged.
    await run(options.node, ['--input-type=module', '-e', "import{DatabaseSync,backup}from'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});try{await backup(db,process.argv[2]);}finally{db.close()}", options.database, join(backup, 'notes.db')], env);
    await chmod(join(backup, 'notes.db'), 0o600);
    for (const name of ['state.json', 'window.json']) {
      try { const data = await readFile(join(dirname(options.database), 'electron', name)); await writeFile(join(backup, name), data, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    progress('Installing the CLI and selecting the Node backend…');
    for (const file of files) {
      if (!await originalMatches(file)) throw new Error('Configuration changed during preparation; nothing will be overwritten.');
      await install(file, () => atomic(join(paths.state, 'pending.json'), JSON.stringify(journal)));
    }
    if ((await run(paths.cli, ['--version'], env)).trim() !== version) throw new Error('Installed CLI verification failed.');
    await probe(options, run, await preferredBackendEnvironment(env));
    if (before.active) {
      progress('Restarting and verifying the existing Pinote service…');
      await run(executable(env, 'systemctl'), ['--user', 'daemon-reload'], env);
      await run(executable(env, 'systemctl'), ['--user', 'start', 'pinote.service'], env);
      for (let i = 0; i < 5; i++) {
        await (dependencies.wait || (() => delay(250)))();
        const after = await service(run, env);
        if (!after.active || !after.pid) throw new Error('Pinote service did not restart; restoring the previous installation.');
        const serviceEnv = await (dependencies.processEnvironment || processEnvironment)(after.pid);
        if (serviceEnv.PINOTE_NOTE_COMMAND !== paths.cli) throw new Error('The service environment overrides the new CLI; restoring the previous installation.');
        await probe(options, run, serviceEnv);
        await (dependencies.listening || listening)(serviceEnv);
      }
    }
    const committed: Journal = { ...journal, complete: true };
    await atomic(join(paths.state, 'pending.json'), JSON.stringify(committed));
    journal = committed; // This persisted record is the configuration commit point.
    try {
      await atomic(join(backup, 'manifest.json'), JSON.stringify(journal));
      await rm(join(paths.state, 'pending.json'));
    } catch { progress('Node verified; a completed recovery record is retained for the next launch.'); }
    progress('Node backend verified. Restarting Electron; backups are saved.');
  } catch (error) {
    if (journal && !journal.complete) {
      progress('Switch failed. Restoring the previous configuration…');
      try { await rollback(env, journal, run); }
      catch { throw new Error(`Automatic rollback could not finish. Keep ${paths.state}/pending.json and its backups; repair the configuration before retrying. The database was not restored or converted.`); }
    }
    throw error;
  } finally { release(); }
}
