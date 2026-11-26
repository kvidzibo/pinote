// Basic Electron workflow on macOS: bundled backend, task list, composer and Start in Kitty
// through /Applications/kitty.app (a stand-in in CI; see ../backend/tests/desktop/kitty-stub.mjs).
// It opens windows, so it runs only on a disposable macOS session such as CI.
// Run after `npm run build`: CI=1 node tests/macos-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron } from 'playwright';

assert.equal(process.platform, 'darwin', 'This smoke test needs macOS');
assert.ok(process.env.CI, 'This test opens real windows; run it on a disposable session with CI=1');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pinote-macos-')));
const env = { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), PI_CODING_AGENT_DIR: join(root, 'pi-agent'),
  PINOTE_NOTE_COMMAND: resolve('../backend/bin/note'),
  // The bundled backend needs node and Homebrew flock; kitty and pi are found in their macOS locations.
  PATH: [dirname(process.execPath), dirname(execFileSync('which', ['flock'], { encoding: 'utf8' }).trim()), '/usr/bin', '/bin'].join(':') };
const records = join(root, 'pi'), work = join(root, 'work');
for (const directory of [...Object.values(env).filter(value => value.startsWith(root)), records, work]) mkdirSync(directory, { recursive: true, mode: 0o700 });
mkdirSync(join(env.HOME, '.pi/agent/bin'), { recursive: true });
writeFileSync(join(env.HOME, '.pi/agent/bin/pi'), `#!/bin/sh\nprintf '%s\\n%s\\n' "$PWD" "$PINOTE_LAUNCH_TASK" > '${records}/'$$\nexec /bin/sleep 600\n`, { mode: 0o700 });
const bridge = resolve('dist/pinote-backend/bridge.mjs');
const call = (operation, params) => {
  const run = spawnSync(process.execPath, [bridge], { env, input: JSON.stringify({ protocol: 1, operation, params }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); const response = JSON.parse(run.stdout); assert.ok(response.ok, run.stdout); return response.result;
};
const task = id => call('snapshot', { view: 'active' }).notes.find(note => note.id === id);
const until = async (check, message) => { for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(100); } assert.fail(message); };
const artifacts = process.env.RUNNER_TEMP || root;

const seeded = call('add', { text: 'Seeded on macOS', tag: null }).id;
const errors = [];
const app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [resolve('dist/main.cjs')], env, timeout: 20000 });
try {
  app.process().stderr.on('data', chunk => process.stderr.write(chunk));
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  await page.locator('.task-title').filter({ hasText: /^Seeded on macOS$/ }).waitFor();

  await page.getByRole('textbox', { name: 'Add a task…', exact: true }).fill('Added on macOS');
  await page.keyboard.press('Enter');
  await page.locator('.task-title').filter({ hasText: /^Added on macOS$/ }).waitFor();
  assert.equal(call('snapshot', { view: 'active' }).notes.filter(note => note.text === 'Added on macOS').length, 1);

  // The native folder dialog is supplied directly.
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, work);
  await page.getByRole('button', { name: `Actions for task ${seeded}`, exact: true }).click();
  await page.getByRole('toolbar', { name: new RegExp(`^Actions for task ${seeded}:`) }).getByRole('button', { name: 'Start in Kitty…', exact: true }).click();
  await until(() => readdirSync(records).length === 1, 'Start in Kitty did not start Pi');
  const [cwd, launch] = readFileSync(join(records, readdirSync(records)[0]), 'utf8').split('\n');
  const started = task(seeded);
  assert.equal(started.state, 'in_progress');
  assert.equal(cwd, work);
  assert.deepEqual(JSON.parse(launch), { task_id: seeded, updated_at: started.updated_at, prompt: 'is task clear?' });
  const [socket] = readdirSync(env.TMPDIR).filter(name => /^mykitty-\d+$/.test(name));
  const windows = JSON.parse(execFileSync('/Applications/kitty.app/Contents/MacOS/kitty', ['@', '--to', `unix:${join(env.TMPDIR, socket)}`, 'ls'], { encoding: 'utf8' }));
  assert.deepEqual(windows.flatMap(window => window.tabs.map(tab => tab.title)), ['Seeded on macOS']);
  await page.screenshot({ path: join(artifacts, 'electron.png') });
  spawnSync('/usr/sbin/screencapture', ['-x', join(artifacts, 'electron-screen.png')]);
  assert.deepEqual(errors, []);
} catch (error) {
  const page = await app.firstWindow();
  console.error('Window text:', await page.evaluate(() => document.body.innerText).catch(String));
  await page.screenshot({ path: join(artifacts, 'electron-failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.close();
  for (const name of readdirSync(env.TMPDIR).filter(name => /^mykitty-\d+$/.test(name))) {
    try { process.kill(Number(name.split('-')[1]), 'SIGTERM'); } catch { /* Already exited. */ }
  }
  rmSync(root, { recursive: true, force: true });
}
console.log('macOS Electron smoke passed');
