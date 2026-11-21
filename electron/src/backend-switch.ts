import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, openSync, accessSync, statSync } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, readFile, readlink as readLinkBytes, realpath as realPathBytes, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { backendEnvironment } from './backend-command.ts';

// Only main-process values enter this installer. No renderer-supplied paths,
// executable names or shell commands are accepted.
type SwitchRuntime = { node: string; bundles: string };
export type SwitchOptions = SwitchRuntime & { env: NodeJS.ProcessEnv; database: string };
type Run = (executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => Promise<string>;
type SavedFile = { path: string; kind: 'missing' | 'file' | 'link'; data: string; mode: number; replacement: string; replacementMode: number; stash?: string; publishIntent?: boolean };
type Journal = { version: 1; complete: boolean; backup: string; files: SavedFile[] };
export type SwitchDependencies = { run?: Run; updateLock?: string };
const limit = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const realpath = async (path: string) => utf8.decode(await realPathBytes(path, { encoding: 'buffer' }));
const readlink = async (path: string) => utf8.decode(await readLinkBytes(path, { encoding: 'buffer' }));
const xdg = (env: NodeJS.ProcessEnv, name: string, fallback: string) => env[name] && isAbsolute(env[name]!) ? env[name]! : join(env.HOME || homedir(), fallback);
function locations(env: NodeJS.ProcessEnv) {
  verifySwitchPaths(env, ['HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']);
  const home = env.HOME || homedir();
  return { home, cli: join(home, '.local/bin/note'), preference: join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'pinote/backend.json'),
    state: join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'pinote/backend-switch'),
    updater: join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'pi-updates') };
}
export async function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string, timeout = 60000): Promise<string> {
  return new Promise((ok, fail) => {
    const child = execFile(executable, args, { env: backendEnvironment(env), timeout, maxBuffer: limit, encoding: 'buffer' }, (error, stdout) => {
      if (error) fail(new Error(`Backend switch command failed: ${executable.split('/').at(-1)} ${args[0] || ''}.`));
      else { try { ok(utf8.decode(stdout)); } catch (err) { fail(err); } }
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
    const preference = JSON.parse(utf8.decode(await readFile(path)));
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
function runtimeInjection(name: string): boolean { return /^(LD_|NODE_|ELECTRON_|PYTHON)/.test(name) || name === 'GCONV_PATH' || name === 'GLIBC_TUNABLES'; }
export async function processEnvironment(pid: number): Promise<NodeJS.ProcessEnv> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Cannot verify the process environment.');
  const raw = await readFile(`/proc/${pid}/environ`);
  if (raw.length > limit) throw new Error('Cannot verify the process environment.');
  const allowed = new Set(['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PINOTE_NOTE_COMMAND', 'PINOTE_NODE', 'PINOTE_ELECTRON_BACKEND', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'KITTY_LISTEN_ON']);
  return Object.fromEntries(raw.toString('latin1').split('\0').map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }).filter(([name]) => name && (allowed.has(name) || runtimeInjection(name))).map(([key, value]) => [key, utf8.decode(Buffer.from(value, 'latin1'))]));
}
function databasePath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0') && resolve(path) === path;
}
async function probeBackend(runtime: SwitchRuntime, run: Run, env: NodeJS.ProcessEnv): Promise<{ database: string; version: string }> {
  const raw = await run(runtime.node, [join(runtime.bundles, 'bridge.mjs')], env, JSON.stringify({ protocol: 1, operation: 'handshake', params: {} }));
  const value = JSON.parse(raw);
  if (value.protocol !== 1 || value.ok !== true || !databasePath(value.result?.database) || typeof value.result?.version !== 'string') throw new Error('Cannot verify the Node backend database.');
  return value.result;
}
async function probe(options: SwitchOptions, run: Run, env = options.env): Promise<string> {
  const { database, version } = await probeBackend(options, run, env);
  if (database !== resolve(options.database)) throw new Error('The new backend does not resolve to the same database; nothing will be switched.');
  return version;
}
export function verifySwitchPaths(env: NodeJS.ProcessEnv, keys = ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']): void {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error('Backend selection requires an absolute HOME independent of the working directory.');
  for (const key of keys) {
    if (env[key]?.split('/').includes('..')) throw new Error('Backend switching requires unambiguous home and XDG paths without parent-directory components.');
  }
}
async function verifyCLIEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  verifySwitchPaths(env);
  if (Object.keys(env).some(key => env[key] && runtimeInjection(key))) throw new Error('Custom runtime injection settings require manual database verification.');
  if (!env.PATH || env.PATH.split(':').some(path => !isAbsolute(path) || path.split('/').includes('..'))) throw new Error('Automatic switching requires an unambiguous absolute PATH.');
  if (await realpath(executable(env, 'flock')) !== await realpath('/usr/bin/flock')) throw new Error('Automatic switching requires the system flock on PATH.');
}
async function existingCLIDatabase(runtime: SwitchRuntime, run: Run, env: NodeJS.ProcessEnv, cli: string): Promise<string> {
  await verifyCLIEnvironment(env);
  const path = await realpath(cli);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 8192) throw new Error('The existing CLI cannot be verified safely.');
  const text = utf8.decode(await readFile(path));
  const pythonBody = 'import sys\nfrom pinote.cli import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())';
  // pip/pipx distlib launchers have shipped both import placements. Match
  // the entire generated body, without executing the wrapper.
  const pipTail = String.raw`    sys.argv[0] = re.sub(r'(-script\.pyw|\.exe)?$', '', sys.argv[0])
    sys.exit(main())`;
  const pipBodies = ["from pinote.cli import main\nif __name__ == '__main__':", "if __name__ == '__main__':\n    from pinote.cli import main"]
    .map(entry => 'import re\nimport sys\n' + entry + '\n' + pipTail);
  const first = text.split('\n')[0];
  const body = text.slice(first.length + 1).replace(/^# -\*- coding: utf-8 -\*-\n/, '').trim();
  if (/^#!\/[^\s]*\/python(?:3(?:\.\d+)?)?$/.test(first) && (body === pythonBody || pipBodies.includes(body))) {
    // Preserve the original venv path when invoking Python, but never run a
    // script-based interpreter shim to discover which database it would use.
    const interpreter = first.slice(2), binary = await realpath(interpreter);
    const fd = await open(binary, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat();
      const magic = Buffer.alloc(4);
      if (!info.isFile() || !/^python(?:3(?:\.\d+)?)?$/.test(basename(binary)) ||
          (await fd.read(magic, 0, 4, 0)).bytesRead !== 4 || !magic.equals(Buffer.from('\x7fELF'))) {
        throw new Error('Automatic switching requires a native Python interpreter, not an interpreter shim.');
      }
    } finally { await fd.close(); }
    const code = 'import json,sys; from pathlib import Path; sys.path.__setitem__(0, str(Path(sys.argv[1]).parent)) if not sys.flags.safe_path else None; from pinote.paths import Paths; print(json.dumps(str(Paths.discover().database.resolve())))';
    const database = JSON.parse(await run(interpreter, ['-c', code, path], env));
    if (!databasePath(database)) throw new Error('Cannot verify the Python CLI database.');
    return database;
  }
  const nodeEntry = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning\nconst [major, minor] = process.versions.node.split('.').map(Number);\nif (major < 22 || major === 22 && minor < 19) {\n  console.error('Pinote requires Node.js 22.19.0 or newer.'); process.exitCode = 1;\n} else {\n  await import('../dist/cli.mjs');\n}\n";
  if (text === nodeEntry) {
    if (await realpath(executable(env, 'node')) !== await realpath(runtime.node)) throw new Error('The existing CLI would run a different Node runtime from PATH; automatic switching was blocked.');
    return (await probeBackend({ ...runtime, bundles: resolve(dirname(path), '../dist') }, run, env)).database;
  }
  if (text === launcher(runtime)) return (await probeBackend(runtime, run, env)).database;
  // Never execute an arbitrary wrapper to discover its database: even a read
  // command may activate reminders or hide an XDG override inside the script.
  throw new Error('The existing note command is a custom CLI wrapper. Automatic database verification is unavailable; keep it unchanged and review that wrapper before switching.');
}
async function verifyExistingCLI(options: SwitchOptions, run: Run, cli: string): Promise<string> {
  const database = await existingCLIDatabase(options, run, options.env, cli);
  if (database !== resolve(options.database)) throw new Error('The existing CLI uses a different database; the switch was blocked.');
  return database;
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function launcher(runtime: SwitchRuntime): string {
  return `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS NODE_V8_COVERAGE ELECTRON_RUN_AS_NODE\nexec ${shellQuote(runtime.node)} --disable-warning=ExperimentalWarning ${shellQuote(join(runtime.bundles, 'cli.mjs'))} "$@"\n`;
}
export async function hasInstalledLauncher(options: SwitchOptions): Promise<boolean> {
  try {
    const file = await snapshot(locations(options.env).cli, '', 0, true);
    return file.kind === 'file' && file.mode === 0o700 && file.data === Buffer.from(launcher(options)).toString('base64');
  } catch { return false; } // Never execute an unknown launcher to check its status.
}
function targets(options: SwitchOptions) {
  const paths = locations(options.env);
  return [
    { path: paths.cli, text: launcher(options), mode: 0o700, link: true },
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
    const journal = JSON.parse(utf8.decode(await readFile(path))) as Journal & { service?: { present?: unknown }; guard?: unknown };
    const invalid = () => new Error('Invalid switch recovery journal; preserve it for manual recovery.');
    if (journal.version !== 1 || typeof journal.complete !== 'boolean' || typeof journal.backup !== 'string' || dirname(journal.backup) !== join(paths.state, 'backups')) throw invalid();
    // A committed switch needs no rollback; only its record is removed.
    if (journal.complete) return journal;
    // Earlier versions also rewrote and restarted pinote.service. Restoring only
    // the files known here would leave that unit half-configured.
    if (journal.service?.present || journal.guard) throw new Error('This interrupted switch was started by an earlier Pinote that also configured pinote.service. Preserve the recovery journal and finish recovery with that version.');
    const expected = [paths.cli, paths.preference];
    if (!Array.isArray(journal.files) || journal.files.length !== 2 || new Set(journal.files.map(f => f.path)).size !== 2 || !journal.files.every(f => expected.includes(f.path) && ['missing', 'file', 'link'].includes(f.kind) && (f.kind !== 'link' || f.path === paths.cli) && typeof f.data === 'string' && f.data.length <= 2 * limit && typeof f.replacement === 'string' && f.replacement.length < 16384 && typeof f.publishIntent === 'boolean' && typeof f.stash === 'string' && dirname(f.stash) === dirname(f.path) && basename(f.stash).startsWith('.' + basename(f.path) + '.pinote-switch-') && Number.isInteger(f.mode) && f.mode >= 0 && f.mode <= 0o777 && [0o600, 0o700].includes(f.replacementMode))) throw invalid();
    return journal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
const journalPath = (env: NodeJS.ProcessEnv) => join(locations(env).state, 'pending.json');
async function rollback(env: NodeJS.ProcessEnv, journal: Journal): Promise<void> {
  const pending = journalPath(env);
  const recoveryError = (message: string, cause?: unknown) => new Error(`Automatic rollback could not finish. ${message} Keep ${pending} and its backups. No database was restored or converted.`, { cause });
  const failures: unknown[] = [];
  for (const file of [...journal.files].reverse()) { try { await restore(file); } catch (error) { failures.push(error); } }
  if (failures.length) throw recoveryError('Check for concurrent configuration changes and repair the configuration before retrying.', new AggregateError(failures));
  try {
    await atomic(join(journal.backup, 'manifest.json'), JSON.stringify({ ...journal, recovered: true }));
    await rm(pending);
  } catch (error) { throw recoveryError('Could not finalize the recovery record; check its permissions before retrying.', error); }
}
export async function recoverBackendSwitch(env: NodeJS.ProcessEnv, dependencies: SwitchDependencies = {}): Promise<void> {
  if (!await loadJournal(env)) return;
  const release = await acquire(env, dependencies.updateLock);
  try {
    const journal = await loadJournal(env); if (!journal) return;
    if (!journal.complete) await rollback(env, journal);
    else await rm(join(locations(env).state, 'pending.json'));
  } finally { release(); }
}
export async function switchToNode(options: SwitchOptions, progress: (message: string) => void, dependencies: SwitchDependencies = {}): Promise<void> {
  const { env } = options;
  verifySwitchPaths(env);
  const paths = locations(env), run = dependencies.run || runCommand;
  const release = await acquire(env, dependencies.updateLock);
  let journal: Journal | undefined;
  try {
    if (await loadJournal(env)) throw new Error('An interrupted switch needs recovery; restart Pinote before trying again.');
    progress('Checking the bundled Node runtime and existing CLI…');
    const targetVersion = await probe(options, run);
    const version = (await run(options.node, [join(options.bundles, 'cli.mjs'), '--version'], env)).trim();
    if (version !== `pinote ${targetVersion}`) throw new Error('Bundled CLI verification failed.');
    const files: SavedFile[] = [];
    for (const target of targets(options)) {
      await safeDirectory(dirname(target.path));
      files.push(await snapshot(target.path, target.text, target.mode, target.link));
    }
    if (files.some(file => file.path === paths.cli && file.kind !== 'missing')) {
      await verifyExistingCLI(options, run, paths.cli);
    }
    const backup = join(paths.state, 'backups', randomUUID()); await safeDirectory(backup, true);
    for (const file of files) {
      file.stash = join(dirname(file.path), `.${basename(file.path)}.pinote-switch-${randomUUID()}.previous`);
      file.publishIntent = false;
    }
    journal = { version: 1, complete: false, backup, files };
    await atomic(join(paths.state, 'pending.json'), JSON.stringify(journal));
    await atomic(join(backup, 'manifest.json'), JSON.stringify(journal));
    progress('Backing up configuration, SQLite and saved Electron drafts…');
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
    // Re-read every published target before committing, without executing a
    // potentially replaced launcher.
    for (const file of files) {
      const current = await snapshot(file.path, '', 0, true);
      if (current.kind !== 'file' || current.mode !== file.replacementMode || current.data !== Buffer.from(file.replacement).toString('base64')) throw conflict();
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
      await rollback(env, journal);
    }
    throw error;
  } finally { release(); }
}
