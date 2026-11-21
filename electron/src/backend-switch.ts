import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, openSync, accessSync, statSync } from 'node:fs';
import { access, chmod, link, lstat, stat, mkdir, open, readFile, readlink as readLinkBytes, realpath as realPathBytes, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { backendEnvironment, nodeExecutable } from './backend-command.ts';

// Only main-process values enter this installer. No renderer-supplied paths,
// executable names, service names or shell commands are accepted.
type SwitchRuntime = { node: string; bundles: string };
export type SwitchOptions = SwitchRuntime & { env: NodeJS.ProcessEnv; database: string };
type Run = (executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => Promise<string>;
type Service = { present: boolean; active: boolean; pid: number };
type SavedFile = { path: string; kind: 'missing' | 'file' | 'link'; data: string; mode: number; replacement: string; replacementMode: number; stash?: string; publishIntent?: boolean };
type DatabaseIdentity = { path: string; dev: string; ino: string };
type Journal = { version: 1; complete: boolean; backup: string; service: Service; originalDatabase?: DatabaseIdentity; originalHost?: string; originalPort?: string; guard?: SavedFile; files: SavedFile[] };
export type SwitchDependencies = { run?: Run; processEnvironment?: (pid: number) => Promise<NodeJS.ProcessEnv>; processArguments?: (pid: number) => Promise<string[]>; processExecutable?: (pid: number) => Promise<string>; processDirectory?: (pid: number) => Promise<string>; updateLock?: string; listening?: (env: NodeJS.ProcessEnv) => Promise<void>; wait?: () => Promise<void> };
const limit = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const realpath = async (path: string) => utf8.decode(await realPathBytes(path, { encoding: 'buffer' }));
const readlink = async (path: string) => utf8.decode(await readLinkBytes(path, { encoding: 'buffer' }));
const xdg = (env: NodeJS.ProcessEnv, name: string, fallback: string) => env[name] && isAbsolute(env[name]!) ? env[name]! : join(env.HOME || homedir(), fallback);
function locations(env: NodeJS.ProcessEnv) {
  verifySwitchPaths(env, ['HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']);
  const home = env.HOME || homedir();
  const serviceDropins = join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'systemd/user/pinote.service.d');
  return { home, cli: join(home, '.local/bin/note'), preference: join(xdg(env, 'XDG_CONFIG_HOME', '.config'), 'pinote/backend.json'),
    dropin: join(serviceDropins, '90-node-backend.conf'),
    guard: join(serviceDropins, '99-pinote-switch-guard.conf'),
    state: join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'pinote/backend-switch'),
    updater: join(xdg(env, 'XDG_STATE_HOME', '.local/state'), 'pi-updates') };
}
function systemHelperEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !runtimeInjection(key)));
}
export async function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string, timeout = 60000): Promise<string> {
  return new Promise((ok, fail) => {
    const childEnv = executable === '/usr/bin/systemctl' || executable === '/usr/bin/busctl' ? systemHelperEnvironment(env) : backendEnvironment(env);
    const child = execFile(executable, args, { env: childEnv, timeout, maxBuffer: limit, encoding: 'buffer' }, (error, stdout) => {
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
async function service(run: Run, env: NodeJS.ProcessEnv): Promise<Service> {
  const text = await run('/usr/bin/systemctl', ['--user', 'show', 'pinote.service', '--property=LoadState,ActiveState,MainPID', '--no-pager'], env);
  const values = Object.fromEntries(text.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (!['loaded', 'not-found'].includes(values.LoadState) || !['active', 'inactive', 'failed'].includes(values.ActiveState) || !/^\d+$/.test(values.MainPID || '')) throw new Error('The existing Pinote service is unavailable or changing state; retry when it has settled.');
  return { present: values.LoadState === 'loaded', active: values.ActiveState === 'active', pid: Number(values.MainPID) };
}
async function switchableService(run: Run, env: NodeJS.ProcessEnv): Promise<Service> {
  const current = await service(run, env);
  if (current.present && !current.active) throw new Error('The installed Pinote service is stopped. Leave it stopped; switch when it is running so its database can be verified.');
  return current;
}
async function verifyServiceContext(pid: number): Promise<void> {
  // A probe run by Electron is not evidence for a different filesystem view.
  // In particular, systemd path restrictions can hide the replacement CLI.
  for (const entry of ['ns/mnt', 'ns/user', 'ns/net', 'root']) {
    const [ours, theirs] = await Promise.all(['self', pid].map(id => stat(`/proc/${id}/${entry}`, { bigint: true })));
    if (ours.dev !== theirs.dev || ours.ino !== theirs.ino) throw new Error('Automatic switching requires the service to share the desktop filesystem and network context.');
  }
  const identities = await Promise.all(['self', pid].map(async id => (await readFile(`/proc/${id}/status`, 'utf8')).split('\n').filter(line => /^(Uid|Gid|Groups|CapEff):/.test(line)).join('\n')));
  if (identities[0] !== identities[1]) throw new Error('Automatic switching requires the service to use the same filesystem credentials as the desktop.');
}
const processArguments = async (pid: number) => utf8.decode(await readFile(`/proc/${pid}/cmdline`)).split('\0').filter(Boolean);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unitPrefix = ['--user', '--json=short', 'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1/unit/pinote_2eservice'];
async function unitProperty(run: Run, env: NodeJS.ProcessEnv, name: string, type: string): Promise<unknown> {
  const value = JSON.parse(await run('/usr/bin/busctl', [...unitPrefix, 'org.freedesktop.systemd1.Service', name], env));
  if (value.type !== type) throw new Error('Cannot read effective Pinote service configuration.');
  return value.data;
}
async function unitCommands(run: Run, env: NodeJS.ProcessEnv, name = 'ExecStartEx'): Promise<unknown[][]> {
  const entries = await unitProperty(run, env, name, 'a(sasasttttuii)');
  if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) || entry.length < 3)) throw new Error('Cannot read effective Pinote service commands.');
  return entries.map(entry => entry.slice(0, 3));
}
const directCommandError = () => new Error('Automatic switching requires the documented direct Node HTTP unit command in its project working directory, using the trusted Node runtime without wrappers or flags.');
async function verifyDirectCommand(runtime: SwitchRuntime, args: unknown, cwd: unknown): Promise<[string, string]> {
  if (!Array.isArray(args) || args.length !== 2 || args.some(arg => typeof arg !== 'string' || !isAbsolute(arg) || arg.split('/').includes('..')) ||
      typeof cwd !== 'string' || !isAbsolute(cwd) || !args[1].endsWith('/dist-mcp/mcp/http.js') ||
      await realpath(args[0]) !== await realpath(runtime.node) || await realpath(args[1]) !== await realpath(join(cwd, 'pi/dist-mcp/mcp/http.js'))) throw directCommandError();
  return [args[0], args[1]];
}
async function directUnitArguments(runtime: SwitchRuntime, env: NodeJS.ProcessEnv, run: Run): Promise<[string, string]> {
  const entries = await unitCommands(run, env), [entry] = entries;
  if (entries.length !== 1 || !Array.isArray(entry[1]) || entry[0] !== entry[1][0] || !same(entry[2], [])) throw directCommandError();
  return verifyDirectCommand(runtime, entry[1], await unitProperty(run, env, 'WorkingDirectory', 's'));
}
async function documentedServiceArguments(runtime: SwitchRuntime, pid: number, env: NodeJS.ProcessEnv, run: Run, dependencies: SwitchDependencies): Promise<[string, string]> {
  const args = await directUnitArguments(runtime, env, run);
  if (!same(args, await (dependencies.processArguments || processArguments)(pid)) ||
      await realpath(await (dependencies.processExecutable || (pid => readlink(`/proc/${pid}/exe`)))(pid)) !== await realpath(runtime.node)) throw directCommandError();
  return verifyDirectCommand(runtime, args, await (dependencies.processDirectory || (pid => readlink(`/proc/${pid}/cwd`)))(pid));
}
function runtimeInjection(name: string): boolean { return /^(LD_|NODE_|ELECTRON_|PYTHON)/.test(name) || name === 'GCONV_PATH' || name === 'GLIBC_TUNABLES'; }
export async function processEnvironment(pid: number, all = false): Promise<NodeJS.ProcessEnv> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Cannot verify the running Pinote service.');
  const raw = await readFile(`/proc/${pid}/environ`);
  if (raw.length > limit) throw new Error('Cannot verify the running Pinote service.');
  const allowed = new Set(['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PINOTE_NOTE_COMMAND', 'PINOTE_HOST', 'PINOTE_PORT', 'PINOTE_NODE', 'PINOTE_ELECTRON_BACKEND', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'KITTY_LISTEN_ON']);
  return Object.fromEntries(raw.toString('latin1').split('\0').map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }).filter(([name]) => name && (all || allowed.has(name) || runtimeInjection(name))).map(([key, value]) => [key, utf8.decode(Buffer.from(value, 'latin1'))]));
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
function databasePath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0') && resolve(path) === path;
}
function validDatabaseIdentity(value: unknown): value is DatabaseIdentity {
  if (!value || typeof value !== 'object') return false;
  const { path, dev, ino } = value as Partial<DatabaseIdentity>;
  return databasePath(path) && [dev, ino].every(part => typeof part === 'string' && /^\d{1,20}$/.test(part));
}
async function databaseIdentity(path: string): Promise<DatabaseIdentity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || await realpath(path) !== path) throw new Error('The service database is not a verifiable regular file.');
  return { path, dev: String(info.dev), ino: String(info.ino) };
}
async function probeBackend(runtime: SwitchRuntime, run: Run, env: NodeJS.ProcessEnv): Promise<{ database: string; version: string }> {
  const raw = await run(runtime.node, [join(runtime.bundles, 'bridge.mjs')], env, JSON.stringify({ protocol: 1, operation: 'handshake', params: {} }));
  const value = JSON.parse(raw);
  if (value.protocol !== 1 || value.ok !== true || !databasePath(value.result?.database) || typeof value.result?.version !== 'string') throw new Error('Cannot verify the Node backend database.');
  return value.result;
}
export class DatabaseMismatch extends Error {}
async function probe(options: SwitchOptions, run: Run, env = options.env): Promise<string> {
  const { database, version } = await probeBackend(options, run, env);
  if (database !== resolve(options.database)) throw new DatabaseMismatch('The new backend does not resolve to the same database. Check the desktop override and data directory; nothing will be switched.');
  return version;
}
export async function verifiedSwitchVersion(options: SwitchOptions, run: Run = runCommand): Promise<string> {
  const targetVersion = await probe(options, run);
  const version = (await run(options.node, [join(options.bundles, 'cli.mjs'), '--version'], options.env)).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(targetVersion) || version !== `pinote ${targetVersion}`) throw new Error('Bundled CLI verification failed.');
  return version;
}
export function verifySwitchPaths(env: NodeJS.ProcessEnv, keys = ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']): void {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error('Backend selection requires an absolute HOME independent of the working directory.');
  for (const key of keys) {
    if (env[key]?.split('/').includes('..')) throw new Error('Backend switching requires unambiguous home and XDG paths without parent-directory components.');
  }
}
type EnvironmentSource = 'desktop' | 'pinote.service';
function verifyRuntimeEnvironment(env: NodeJS.ProcessEnv, source: EnvironmentSource): void {
  // Probe desktop runtimes in the user's own library environment. The service
  // is independently verified and must not inherit the desktop's settings.
  const key = Object.keys(env).find(key => env[key] && runtimeInjection(key) && !(source === 'desktop' && key === 'LD_LIBRARY_PATH'));
  if (!key) return;
  const name = /^[A-Z0-9_]{1,80}$/.test(key) ? key : 'a custom runtime variable';
  const action = source === 'desktop' ? 'Relaunch Pinote without this setting' : 'Review the service environment and restart it without this setting';
  throw new Error(`The ${source} environment sets ${name}. ${action}, or verify the database and switch manually.`);
}
// Read-only preview. The installer repeats the checks against the actual
// environments under its lock; a settings snapshot never authorizes a switch.
export async function checkSwitchEnvironment(env: NodeJS.ProcessEnv, bundles: string, database: string, run: Run = runCommand): Promise<'absent' | 'matches' | 'different'> {
  await verifyCLIEnvironment(env, 'desktop');
  const current = await switchableService(run, env);
  let serviceEnv: NodeJS.ProcessEnv | undefined;
  if (current.active) {
    await verifyServiceContext(current.pid);
    serviceEnv = await processEnvironment(current.pid);
    verifyRuntimeEnvironment(serviceEnv, 'pinote.service');
  }
  const previous = await verifyDesktopCommand(env);
  const runtime = { bundles, node: nodeExecutable(env) };
  const cli = await lstat(locations(env).cli).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw new Error('Cannot inspect the desktop CLI launcher.');
  });
  if (cli) await inspectCLI(runtime, { ...env, PINOTE_NOTE_COMMAND: locations(env).cli }, 'desktop');
  if (previous && previous !== locations(env).cli) await inspectCLI(runtime, { ...env, PINOTE_NOTE_COMMAND: previous }, 'desktop');
  if (!serviceEnv) return 'absent';
  await inspectCLI(runtime, serviceEnv, 'pinote.service');
  const options = { ...runtime, bundles, env, database };
  const args = await verifyDirectCommand(options, await processArguments(current.pid), await readlink(`/proc/${current.pid}/cwd`));
  if (await realpath(await readlink(`/proc/${current.pid}/exe`)) !== await realpath(options.node)) throw directCommandError();
  // A documented direct unit can already name this CLI without our managed
  // drop-in. Keep it eligible for the installer's normal guarded migration.
  if (same(await unitCommands(run, env), unitCommand(args))) {
    await directUnitArguments(options, env, run);
    await requireUnitCommand(run, env, unitCommand(args));
    return 'different';
  }
  await requireUnitCommand(run, env, unitCommand(forwardedCommand(locations(env).cli, args), ['no-env-expand']));
  if (serviceEnv.PINOTE_NOTE_COMMAND !== locations(env).cli || !await hasInstalledLauncher(options)) throw new Error('The service is already managed by Pinote, but its CLI configuration has changed. Restore the installed launcher and service configuration before switching.');
  // Both environments must resolve the running desktop database before offering
  // to remove a diagnostic desktop override: service agreement alone is insufficient.
  await probe(options, run, env);
  await probe(options, run, serviceEnv);
  return 'matches';
}
async function verifyCLIEnvironment(env: NodeJS.ProcessEnv, source: EnvironmentSource = 'pinote.service'): Promise<void> {
  verifySwitchPaths(env);
  verifyRuntimeEnvironment(env, source);
  if (!env.PATH || env.PATH.split(':').some(path => !isAbsolute(path) || path.split('/').includes('..'))) throw new Error(`Automatic switching requires an unambiguous absolute ${source} PATH.`);
  try {
    if (await realpath(executable(env, 'flock')) === await realpath('/usr/bin/flock')) return;
  } catch { /* Missing or unresolvable flock is also unsafe. */ }
  throw new Error(`Automatic switching requires the system flock on the ${source} PATH.`);
}
// Predict where a bare 'note' will resolve after publication, including a
// currently missing launcher. Never replace a different command on PATH.
async function verifyDesktopCommand(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const target = locations(env).cli;
  let reachedTarget = false;
  for (const dir of (env.PATH || '').split(':')) {
    const candidate = join(dir, 'note');
    if (candidate === target) reachedTarget = true;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        if (reachedTarget) return candidate;
        break;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    }
  }
  if (reachedTarget) return undefined; // No previous command; installation will create it.
  throw new Error('The desktop PATH must select ~/.local/bin/note. Put ~/.local/bin before other note installations and relaunch Pinote.');
}
const nodeEntry = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning\nconst [major, minor] = process.versions.node.split('.').map(Number);\nif (major < 22 || major === 22 && minor < 19) {\n  console.error('Pinote requires Node.js 22.19.0 or newer.'); process.exitCode = 1;\n} else {\n  await import('../dist/cli.mjs');\n}\n";
// Inspection recognizes the entire launcher without running it. Only the installer
// invokes the returned database probe, after confirmation.
async function inspectCLI(runtime: SwitchRuntime, env: NodeJS.ProcessEnv, source: EnvironmentSource): Promise<(run: Run) => Promise<string>> {
  await verifyCLIEnvironment(env, source);
  const command = env.PINOTE_NOTE_COMMAND || 'note';
  if (command !== 'note' && (!isAbsolute(command) || command.split('/').includes('..'))) throw new Error(`The ${source} CLI must be an unambiguous absolute executable.`);
  let path: string, text: string;
  try {
    path = await realpath(command === 'note' ? executable(env, 'note') : command);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 8192) throw new Error();
      const buf = Buffer.alloc(info.size + 1);
      if ((await file.read(buf)).bytesRead !== info.size) throw new Error();
      text = utf8.decode(buf.subarray(0, info.size));
    } finally { await file.close(); }
  } catch { throw new Error(`Cannot safely read the ${source} CLI launcher.`); }
  if (text === nodeEntry && await realpath(executable(env, 'node')) !== await realpath(runtime.node)) throw new Error(`The ${source} CLI PATH selects a different Node runtime; automatic switching was blocked.`);
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
    return async run => {
      const database = JSON.parse(await run(interpreter, ['-c', code, path], env));
      if (!databasePath(database)) throw new Error('Cannot verify the Python CLI database.');
      return database;
    };
  }
  if (text === nodeEntry) {
    return async run => (await probeBackend({ ...runtime, bundles: resolve(dirname(path), '../dist') }, run, env)).database;
  }
  if (text === launcher(runtime)) return async run => (await probeBackend(runtime, run, env)).database;
  // Never execute an arbitrary wrapper to discover its database: even a read
  // command may activate reminders or hide an XDG override inside the script.
  throw new Error(`The ${source} uses a custom CLI wrapper. Automatic database verification is unavailable; keep it unchanged and review that wrapper before switching.`);
}
async function existingCLIDatabase(runtime: SwitchRuntime, run: Run, env: NodeJS.ProcessEnv, source: EnvironmentSource = 'pinote.service'): Promise<string> {
  const discover = await inspectCLI(runtime, env, source);
  return discover(run);
}
async function verifyExistingCLI(options: SwitchOptions, run: Run, env: NodeJS.ProcessEnv, source: EnvironmentSource = 'pinote.service'): Promise<string> {
  const database = await existingCLIDatabase(options, run, env, source);
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
    if (file.kind !== 'file' || file.mode !== 0o700 || file.data !== Buffer.from(launcher(options)).toString('base64')) return false;
    if (await verifyDesktopCommand(options.env) !== file.path) throw new Error('The installed Node launcher is not executable on the desktop PATH. Check its filesystem mount options.');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } // Never execute a launcher to inspect it.
}
function systemdQuote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Unsupported service command path.');
  return JSON.stringify(value.replaceAll('%', '%%'));
}
function targets(options: SwitchOptions, serviceArguments: string[] | undefined) {
  const paths = locations(options.env);
  const command = paths.cli.replaceAll('%', '%%');
  if (/[\r\n\0]/.test(command)) throw new Error('Unsupported CLI installation path.');
  return [
    { path: paths.cli, text: launcher(options), mode: 0o700, link: true },
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
        const child = spawn('/usr/bin/flock', ['-n', '-E', '75', '3'], { env: systemHelperEnvironment(env), timeout: 5000, stdio: ['ignore', 'ignore', 'ignore', fd] });
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
    const journal = JSON.parse(utf8.decode(await readFile(path))) as Journal;
    const expected = [paths.cli, paths.dropin, paths.preference];
    if (journal.version !== 1 || typeof journal.complete !== 'boolean' || !journal.service || typeof journal.service.active !== 'boolean' || typeof journal.service.present !== 'boolean' || !Array.isArray(journal.files) || ![2, 3].includes(journal.files.length) || new Set(journal.files.map(f => f.path)).size !== journal.files.length || !journal.files.every(f => expected.includes(f.path) && ['missing', 'file', 'link'].includes(f.kind) && (f.kind !== 'link' || f.path === paths.cli) && typeof f.data === 'string' && f.data.length <= 2 * limit && typeof f.replacement === 'string' && f.replacement.length < 16384 && typeof f.publishIntent === 'boolean' && typeof f.stash === 'string' && dirname(f.stash) === dirname(f.path) && basename(f.stash).startsWith('.' + basename(f.path) + '.pinote-switch-') && Number.isInteger(f.mode) && f.mode >= 0 && f.mode <= 0o777 && [0o600, 0o700].includes(f.replacementMode)) || typeof journal.backup !== 'string' || dirname(journal.backup) !== join(paths.state, 'backups')) throw new Error('Invalid switch recovery journal; preserve it for manual recovery.');
    const guard = journal.guard;
    if (guard !== undefined && (!guard || guard.path !== paths.guard || guard.kind !== 'missing' || guard.data !== '' || guard.mode !== 0 ||
        guard.publishIntent !== true || typeof guard.replacement !== 'string' || guard.replacement.length >= 16384 || guard.replacementMode !== 0o600)) {
      throw new Error('Invalid service guard recovery record; preserve it for manual recovery.');
    }
    return journal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
// ExecStartPre is not sufficient: systemd can read EnvironmentFile again for
// ExecStart. The temporary ExecStart checks and then execs HTTP with the same
// environment, cwd, credentials and PID, without returning to systemd.
const guardDeadline = 8000;
const guardScript = 'switch-guard.mjs';
// These can load code before the guard sees process.env. Hide them only in the
// temporary unit; never edit the owner's Environment/EnvironmentFile settings.
const guardUnset = ['LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'GCONV_PATH', 'GLIBC_TUNABLES', 'NODE_OPTIONS'];
type GuardCheck = { database: DatabaseIdentity; node: string; host?: string; port?: string; cli?: string };
export async function execGuardedService(bundles: string): Promise<void> {
  const deadline = setTimeout(() => { console.error('Pinote database guard timed out; HTTP not started.'); process.exit(1); }, guardDeadline);
  try {
    const [script, input] = process.argv.slice(2);
    const check = JSON.parse(input) as GuardCheck;
    if (process.argv.length !== 4 || !validDatabaseIdentity(check.database) || !process.execve) throw new Error();
    const runtime = { node: check.node, bundles };
    const env = await processEnvironment(process.pid, true);
    await verifyCLIEnvironment(env);
    const args = await verifyDirectCommand(runtime, [process.argv0, script], process.cwd());
    if (env.PINOTE_HOST !== check.host || env.PINOTE_PORT !== check.port) throw new Error();
    if (check.cli !== undefined) {
      const file = await snapshot(check.cli, '', 0);
      if (file.kind !== 'file' || file.mode !== 0o700 || file.data !== Buffer.from(launcher(runtime)).toString('base64')) throw new Error();
      env.PINOTE_NOTE_COMMAND = check.cli;
    }
    const path = await existingCLIDatabase(runtime, (file, args, env, input) => runCommand(file, args, env, input, 5000), env);
    // Measure the DB discovered by the probe, not a path selected by the journal.
    if (path !== check.database.path) throw new Error();
    const actual = await databaseIdentity(path);
    if (actual.dev !== check.database.dev || actual.ino !== check.database.ino) throw new Error();
    process.execve(args[0], args, env);
  } finally { clearTimeout(deadline); }
}
const controlService = (run: Run, env: NodeJS.ProcessEnv, action: string) => run('/usr/bin/systemctl', action === 'daemon-reload' ? ['--user', action] : ['--user', action, 'pinote.service'], env);
const journalPath = (env: NodeJS.ProcessEnv) => join(locations(env).state, 'pending.json');
const saveJournal = (env: NodeJS.ProcessEnv, journal: Journal) => atomic(journalPath(env), JSON.stringify(journal));
async function removeGuard(journal: Journal): Promise<void> {
  if (!journal.guard) return;
  const directory = dirname(journal.guard.path);
  // Do not follow a newly redirected drop-in directory during recovery.
  const parent = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return; throw error; });
  if (parent) {
    if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o002) || await realpath(directory) !== resolve(directory)) throw conflict();
    await restore(journal.guard);
  }
  delete journal.guard;
}
const forwardedCommand = (cli: string, args: string[]) => ['/usr/bin/env', `PINOTE_NOTE_COMMAND=${cli}`, ...args];
const unitCommand = (args: string[], flags: string[] = []) => [[args[0], args, flags]];
async function requireUnitCommand(run: Run, env: NodeJS.ProcessEnv, expected: unknown): Promise<void> {
  // Other start hooks are outside the documented unit and could run before
  // the guard or in a launch environment it didn't check.
  for (const property of ['ExecConditionEx', 'ExecStartPreEx', 'ExecStartPostEx']) {
    if ((await unitCommands(run, env, property)).length) throw new Error('Automatic switching does not support custom Pinote service start hooks.');
  }
  if (!same(await unitCommands(run, env), expected)) throw new Error('The effective Pinote service command does not match the expected configuration.');
}
async function startGuarded(env: NodeJS.ProcessEnv, journal: Journal, runtime: SwitchRuntime, args: [string, string], dependencies: SwitchDependencies, cli?: string): Promise<void> {
  if (!validDatabaseIdentity(journal.originalDatabase)) throw new Error('The original service database identity is missing or invalid.');
  const run = dependencies.run || runCommand, control = (action: string) => controlService(run, env, action);
  const wait = dependencies.wait || (() => delay(250));
  const baseline = cli === undefined ? unitCommand(args) : unitCommand(forwardedCommand(cli, args), ['no-env-expand']);
  await requireUnitCommand(run, env, baseline);
  const script = join(runtime.bundles, guardScript);
  await access(script, constants.R_OK);
  const check: GuardCheck = { database: journal.originalDatabase, node: runtime.node, host: journal.originalHost, port: journal.originalPort, cli };
  const command = [args[0], '--', script, args[1], JSON.stringify(check)];
  const text = `[Service]\nExecStart=\nExecStart=:${command.map(systemdQuote).join(' ')}\nRestart=no\nUnsetEnvironment=${guardUnset.join(' ')}\n`;
  const path = locations(env).guard;
  await safeDirectory(dirname(path));
  const guard = await snapshot(path, text, 0o600);
  if (guard.kind !== 'missing' || journal.guard || text.length >= 16384) throw conflict();
  journal.guard = guard;
  try { await install(guard, () => saveJournal(env, journal)); }
  catch (error) { if (!guard.publishIntent) delete journal.guard; throw error; }
  await control('daemon-reload');
  const unset = await unitProperty(run, env, 'UnsetEnvironment', 'as');
  if (await unitProperty(run, env, 'Restart', 's') !== 'no' || !same(await unitProperty(run, env, 'RestartForceExitStatus', '(aiai)'), [[], []]) ||
      !Array.isArray(unset) || !guardUnset.every(name => unset.includes(name))) {
    throw new Error('Cannot verify the effective Pinote service guard environment.');
  }
  const before = await service(run, env);
  if (!before.present || before.active) throw new Error('Pinote service is missing or already running; refusing an unverified restart.');
  await requireUnitCommand(run, env, unitCommand(command, ['no-env-expand']));
  await control('start');

  // Type=simple can report active while the guard is still probing. Require
  // its exec into the checked command and the real listener before cleanup.
  let pid = 0, ready = 0;
  const needed = cli === undefined ? 1 : 5;
  for (let attempt = 0; ready < needed; attempt++) {
    if (attempt >= 48) throw new Error('The guarded Pinote service did not become ready.');
    await wait();
    const after = await service(run, env);
    if (!after.active || !after.pid || (pid && after.pid !== pid)) throw new Error('The guarded Pinote service did not restart.');
    pid = after.pid;
    if (!same(await (dependencies.processArguments || processArguments)(pid), args)) continue;
    await verifyServiceContext(pid);
    const actual = await (dependencies.processEnvironment || processEnvironment)(pid);
    await verifyCLIEnvironment(actual);
    if (actual.PINOTE_HOST !== journal.originalHost || actual.PINOTE_PORT !== journal.originalPort || (cli !== undefined && actual.PINOTE_NOTE_COMMAND !== cli)) throw new Error('The service environment changed during restart.');
    try { await (dependencies.listening || listening)(actual); ready++; }
    catch { ready = 0; }
  }
  await removeGuard(journal);
  await control('daemon-reload');
  await requireUnitCommand(run, env, baseline);
  const verified = await service(run, env);
  if (!verified.active || verified.pid !== pid) throw new Error('The service changed during guard cleanup.');
}
async function rollback(env: NodeJS.ProcessEnv, journal: Journal, dependencies: SwitchDependencies, trustedRuntime?: () => SwitchRuntime): Promise<void> {
  const run = dependencies.run || runCommand;
  const control = (action: string) => controlService(run, env, action);
  const pending = journalPath(env);
  const recoveryError = (message: string, cause?: unknown) => new Error(`Automatic rollback could not finish. ${message} Keep ${pending} and its backups. No database was restored or converted.`, { cause });
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
  if (journal.service.present) {
    try { await control('stop'); }
    catch (error) { throw recoveryError('Could not stop pinote.service; stop it manually before retrying recovery.', error); }
    await attempt(() => removeGuard(journal));
  }
  for (const file of [...journal.files].reverse()) await attempt(() => restore(file));
  if (journal.service.present) await attempt(() => control('daemon-reload'));
  if (failures.length) throw recoveryError('Check for concurrent configuration changes and repair the configuration before retrying. The Pinote service was not restarted.', new AggregateError(failures));
  if (journal.service.active) {
    // Old pending journals have no pre-switch evidence. Do not infer it from
    // the current unit, the desktop profile, or the now-restored files.
    let reason = 'The original service database identity is missing or invalid; verify the profile manually before starting pinote.service.';
    try {
      if (!validDatabaseIdentity(journal.originalDatabase)) throw new Error(reason);
      reason = 'Cannot verify the restored service database without the trusted Node runtime and bundles. Check the Electron installation before retrying recovery.';
      const runtime = trustedRuntime?.();
      if (!runtime) throw new Error(reason);
      reason = 'Cannot verify the restored service database or listener. Check the unit, EnvironmentFile, and CLI profile before retrying recovery.';
      const args = await directUnitArguments(runtime, env, run);
      await startGuarded(env, journal, runtime, args, dependencies);
    } catch (error) {
      try { await control('stop'); }
      catch (stopError) { throw recoveryError(`${reason} Could not stop pinote.service; stop it manually.`, new AggregateError([error, stopError])); }
      throw recoveryError(`${reason} Pinote service was stopped.`, error);
    }
  }
  try {
    await atomic(join(journal.backup, 'manifest.json'), JSON.stringify({ ...journal, recovered: true }));
    await rm(pending);
  } catch (error) { throw recoveryError('Could not finalize the recovery record; check its permissions before retrying.', error); }
}
export async function recoverBackendSwitch(env: NodeJS.ProcessEnv, trustedRuntime?: () => SwitchRuntime, dependencies: SwitchDependencies = {}): Promise<void> {
  if (!await loadJournal(env)) return;
  const release = await acquire(env, dependencies.updateLock);
  try {
    const journal = await loadJournal(env); if (!journal) return;
    if (journal.complete) await rm(join(locations(env).state, 'pending.json'));
    else {
      if (journal.service.active) await verifyCLIEnvironment(env, 'desktop');
      await rollback(env, journal, dependencies, trustedRuntime);
    }
  } finally { release(); }
}
export async function switchToNode(options: SwitchOptions, progress: (message: string) => void, dependencies: SwitchDependencies = {}): Promise<void> {
  const { env } = options;
  verifyRuntimeEnvironment(env, 'desktop');
  verifySwitchPaths(env);
  const paths = locations(env), run = dependencies.run || runCommand;
  const release = await acquire(env, dependencies.updateLock);
  let journal: Journal | undefined;
  try {
    await verifyCLIEnvironment(env, 'desktop');
    if (await loadJournal(env)) throw new Error('An interrupted switch needs recovery; restart Pinote before trying again.');
    progress('Checking the bundled Node runtime and existing service…');
    const desktopDatabase = await databaseIdentity(options.database);
    const version = await verifiedSwitchVersion(options, run);
    const before = await switchableService(run, env);
    let serviceArguments: [string, string] | undefined, originalHost: string | undefined, originalPort: string | undefined;
    let originalDatabase: DatabaseIdentity | undefined;
    if (before.active) {
      await verifyServiceContext(before.pid);
      await access('/usr/bin/env', constants.X_OK);
      serviceArguments = await documentedServiceArguments(options, before.pid, env, run, dependencies);
      await requireUnitCommand(run, env, unitCommand(serviceArguments));
      if ((await snapshot(paths.guard, '', 0)).kind !== 'missing') throw conflict();
      await access(join(options.bundles, guardScript), constants.R_OK);
      const serviceEnv = await (dependencies.processEnvironment || processEnvironment)(before.pid);
      originalHost = serviceEnv.PINOTE_HOST; originalPort = serviceEnv.PINOTE_PORT;
      originalDatabase = await databaseIdentity(await verifyExistingCLI(options, run, serviceEnv));
      if (!same(originalDatabase, desktopDatabase)) throw new Error('The service database no longer matches the desktop database.');
      await (dependencies.listening || listening)(serviceEnv);
    }
    const files: SavedFile[] = [];
    for (const target of targets(options, serviceArguments)) {
      await safeDirectory(dirname(target.path));
      files.push(await snapshot(target.path, target.text, target.mode, target.link));
    }
    const previous = await verifyDesktopCommand(env);
    if (previous && previous !== paths.cli) await verifyExistingCLI(options, run, { ...env, PINOTE_NOTE_COMMAND: previous }, 'desktop');
    // This launcher is independently user-facing; the service may use another CLI.
    if (files.some(file => file.path === paths.cli && file.kind !== 'missing')) {
      await verifyExistingCLI(options, run, { ...env, PINOTE_NOTE_COMMAND: paths.cli }, 'desktop');
    }
    const backup = join(paths.state, 'backups', randomUUID()); await safeDirectory(backup, true);
    for (const file of files) {
      file.stash = join(dirname(file.path), `.${basename(file.path)}.pinote-switch-${randomUUID()}.previous`);
      file.publishIntent = false;
    }
    journal = { version: 1, complete: false, backup, service: before, originalDatabase, originalHost, originalPort, files };
    await atomic(join(paths.state, 'pending.json'), JSON.stringify(journal));
    await atomic(join(backup, 'manifest.json'), JSON.stringify(journal));
    progress('Backing up configuration, SQLite and saved Electron drafts…');
    if (before.active) await controlService(run, env, 'stop');
    // SQLite's online backup API keeps a concurrent CLI writer from producing a
    // torn copy. The source is read-only; journal mode and schema are unchanged.
    await run(options.node, ['--input-type=module', '-e', "import{DatabaseSync,backup}from'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});try{await backup(db,process.argv[2]);}finally{db.close()}", options.database, join(backup, 'notes.db')], env);
    await chmod(join(backup, 'notes.db'), 0o600);
    for (const name of ['state.json', 'window.json']) {
      try { const data = await readFile(join(dirname(options.database), 'electron', name)); await writeFile(join(backup, name), data, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    progress('Installing the CLI and selecting the Node backend…');
    if (await verifyDesktopCommand(env) !== previous) throw conflict();
    if (previous && previous !== paths.cli) await verifyExistingCLI(options, run, { ...env, PINOTE_NOTE_COMMAND: previous }, 'desktop');
    for (const file of files) {
      if (!await originalMatches(file)) throw new Error('Configuration changed during preparation; nothing will be overwritten.');
      await install(file, () => atomic(join(paths.state, 'pending.json'), JSON.stringify(journal)));
    }
    if ((await run(paths.cli, ['--version'], env)).trim() !== version) throw new Error('Installed CLI verification failed.');
    await probe(options, run, await preferredBackendEnvironment(env));
    if (serviceArguments) {
      progress('Restarting and verifying the existing Pinote service…');
      await controlService(run, env, 'daemon-reload');
      await startGuarded(env, journal, options, serviceArguments, dependencies, paths.cli);
    }
    if (await verifyDesktopCommand(env) !== paths.cli) throw new Error('The installed launcher was not selected by the desktop PATH.');
    const currentDatabase = await databaseIdentity(options.database);
    if (!same(currentDatabase, desktopDatabase) || (originalDatabase && !same(currentDatabase, originalDatabase))) throw new Error('The database was replaced during the switch.');
    // Restart and readiness probes take time. Re-read every published target
    // before committing, without executing a potentially replaced launcher.
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
      await rollback(env, journal, dependencies, () => options);
    }
    throw error;
  } finally { release(); }
}
