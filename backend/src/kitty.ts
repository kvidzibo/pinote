import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { NoteError, type Note } from './store.ts';
import { findExecutable, jsonStringify, checkCancelled, realpathUtf8, checkedEnv, nulFields, expandHome } from './runtime.ts';
import { pythonStrip } from './compat.ts';
const exec = promisify(execFile);
const macos = () => process.platform === 'darwin';
// Kitty resolves relative `listen_on unix:` paths in its temporary directory.
const temporary = () => (checkedEnv('TMPDIR') || '/tmp').replace(/(.)\/+$/, '$1');
// A launch request may have reached Kitty, so a tab or window can exist.
export class UncertainLaunch extends Error {}
function reason(error: any): string {
  if (error?.killed || error?.signal) return 'no response within 5 s';
  const line = String(error?.stderr ?? '').split('\n').map(text => text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).find(Boolean);
  return line ? line.slice(0, 300) : typeof error?.code === 'number' ? `exit status ${error.code}` : String(error?.code ?? error?.message ?? 'unknown error');
}
export async function remote(kitty: string, address: string, ...args: string[]): Promise<string> {
  checkCancelled();
  try { return pythonStrip((await exec(kitty, ['@', '--to', address, ...args], { timeout: 5000, maxBuffer: Infinity })).stdout); }
  catch (error) { throw new NoteError(`Kitty remote control failed at ${address}: ${reason(error)}`); }
}
export function kittyAddressEnv(): { explicit?: string; display?: string } {
  const explicit = checkedEnv('KITTY_LISTEN_ON');
  // macOS Kitty does not use X11; XQuartz's DISPLAY does not identify it.
  return explicit ? { explicit } : macos() ? {} : { display: checkedEnv('DISPLAY')?.replace(/\.0$/, '') };
}
// macOS has no /proc or abstract sockets: find same-user `listen_on unix:/tmp/mykitty`
// or `unix:mykitty` (in $TMPDIR) sockets, which Kitty suffixes with -<pid>.
function macosSockets(): string[] {
  const sockets: [number, string][] = [];
  for (const directory of new Set([temporary(), '/tmp'])) {
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { /* Missing or unreadable directory. */ }
    for (const name of names) {
      const pid = /^mykitty-(\d+)$/.exec(name)?.[1], path = join(directory, name);
      try { const stat = lstatSync(path); if (pid && stat.isSocket() && stat.uid === process.getuid!()) sockets.push([Number(pid), `unix:${path}`]); }
      catch { /* Removed while listing. */ }
    }
  }
  return sockets.sort(([a], [b]) => a - b).map(([, target]) => target);
}
export async function address(kitty: string): Promise<string | null> {
  const { explicit, display } = kittyAddressEnv();
  if (explicit) { await remote(kitty, explicit, 'ls'); return explicit; }
  if (macos()) {
    for (const target of macosSockets()) {
      try { await remote(kitty, target, 'ls'); return target; } catch { /* Stale or unavailable instance. */ }
    }
    return null;
  }
  if (!display) return null;
  const matches = [Buffer.from('DISPLAY=' + display), Buffer.from('DISPLAY=' + display + '.0')];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid!() || pythonStrip(readFileSync(`/proc/${pid}/comm`, 'utf8')) !== 'kitty') continue;
      const fields = nulFields(readFileSync(`/proc/${pid}/environ`));
      if (!Array.from(fields).some(field => matches.some(value => value.equals(field)))) continue;
      const target = `unix:@mykitty-${pid}`; await remote(kitty, target, 'ls'); return target;
    } catch { /* inaccessible or unavailable instance */ }
  }
  return null;
}
export function validate_directory(directory: string): string {
  try {
    const folder = realpathUtf8(directory);
    if (statSync(folder).isDirectory()) return folder;
  } catch { /* Invalid, inaccessible or missing directory. */ }
  throw new NoteError('Choose an existing directory.');
}
// Apps opened from the macOS Dock or Finder inherit a minimal PATH.
function locate(name: 'kitty' | 'pi'): string | undefined {
  const found = findExecutable(name);
  if (found || !macos()) return found;
  const home = expandHome('~');
  const directories = name === 'kitty' ? ['/Applications/kitty.app/Contents/MacOS', `${home}/Applications/kitty.app/Contents/MacOS`] : [`${home}/.pi/agent/bin`];
  return [...directories, '/opt/homebrew/bin', '/usr/local/bin'].map(directory => findExecutable(join(directory, name))).find(Boolean);
}
export async function start_in_kitty(directory: string, note: Note, title: string, prompt: string): Promise<void> {
  const folder = validate_directory(directory);
  const kitty = locate('kitty'), pi = locate('pi');
  if (!kitty || !pi) {
    const missing = [kitty ? '' : 'kitty', pi ? '' : 'pi'].filter(Boolean).join(' and ');
    throw new NoteError(`Start in Kitty cannot find ${missing} on PATH${macos() ? ' or in the usual macOS locations' : ''}. PATH: ${checkedEnv('PATH') || '(empty)'}`);
  }
  const launch = jsonStringify({ task_id: note.id, updated_at: note.updated_at, prompt });
  let target = await address(kitty);
  if (target) {
    try {
      const window = await remote(kitty, target, 'launch', '--type=tab', `--cwd=${folder}`, `--env=PINOTE_LAUNCH_TASK=${launch}`, pi);
      await remote(kitty, target, 'set-tab-title', `--match=window_id:${window}`, '--', title);
      await remote(kitty, target, 'focus-window', `--match=id:${window}`); return;
    } catch (error) { throw error instanceof NoteError ? new UncertainLaunch(error.message) : error; }
  }
  checkCancelled();
  const socket = macos() ? join(temporary(), 'mykitty-') : '@mykitty-';
  const child = spawn(kitty, ['--session=none', `--listen-on=unix:${socket}{kitty_pid}`, '--override=allow_remote_control=socket-only', `--directory=${folder}`, `--title=${title}`, '/usr/bin/env', `PINOTE_LAUNCH_TASK=${launch}`, pi], { stdio: 'ignore', detached: true });
  let failed: NodeJS.ErrnoException | undefined; child.on('error', error => { failed = error; }); child.unref();
  target = `unix:${socket}${child.pid}`;
  const deadline = performance.now() + 5000; let last = '';
  while (!failed && child.exitCode === null && child.signalCode === null && performance.now() < deadline) {
    checkCancelled();
    try { await remote(kitty, target, 'set-tab-title', '--', title); return; } catch (error) { last = (error as Error).message; await sleep(100); }
  }
  if (failed) throw new NoteError(`Cannot start ${kitty}: ${failed.code ?? failed.message}`);
  if (child.exitCode !== null || child.signalCode !== null) throw new NoteError(`Kitty exited (${child.exitCode ?? child.signalCode}) before accepting remote control at ${target}.`);
  throw new UncertainLaunch(`Kitty did not accept remote control within 5 s; ${last}`);
}
