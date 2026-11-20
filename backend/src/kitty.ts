import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { NoteError, type Note } from './store.ts';
import { findExecutable, jsonStringify, checkCancelled, realpathUtf8, checkedEnv, nulFields } from './runtime.ts';
import { pythonStrip } from './compat.ts';
const exec = promisify(execFile);
export async function remote(kitty: string, address: string, ...args: string[]): Promise<string> {
  checkCancelled();
  try { return pythonStrip((await exec(kitty, ['@', '--to', address, ...args], { timeout: 5000, maxBuffer: Infinity })).stdout); }
  catch { throw new NoteError('Kitty remote control failed; check its configuration before retrying.'); }
}
export function kittyAddressEnv(): { explicit?: string; display?: string } {
  const explicit = checkedEnv('KITTY_LISTEN_ON');
  return explicit ? { explicit } : { display: checkedEnv('DISPLAY')?.replace(/\.0$/, '') };
}
export async function address(kitty: string): Promise<string | null> {
  const { explicit, display } = kittyAddressEnv();
  if (explicit) { await remote(kitty, explicit, 'ls'); return explicit; }
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
export async function start_in_kitty(directory: string, note: Note, title: string, prompt: string): Promise<void> {
  const folder = validate_directory(directory);
  const kitty = findExecutable('kitty'), pi = findExecutable('pi');
  if (!kitty || !pi) throw new NoteError('Start in Kitty requires kitty and pi on PATH.');
  const launch = jsonStringify({ task_id: note.id, updated_at: note.updated_at, prompt });
  let target = await address(kitty);
  if (target) {
    const window = await remote(kitty, target, 'launch', '--type=tab', `--cwd=${folder}`, `--env=PINOTE_LAUNCH_TASK=${launch}`, pi);
    await remote(kitty, target, 'set-tab-title', `--match=window_id:${window}`, '--', title);
    await remote(kitty, target, 'focus-window', `--match=id:${window}`); return;
  }
  checkCancelled();
  const child = spawn(kitty, ['--session=none', '--listen-on=unix:@mykitty-{kitty_pid}', '--override=allow_remote_control=socket-only', `--directory=${folder}`, `--title=${title}`, '/usr/bin/env', `PINOTE_LAUNCH_TASK=${launch}`, pi], { stdio: 'ignore', detached: true });
  let failed = false; child.on('error', () => { failed = true; }); child.unref();
  target = `unix:@mykitty-${child.pid}`;
  const deadline = performance.now() + 5000;
  while (!failed && child.exitCode === null && child.signalCode === null && performance.now() < deadline) {
    checkCancelled();
    try { await remote(kitty, target, 'set-tab-title', '--', title); return; } catch { await sleep(100); }
  }
  throw new NoteError('Kitty did not become ready. Check the new window before retrying.');
}
