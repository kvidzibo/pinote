// Real Dunst checks, deliberately isolated from the user's desktop. The npm
// script starts the private D-Bus session: xvfb-run -a npm --prefix backend run test:desktop
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const entry = resolve(import.meta.dirname, '../../src/cli-entry.ts');
const checked = (command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 5000) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
// This probe does not auto-activate a notification daemon.
const busHasDaemon = (env: NodeJS.ProcessEnv) => checked('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
  '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.Notifications'], env).includes('boolean true');

async function desktop(t: TestContext) {
  for (const app of ['dunst', 'dunstify', 'dunstctl', 'dbus-send']) assert.equal(spawnSync('which', [app]).status, 0, `Desktop tests require ${app}`);
  assert.ok(process.env.DISPLAY && /xvfb-run\./.test(process.env.XAUTHORITY || ''), 'Desktop tests require xvfb-run');
  const address = process.env.DBUS_SESSION_BUS_ADDRESS || '';
  assert.ok(address && !address.includes('/run/user/'), 'Use npm run test:desktop for a private D-Bus session');
  // Absolute even for a relative TMPDIR: the CLI ignores relative XDG paths.
  const root = resolve(mkdtempSync(join(tmpdir(), 'pinote-dunst-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };
  delete env.WAYLAND_DISPLAY;
  assert.equal(busHasDaemon(env), false, 'Refusing to test against an existing desktop daemon');
  const config = join(root, 'dunstrc'), log = join(root, 'dunst.log');
  writeFileSync(config, '[global]\norigin=top-right\nwidth=500\nheight=600\nmarkup=full\nignore_newline=true\nhistory_length=50\n'
    + 'idle_threshold=0\n[urgency_normal]\ntimeout=1\n');
  const output = openSync(log, 'w');
  const daemon = spawn('dunst', ['-config', config], { env, stdio: ['ignore', output, output] });
  closeSync(output);
  t.after(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const exited = new Promise(done => daemon.once('exit', done));
    daemon.kill('SIGTERM');
    if (await Promise.race([exited, sleep(5000, 'timeout')]) === 'timeout') { daemon.kill('SIGKILL'); await exited; }
  });
  const deadline = Date.now() + 5000;
  while (!busHasDaemon(env)) {
    assert.equal(daemon.exitCode, null, readFileSync(log, 'utf8'));
    assert.ok(Date.now() < deadline, readFileSync(log, 'utf8'));
    await sleep(50);
  }
  const ctl = (...args: string[]) => checked('dunstctl', args, env).trim();
  const note = (...args: string[]) => {
    const stdout = checked(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', entry, ...args], env, 10000);
    assert.doesNotMatch(stdout, /WARNING|ERROR/);
    return stdout;
  };
  // Dunst history contains dismissed notifications, not currently displayed
  // ones; close ours before inspecting its delivered body and expiry.
  const closeAndRead = () => {
    ctl('close');
    assert.equal(ctl('count', 'displayed'), '0');
    return JSON.parse(ctl('history')).data[0][0];
  };
  return { ctl, note, closeAndRead };
}

test('persistent reminder is replaced, dismissed, reopened, completed and restored', async t => {
  const { ctl, note, closeAndRead } = await desktop(t);
  note('check backups <&>');
  assert.equal(ctl('count', 'displayed'), '1');
  await sleep(1200); // survives the daemon's configured one-second default timeout
  assert.equal(ctl('count', 'displayed'), '1');
  note('second reminder');
  assert.equal(ctl('count', 'displayed'), '1'); // replacement, not duplication
  const latest = closeAndRead();
  assert.equal(latest.timeout.data, 0);
  // Dunst 1.9 supports stack tags but omits them from its history JSON.
  // The replacement count/body assertions above/below apply to every version.
  if ('stack_tag' in latest) assert.equal(latest.stack_tag.data, 'pinote-reminders');
  assert.ok(latest.body.data.includes('1. check backups &lt;&amp;&gt;'));
  assert.ok(latest.body.data.includes('\u20282. second reminder'));
  assert.ok(note().includes('1. check backups <&>'));
  assert.equal(ctl('count', 'displayed'), '0'); // terminal listing does not reopen
  note('show');
  assert.equal(ctl('count', 'displayed'), '1');
  closeAndRead();
  note('third reminder'); // adding reopens a dismissed display
  assert.equal(ctl('count', 'displayed'), '1');
  note('done', '1');
  assert.equal(ctl('count', 'displayed'), '1');
  const body = closeAndRead().body.data;
  assert.ok(!body.includes('backups') && body.includes('2. second reminder'));
  note('rm', '2');
  note('done', '3');
  assert.ok(closeAndRead().body.data.includes('No active reminders'));
  note('restore', '1');
  assert.equal(ctl('count', 'displayed'), '1');
  assert.ok(closeAndRead().body.data.includes('1. check backups'));
  assert.ok(note('history', '1').includes('restore'));
});

test('literal backslashes cannot become markup', async t => {
  const { note, closeAndRead } = await desktop(t);
  const text = String.raw`literal \n \074b\076not bold\074/b\076`;
  note(text);
  const body = closeAndRead().body.data;
  assert.ok(body.includes(`1. ${text}`));
  assert.ok(!body.includes('<b>not bold</b>'));
});
