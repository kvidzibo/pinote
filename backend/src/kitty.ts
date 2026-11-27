import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { NoteError, type Note } from './store.ts';
import { findExecutable, jsonStringify, checkCancelled, realpathUtf8, checkedEnv, nulFields, expandHome } from './runtime.ts';
import { strip } from './compat.ts';
const exec = promisify(execFile);
const macos = () => process.platform === 'darwin';
// Kitty resolves relative `listen_on unix:` paths in its temporary directory.
const temporary = () => (checkedEnv('TMPDIR') || '/tmp').replace(/(.)\/+$/, '$1');
// A launch request may have reached Kitty, so a tab or window can exist.
export class UncertainLaunch extends Error {}
// Keep diagnostics printable and well below Electron's 16 KiB error-message limit.
const shown = (text: string, limit = 300) => {
  const characters = Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, ''));
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('');
};
function reason(error: any): string {
  if (error?.killed) return 'no response within 5 s';
  const line = String(error?.stderr ?? '').split('\n').map(text => shown(text).trim()).find(Boolean);
  return line || (error?.signal ? `terminated by ${error.signal}` : typeof error?.code === 'number' ? `exit status ${error.code}` : shown(String(error?.code ?? error?.message ?? 'unknown error')));
}
export async function remote(kitty: string, address: string, ...args: string[]): Promise<string> {
  checkCancelled();
  try { return strip((await exec(kitty, ['@', '--to', address, ...args], { timeout: 5000, maxBuffer: Infinity })).stdout); }
  catch (error) { throw new NoteError(`Kitty remote control failed at ${shown(address)}: ${reason(error)}`); }
}
export function kittyAddressEnv(): { explicit?: string; display?: string } {
  const explicit = checkedEnv('KITTY_LISTEN_ON');
  // macOS Kitty does not use X11; XQuartz's DISPLAY does not identify it.
  return explicit ? { explicit } : macos() ? {} : { display: checkedEnv('DISPLAY')?.replace(/\.0$/, '') };
}
// macOS has no /proc or abstract sockets, so Kitty sockets live in $TMPDIR. Only a
// private directory guarantees that a socket path still belongs to this user when the
// task is sent; macOS gives each user one. Shared directories such as /tmp are refused.
function privateTemporary(): string | undefined {
  try {
    // Resolve symlinks and `..` once so Kitty listens in the directory checked here.
    const directory = realpathUtf8(temporary()), stat = statSync(directory);
    if (stat.isDirectory() && stat.uid === process.getuid!() && !(stat.mode & 0o022)) return directory;
  } catch { /* Missing directory or unverifiable TMPDIR. */ }
  return undefined;
}
// Find `listen_on unix:mykitty` sockets, which Kitty suffixes with -<pid>.
function macosSockets(): string[] {
  const directory = privateTemporary(), sockets: [number, string][] = [];
  if (!directory) return [];
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { /* Unreadable directory. */ }
  for (const name of names) {
    const pid = /^mykitty-(\d+)$/.exec(name)?.[1], path = join(directory, name);
    try { const socket = lstatSync(path); if (pid && socket.isSocket() && socket.uid === process.getuid!()) sockets.push([Number(pid), `unix:${path}`]); }
    catch { /* Removed while listing. */ }
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
      if (statSync(`/proc/${pid}`).uid !== process.getuid!() || strip(readFileSync(`/proc/${pid}/comm`, 'utf8')) !== 'kitty') continue;
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
// Tab name for Start in Kitty: {tag} is "[tag] " when tagged, {id} the task number,
// {title} the first line without a Markdown heading marker; {title:N} keeps its first N characters.
export const DEFAULT_TAB_TITLE = '{tag}{title:30}';
export function validate_tab_title(template: string): void {
  if (!strip(template) || Array.from(template).length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(template))
    throw new NoteError('The Kitty tab name must be one line of at most 256 characters without control characters.');
}
// Start in Kitty's draft for an empty Pi editor; empty disables it.
export const DEFAULT_START_PROMPT = 'is task clear?';
export function validate_start_prompt(prompt: string): void {
  if (Array.from(prompt).length > 4000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Bidi_Control}]/u.test(prompt))
    throw new NoteError('The Kitty start prompt must be at most 4000 characters without control characters (except tabs/newlines).');
}
export function tab_title(note: Note, template = DEFAULT_TAB_TITLE): string {
  const summary = Array.from(note.text.split(/[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)[0].replace(/^ {0,3}#{1,6}[ \t]+/, ''));
  // Repeated placeholders can expand far beyond a useful name; stay well within one process argument.
  return strip(Array.from(template.replace(/\{tag\}|\{id\}|\{title(?::([1-9]\d{0,3}))?\}/g, (match, limit?: string) =>
    match === '{tag}' ? (note.tag ? `[${note.tag}] ` : '') : match === '{id}' ? String(note.id) : summary.slice(0, limit ? Number(limit) : undefined).join(''))).slice(0, 1024).join(''));
}
export async function start_in_kitty(directory: string, note: Note, title: string, prompt: string): Promise<void> {
  const folder = validate_directory(directory);
  const kitty = locate('kitty'), pi = locate('pi');
  if (!kitty || !pi) {
    const missing = [kitty ? '' : 'kitty', pi ? '' : 'pi'].filter(Boolean).join(' and ');
    throw new NoteError(`Start in Kitty cannot find ${missing} on PATH${macos() ? ' or in the usual macOS locations' : ''}. PATH: ${shown(checkedEnv('PATH') || '(empty)', 1000)}`);
  }
  const launch = jsonStringify({ task_id: note.id, updated_at: note.updated_at, prompt });
  // A Dock-launched macOS Kitty gives tabs launchd's minimal PATH, where pi cannot find node.
  const path = checkedEnv('PATH'), env = macos() && path ? [`--env=PATH=${path}`] : [];
  let target = await address(kitty);
  if (target) {
    try {
      const window = await remote(kitty, target, 'launch', '--type=tab', `--cwd=${folder}`, `--env=PINOTE_LAUNCH_TASK=${launch}`, ...env, pi);
      await remote(kitty, target, 'set-tab-title', `--match=window_id:${window}`, '--', title);
      await remote(kitty, target, 'focus-window', `--match=id:${window}`); return;
    } catch (error) { throw error instanceof NoteError ? new UncertainLaunch(error.message) : error; }
  }
  checkCancelled();
  let socket = '@mykitty-';
  if (macos()) {
    const directory = privateTemporary();
    if (!directory) throw new NoteError('Start in Kitty on macOS needs TMPDIR to be a private directory owned by you.');
    socket = join(directory, 'mykitty-');
  }
  const child = spawn(kitty, ['--session=none', `--listen-on=unix:${socket}{kitty_pid}`, '--override=allow_remote_control=socket-only', `--directory=${folder}`, `--title=${title}`, '/usr/bin/env', `PINOTE_LAUNCH_TASK=${launch}`, pi], { stdio: 'ignore', detached: true });
  let failed: NodeJS.ErrnoException | undefined; child.on('error', error => { failed = error; }); child.unref();
  target = `unix:${socket}${child.pid}`;
  const deadline = performance.now() + 5000; let last = '';
  while (!failed && child.exitCode === null && child.signalCode === null && performance.now() < deadline) {
    checkCancelled();
    try { await remote(kitty, target, 'set-tab-title', '--', title); return; } catch (error) { last = (error as Error).message; await sleep(100); }
  }
  if (failed) throw new NoteError(`Cannot start ${shown(kitty)}: ${shown(failed.code ?? failed.message)}`);
  // Pi may already have run in a window that has since closed.
  if (child.exitCode !== null || child.signalCode !== null) throw new UncertainLaunch(`Kitty exited (${child.exitCode ?? child.signalCode}) before accepting remote control at ${shown(target)}`);
  throw new UncertainLaunch(`Kitty did not accept remote control within 5 s; ${last}`);
}
