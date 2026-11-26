// Start in Kitty on macOS against /Applications/kitty.app. CI installs kitty-stub.mjs there
// because hosted runners lack the OpenGL Kitty needs. It starts Kitty instances, so it runs
// only on a disposable macOS session such as CI. Run: CI=1 npm --prefix backend run test:kitty-macos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { start_in_kitty } from '../../src/kitty.ts';
import type { Note } from '../../src/store.ts';

const kitty = '/Applications/kitty.app/Contents/MacOS/kitty';
assert.equal(process.platform, 'darwin', 'This test needs macOS');
assert.ok(process.env.CI, 'This test starts Kitty instances; run it on a disposable session with CI=1');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pinote-kitty-')));
const home = join(root, 'home'), temp = join(root, 'tmp'), records = join(root, 'pi'), folder = join(root, 'work');
for (const directory of [home, temp, records, folder]) mkdirSync(directory, { recursive: true, mode: 0o700 });
// Pi stand-in found only in ~/.pi/agent/bin: it records what Kitty started it with and stays open.
mkdirSync(join(home, '.pi/agent/bin'), { recursive: true });
writeFileSync(join(home, '.pi/agent/bin/pi'), `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$PWD" "$PINOTE_LAUNCH_TASK" "$PATH" > '${records}/'$$\nexec /bin/sleep 600\n`, { mode: 0o700 });
// Neither kitty nor pi is on PATH, as for an app opened from the Dock.
const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
Object.assign(process.env, { HOME: home, TMPDIR: temp, PATH: path });
for (const name of ['KITTY_LISTEN_ON', 'KITTY_WINDOW_ID', 'DISPLAY']) delete process.env[name];

const note = (id: number) => ({ id: BigInt(id), updated_at: `2026-01-0${id}T00:00:00+00:00` }) as Pick<Note, 'id' | 'updated_at'> as Note;
const sockets = () => readdirSync(temp).filter(name => /^mykitty-\d+$/.test(name));
const tabs = (socket: string) => (JSON.parse(execFileSync(kitty, ['@', '--to', `unix:${join(temp, socket)}`, 'ls'], { encoding: 'utf8' })) as any[])
  .map(window => window.tabs.map((tab: any) => tab.title));
async function launched(count: number) {
  for (let i = 0; i < 100 && readdirSync(records).length < count; i++) await sleep(100);
  const all = readdirSync(records).map(name => readFileSync(join(records, name), 'utf8').split('\n'));
  assert.equal(all.length, count, 'Pi did not start');
  return all.map(([cwd, launch, environment]) => ({ cwd, launch: JSON.parse(launch), path: environment }));
}
const record = async (count: number, id: number) => (await launched(count)).find(entry => entry.launch.task_id === id)!;
function capture(name: string) {
  if (process.env.RUNNER_TEMP) spawnSync('/usr/sbin/screencapture', ['-x', join(process.env.RUNNER_TEMP, `${name}.png`)]);
}
function closeAll() {
  for (const socket of sockets()) {
    try { process.kill(Number(socket.split('-')[1]), 'SIGTERM'); } catch { /* Already exited. */ }
    rmSync(join(temp, socket), { force: true });
  }
}
test.after(() => { closeAll(); rmSync(root, { recursive: true, force: true }); });

test('opens a new Kitty window, then reuses it for the next task', async () => {
  await start_in_kitty(folder, note(1), 'Pinote one', 'is task clear?');
  assert.deepEqual(await record(1, 1), { cwd: folder, launch: { task_id: 1, updated_at: note(1).updated_at, prompt: 'is task clear?' }, path });
  assert.equal(sockets().length, 1);
  await start_in_kitty(folder, note(2), 'Pinote two', 'next');
  assert.deepEqual((await record(2, 2)).launch, { task_id: 2, updated_at: note(2).updated_at, prompt: 'next' });
  assert.equal(sockets().length, 1, 'The running Kitty is reused');
  assert.deepEqual(tabs(sockets()[0]), [['Pinote one', 'Pinote two']]);
  capture('kitty-reuse');
  closeAll();
});

test('reuses a Kitty opened by Launch Services and gives Pi the caller PATH', async () => {
  rmSync(records, { recursive: true }); mkdirSync(records);
  // `open` starts Kitty through launchd, as the Dock does; whatever it passes on, Kitty's
  // PATH lacks the node directory that Pinote's PATH has.
  execFileSync('open', ['-na', dirname(dirname(dirname(kitty))), '--args', '--session=none', '-o', 'allow_remote_control=socket-only', `--listen-on=unix:${temp}/mykitty-{kitty_pid}`],
    { env: { ...process.env, PATH: '/usr/bin:/bin' } });
  for (let i = 0; i < 100 && sockets().length === 0; i++) await sleep(100);
  const opened = sockets();
  assert.equal(opened.length, 1, 'Kitty opened by Launch Services did not listen');
  await start_in_kitty(folder, note(3), 'Pinote three', 'go');
  const started = await record(1, 3);
  assert.equal(started.cwd, folder); assert.equal(started.path, path, 'Pi gets Pinote\'s PATH, not Kitty\'s');
  assert.deepEqual(sockets(), opened, 'The opened Kitty is reused');
  assert.deepEqual(tabs(opened[0])[0].slice(1), ['Pinote three'], 'A new tab beside Kitty\'s own');
  capture('kitty-launch-services');
});
