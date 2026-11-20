import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, accessSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '0.26.0';
export type Paths = { data: string; state: string; database: string; log: string };
export class InputEncodingError extends Error {}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function decodeIdentity(bytes: Uint8Array, source: string): string {
  try { return utf8.decode(bytes); }
  catch { throw new InputEncodingError(`${source} is not valid UTF-8.`); }
}
export function* nulFields(bytes: Buffer): Iterable<Buffer> {
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0, start);
    if (end < 0) { yield bytes.subarray(start); break; }
    yield bytes.subarray(start, end); start = end + 1;
  }
}
// Node exposes lossy strings for inherited env entries (also in workers). Consult
// Linux's exec-time bytes only for an ambiguous, used value. Never decode or
// report other entries, and allow values supplied programmatically after exec.
export function checkedEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (env !== process.env || !value?.includes('\ufffd')) return value;
  let bytes: Buffer;
  try { bytes = readFileSync('/proc/self/environ'); }
  catch { throw new InputEncodingError(`Cannot verify the encoding of ${name}.`); }
  const key = Buffer.from(name + '=');
  for (const field of nulFields(bytes)) {
    if (!field.subarray(0, key.length).equals(key)) continue;
    const raw = field.subarray(key.length);
    if (raw.toString('utf8') === value) decodeIdentity(raw, name);
  }
  return value;
}
export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path !== '~' && !path.startsWith('~/')) return path;
  const home = (env.HOME === undefined ? checkedEnv('HOME') : checkedEnv('HOME', env))
    ?? decodeIdentity(userInfo({ encoding: 'buffer' }).homedir, 'Home directory');
  return home + path.slice(1);
}
// Reject invalid filename bytes rather than resolving to a different path containing U+FFFD.
export function realpathUtf8(path: string): string {
  return decodeIdentity(realpathSync.native(path, { encoding: 'buffer' }), 'Canonical path');
}
export function xdgPath(variable: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[variable];
  const home = value && isAbsolute(value) ? checkedEnv(variable, env)! : expandHome(`~/${fallback}`, env);
  const components = home.split('/');
  const parent = components.lastIndexOf('..');
  // Python retains '..' during I/O, so it traverses symlinks before going up.
  // Resolve through the last '..' before join() can erase it. Require that
  // prefix to be traversable, but allow a not-yet-created profile after it.
  const prefix = components.slice(0, parent + 1).join('/');
  return parent < 0 ? (isAbsolute(home) ? home : `${realpathUtf8('.')}/${home}`) : join(
    realpathUtf8(prefix + '/'), components.slice(parent + 1).join('/'),
  );
}
export function discoverPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const data = join(xdgPath('XDG_DATA_HOME', '.local/share', env), 'pinote');
  const state = join(xdgPath('XDG_STATE_HOME', '.local/state', env), 'pinote');
  return { data, state, database: join(data, 'notes.db'), log: join(state, 'app.log') };
}
export function privateDirectory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
export function privateFile(path: string): void {
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
// Match pathlib.resolve(strict=False), including symlinks preceding '..' and missing tails.
export function resolvePath(path: string): string {
  const absolute = isAbsolute(path) ? path : `${realpathUtf8('.')}/${path}`;
  let resolved = parse(absolute).root;
  let parts = absolute.slice(resolved.length).split('/'); let links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') { resolved = dirname(resolved); continue; }
    const candidate = join(resolved, part);
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        if (++links > 40) throw new Error('Too many symbolic links');
        const target = decodeIdentity(readlinkSync(candidate, { encoding: 'buffer' }), 'Symbolic link target');
        if (isAbsolute(target)) resolved = parse(target).root;
        parts = [...target.split('/'), ...parts];
      } else resolved = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      resolved = candidate;
    }
  }
  return resolved;
}
export function checkProfileIdentity(paths: Paths): void {
  // Don't create a second, unusable profile or touch logging/SQLite before
  // confirming that the database and log destinations can be identified.
  resolvePath(paths.database); resolvePath(paths.log);
}
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const paths = isAbsolute(name) ? [name] : name.includes('/') ? [] : (checkedEnv('PATH', env) || '').split(delimiter).filter(isAbsolute).map(p => join(p, name));
  return paths.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}
export function jsonStringify(value: unknown): string {
  const raw = (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON;
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? raw(item.toString()) : item);
}
export class BusyError extends Error {}
const cancellation = new AbortController();
const sharedCancellation = !isMainThread && workerData?.pinoteCancellation instanceof SharedArrayBuffer
  ? new Int32Array(workerData.pinoteCancellation) : undefined;
const abort = (code: number) => { cancellation.abort(); process.exitCode = code; };
export function installCancellation(): void {
  if (sharedCancellation) {
    parentPort!.on('message', message => { if (message === 'cancel') abort(Atomics.load(sharedCancellation, 0)); });
    parentPort!.unref();
  } else for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => abort(signal === 'SIGINT' ? 130 : 143));
}
export function checkCancelled(): void {
  if (sharedCancellation) { const code = Atomics.load(sharedCancellation, 0); if (code) abort(code); }
  cancellation.signal.throwIfAborted();
}
export async function withDisplayLock<T>(paths: Paths, blocking: boolean, action: () => Promise<T> | T): Promise<T> {
  checkCancelled();
  const flock = findExecutable('flock');
  if (!flock) throw new Error('Pinote requires util-linux flock on an absolute PATH.');
  privateDirectory(paths.data);
  const path = join(paths.data, 'display.lock'); privateFile(path);
  const fd = openSync(path, 'a');
  try {
    for (;;) {
      checkCancelled();
      // flock(2) belongs to this open file description, retained by Node after helper exit.
      // No writer supervisor and no descendant inherits the descriptor after acquisition.
      const result = spawnSync(flock, ['-x', '-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 });
      if (result.error) throw result.error;
      if (result.status === 0) break;
      if (result.status !== 75) throw new Error('Cannot acquire Pinote display lock.');
      if (!blocking) throw new BusyError('Pinote is busy. Please try again.');
      await delay(25, undefined, { signal: cancellation.signal });
    }
    // Drain any signal queued while the synchronous nonblocking flock helper ran.
    await delay(0, undefined, { signal: cancellation.signal });
    checkCancelled();
    return await action();
  } finally { closeSync(fd); }
}
let logPaths: Paths | undefined; let stderr = false;
export function configureLogging(paths: Paths, options: { stderr?: boolean } = {}): void {
  privateDirectory(paths.state); privateFile(paths.log); logPaths = paths; stderr = options.stderr ?? false;
}
export function log(level: string, message: string): void {
  const upper = level.toUpperCase();
  (stderr ? process.stderr : process.stdout).write(`${upper}: ${message}\n`);
  if (!logPaths) return;
  if (statSync(logPaths.log).size >= 1_000_000) {
    if (existsSync(`${logPaths.log}.3`)) unlinkSync(`${logPaths.log}.3`);
    for (let index = 2; index >= 1; index--) if (existsSync(`${logPaths.log}.${index}`)) renameSync(`${logPaths.log}.${index}`, `${logPaths.log}.${index + 1}`);
    renameSync(logPaths.log, `${logPaths.log}.1`); privateFile(logPaths.log);
  }
  appendFileSync(logPaths.log, `${new Date().toISOString()} ${upper} ${message}\n`, { mode: 0o600 });
}
