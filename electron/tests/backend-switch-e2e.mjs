import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openSync, closeSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { _electron } from 'playwright';
assert.match(process.env.XAUTHORITY || '', /xvfb-run\./);
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'));
// Both display-size lanes share the real updater lock protocol. Serialize this
// focused scenario, not production locks from unrelated unit-test fixtures.
const lockRoot = join(tmpdir(), `pinote-switch-ui-tests-${process.getuid()}`);
await mkdir(lockRoot, { recursive: true, mode: 0o700 });
const lock = openSync(join(lockRoot, 'run.lock'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
assert.equal(spawnSync('/usr/bin/flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock], timeout: 20000 }).status, 0);
const root = await mkdtemp(join(tmpdir(), 'pinote-switch-ui-'));
const env = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'runtime'), PATH: `${root}/bin:${dirname(process.execPath)}:/usr/bin:/bin`, PINOTE_NODE: process.execPath, PINOTE_ELECTRON_BACKEND: join(root, 'python-backend'), NO_AT_BRIDGE: '1' };
for (const key of ['WAYLAND_DISPLAY', 'I3SOCK', 'ELECTRON_RUN_AS_NODE']) delete env[key];
for (const path of ['bin', 'data', 'state', 'config', 'cache', 'runtime', '.local/bin']) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
await writeFile(join(root, 'bin/systemctl'), '#!/bin/sh\nprintf "LoadState=not-found\\nActiveState=inactive\\nMainPID=0\\n"\n', { mode: 0o700 });
const marker = join(root, 'python-calls');
await writeFile(env.PINOTE_ELECTRON_BACKEND, `#!/bin/sh\nprintf x >> '${marker}'\nexec '${resolve('../.venv/bin/pinote-electron-backend')}'\n`, { mode: 0o700 });
const old = join(root, 'legacy-note'); await writeFile(old, '#!/bin/sh\necho legacy\n', { mode: 0o700 });
await symlink(old, join(root, '.local/bin/note'));
const seed = spawnSync(process.execPath, [resolve('../backend/dist/cli.mjs'), '--no-notify', 'Existing task survives switch'], { env, encoding: 'utf8' }); assert.equal(seed.status, 0, seed.stderr);
const config = join(root, 'i3.conf');
await writeFile(config, `font pango:monospace 9\nipc-socket ${root}/i3.sock\nfor_window [window_type="utility"] floating enable, border none\n`);
const wm = spawn('i3', ['-a', '-c', config], { env, stdio: 'ignore' });
let app;
const launch = async () => {
  app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [resolve('dist/main.cjs')], env, chromiumSandbox: true, timeout: 20000 });
  app.process().stderr.on('data', () => {});
  const page = await app.firstWindow();
  await page.locator('.task-title').filter({ hasText: 'Existing task survives switch' }).waitFor();
  await app.evaluate(({ Menu }) => {
    const popup = Menu.prototype.popup;
    Menu.prototype.popup = function(options) { globalThis.__switchMenu = this; return popup.call(this, options); };
  });
  return page;
};
const settings = async page => {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    const menu = globalThis.__switchMenu, item = menu.getMenuItemById('backend-settings');
    item.click(item, BrowserWindow.getAllWindows()[0], {}); menu.closePopup();
  });
  await page.getByRole('dialog', { name: 'Backend settings', exact: true }).waitFor();
};
try {
  for (let i = 0; i < 100; i++) { if (spawnSync('i3-msg', ['-s', join(root, 'i3.sock'), '-t', 'get_tree'], { env, stdio: 'ignore' }).status === 0) break; await new Promise(ok => setTimeout(ok, 20)); }
  let page = await launch();
  await page.getByRole('textbox', { name: 'Add a task…', exact: true }).fill('Draft kept across backend switch');
  await settings(page);
  await page.getByRole('button', { name: 'Switch to Node backend', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Switch to Node backend"]').disabled);
  await page.screenshot({ path: join(root, 'backend-settings.png') });
  const before = await readFile(join(root, '.local/bin/note'), 'utf8');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  await page.getByRole('button', { name: 'Switch to Node backend', exact: true }).click();
  assert.equal(await readFile(join(root, '.local/bin/note'), 'utf8'), before, 'Cancellation has no install effects');
  // Prevent an unmanaged relaunch in the test; reopen via Playwright below.
  await app.evaluate(({ app, dialog }) => { app.relaunch = () => {}; dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const closed = app.waitForEvent('close', { timeout: 20000 });
  await page.getByRole('button', { name: 'Switch to Node backend', exact: true }).click();
  await closed;
  const calls = await readFile(marker, 'utf8');
  const cli = spawnSync(join(root, '.local/bin/note'), ['--version'], { env, encoding: 'utf8' }); assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /^pinote 0\.26\.0/);
  const backupRoot = join(root, 'state/pinote/backend-switch/backups');
  assert.equal((await readdir(backupRoot)).length, 1);
  page = await launch();
  await page.getByRole('textbox', { name: 'Add a task…', exact: true }).waitFor();
  assert.match(await page.locator('#draft').innerText(), /Draft kept across backend switch/);
  await settings(page);
  await page.getByText(/already switched/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Switch to Node backend', exact: true }).isDisabled(), true);
  assert.equal(await readFile(marker, 'utf8'), calls, 'The saved Node choice bypasses the old launcher override after relaunch');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(280, 560));
  await page.waitForTimeout(250);
  assert.ok(await page.getByRole('dialog', { name: 'Backend settings' }).evaluate(node => node.scrollWidth <= node.clientWidth), 'Narrow settings must not clip horizontally');
  await page.screenshot({ path: join(root, 'backend-switched-narrow.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Backend settings' }).waitFor({ state: 'detached' });
  console.log(`Backend-switch UI artifacts: ${root}`);
} catch (error) { console.error(`Backend-switch failure artifacts: ${root}`); throw error; }
finally { await app?.close().catch(() => {}); wm.kill('SIGTERM'); closeSync(lock); }
