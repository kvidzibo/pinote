import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readlinkSync, renameSync, statSync, unlinkSync, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '0.26.0';
export type Paths = { data: string; state: string; database: string; log: string };
export function xdgPath(variable: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[variable] && isAbsolute(env[variable]!) ? env[variable]! : join(env.HOME || homedir(), fallback);
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
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
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
        const target = readlinkSync(candidate);
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
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const paths = isAbsolute(name) ? [name] : name.includes('/') ? [] : (env.PATH || '').split(delimiter).filter(isAbsolute).map(p => join(p, name));
  return paths.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}
export function jsonStringify(value: unknown): string {
  const raw = (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON;
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? raw(item.toString()) : item);
}
export class BusyError extends Error {}
const cancellation = new AbortController();
export function installCancellation(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    cancellation.abort(); process.exitCode = signal === 'SIGINT' ? 130 : 143;
  });
}
export function checkCancelled(): void { cancellation.signal.throwIfAborted(); }
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
