import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync, chmodSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { GuiConfig, ConfigError } from '../../src/config.ts';
import { ReminderModel, application_id } from '../../src/model.ts';
import { Store } from '../../src/store.ts';
import { discoverPaths, withDisplayLock, BusyError, type Paths } from '../../src/runtime.ts';
import { start_in_kitty, address, remote, UncertainLaunch } from '../../src/kitty.ts';
import { respond } from '../../src/bridge.ts';
let root: string, paths: Paths, model: ReminderModel, env: NodeJS.ProcessEnv;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { ...platform, value });
beforeEach(() => {
  setPlatform('linux'); // Same paths on every host; a Mac must not find its real Kitty.
  env = { ...process.env }; root = realpathSync(mkdtempSync(join(tmpdir(), 'pinote-model-')));
  process.env.HOME = join(root, 'home'); process.env.XDG_DATA_HOME = join(root, 'data'); process.env.XDG_STATE_HOME = join(root, 'state'); process.env.XDG_CONFIG_HOME = join(root, 'config');
  delete process.env.DISPLAY; delete process.env.KITTY_LISTEN_ON;
  paths = discoverPaths(); model = new ReminderModel(paths);
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); process.env = env; rmSync(root, { force: true, recursive: true }); });
const store = <T>(f: (s: Store) => T): T => { const s = new Store(paths.database); try { return f(s); } finally { s.close(); } };
const configFile = () => { const dir = join(root, 'config/pinote'); mkdirSync(dir, { recursive: true }); return join(dir, 'config.toml'); };
test('config defaults, ignored relative XDG and precise integer/boolean types', () => {
  assert.deepEqual(GuiConfig.load(), new GuiConfig()); assert.equal(existsSync(process.env.XDG_CONFIG_HOME!), false);
  const file = configFile();
  for (const contents of ['', '[gui]\n', '[other]\nx=42']) { writeFileSync(file, contents); assert.deepEqual(GuiConfig.load(), new GuiConfig()); }
  for (const limit of [1, 3, 25]) { writeFileSync(file, `[gui]\nmax_visible_notes=${limit}\nmarkdown_preview=false\n`); const config = GuiConfig.load(); assert.equal(config.max_visible_notes, BigInt(limit)); assert.equal(config.markdown_preview, false); }
  for (const value of ['0', '-1', 'true', '1.0', '1.5', '"3"', '[]', '{}']) { writeFileSync(file, `[gui]\nmax_visible_notes=${value}`); assert.throws(() => GuiConfig.load(), /max_visible_notes must be a positive integer/); }
  for (const contents of ['[gui', 'gui=3', 'gui=[]', '[gui]\nmarkdown_preview=1']) { writeFileSync(file, contents); assert.throws(() => GuiConfig.load(), ConfigError); }
  writeFileSync(file, Buffer.from([255])); assert.throws(() => GuiConfig.load(), ConfigError);
  rmSync(file); mkdirSync(file); assert.throws(() => GuiConfig.load(), ConfigError);
  process.env.XDG_CONFIG_HOME = 'relative'; const fallback = join(process.env.HOME!, '.config/pinote'); mkdirSync(fallback, { recursive: true }); writeFileSync(join(fallback, 'config.toml'), '[gui]\nmax_visible_notes=2'); assert.equal(GuiConfig.load().max_visible_notes, 2n);
});
test('model transitions compare displayed states and preserve stale history', async () => {
  const id = await model.add('task');
  assert.equal((await model.transition(id, 'done')).changed, false);
  assert.equal((await model.transition(id, 'start')).changed, true);
  assert.equal((await model.transition(id, 'done', { expected_state: 'active' })).changed, false);
  assert.equal((await model.transition(id, 'reset')).changed, true);
  assert.equal((await model.transition(id, 'done', { expected_state: 'in_progress' })).changed, false);
  assert.equal((await model.transition(id, 'done', { expected_state: 'active' })).changed, true);
  assert.deepEqual(store(s => s.history(id).map(e => e.action)), ['add', 'start', 'reset', 'done']);
  assert.equal((await model.transition(id, 'rm')).changed, false);
  assert.deepEqual(model.completed_ids(new Set([id, 999n])), new Set([id])); assert.deepEqual(model.completed_ids(new Set()), new Set());
  assert.throws(() => model.transition(id, 'restore'), /only supports/);
  assert.throws(() => model.transition(id, 'done', { expected_state: 'done' }), /not available/);
});
test('model archive stale restore, rollback and no postcommit read', async () => {
  const id = await model.add('task'); await model.transition(id, 'rm'); const note = model.archive()[0];
  assert.equal(await model.restore(note), true); assert.equal(await model.restore(note), false);
  assert.throws(() => model.restore(store(s => s.get(id))), /Only completed or removed/);
  await model.transition(id, 'rm'); const archived = model.archive()[0];
  store(s => s.connection.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'failed restore'); END"));
  await assert.rejects(() => model.restore(archived), /failed restore/); assert.deepEqual(model.archive(), [archived]);
  store(s => s.connection.exec('DROP TRIGGER fail_restore'));
  const original = Store.prototype.notes; Store.prototype.notes = () => { throw new Error('read failed'); };
  try { assert.equal(await model.restore(archived), true); assert.ok(await model.add('saved')); } finally { Store.prototype.notes = original; }
});
test('model tags sorted by latest use; folder, tag, edit and schedule routes', async () => {
  await model.create_tag('Unused'); const a = await model.add('older', { tag: 'Z' }); await sleep(2); await model.add('newer', { tag: 'A' });
  assert.deepEqual(model.tags(), ['Unused', 'Z', 'A']);
  assert.equal(await model.set_tag_folder('Z', root), true); assert.equal(model.tag_folder('Z'), root);
  assert.equal(await model.rename_tag('Z', 'Project'), true); assert.equal(await model.delete_tag('A'), true);
  let note = store(s => s.get(a)); assert.equal(await model.edit(note, 'edited'), true); note = store(s => s.get(a));
  assert.equal(await model.set_tag(note, 'Tag'), true); note = store(s => s.get(a));
  assert.equal(await model.create_tag('new', { folder: root, note }), 'new'); note = store(s => s.get(a));
  assert.equal(await model.schedule(note, '2099-01-01T00:00:00.123456+00:00'), true);
  assert.equal(model.reminders().length, 1); assert.equal(await model.release(model.reminders()[0]), true);
  assert.throws(() => model.release(store(s => s.get(a))), /Only scheduled/);
});
test('due activation uses nonblocking lock; reads do not require the lock', async () => {
  const id = await model.add('reminder'); store(s => s.schedule(id, '2099-01-01T00:00:00.000000+00:00'));
  store(s => s.connection.exec("UPDATE notes SET remind_at='2000-01-01T00:00:00.000000+00:00'"));
  await withDisplayLock(paths, false, async () => { await assert.rejects(() => model.notes(), BusyError); await assert.rejects(() => model.add('blocked'), BusyError); });
  assert.equal((await model.notes())[0].id, id); assert.equal(store(s => s.history(id).filter(e => e.action === 'remind').length), 1);
  await model.notes(); assert.equal(store(s => s.history(id).filter(e => e.action === 'remind').length), 1);
  await withDisplayLock(paths, false, async () => { assert.equal((await model.notes())[0].id, id); });
});
test('application id uses canonical database without exposing paths', () => {
  mkdirSync(paths.data, { recursive: true }); const alias = join(root, 'alias'); symlinkSync(paths.data, alias);
  const identity = application_id(paths); assert.equal(application_id({ ...paths, database: join(alias, 'notes.db') }), identity);
  assert.notEqual(application_id({ ...paths, database: join(root, 'other.db') }), identity); assert.equal(identity.includes(root), false);
});
function fakeTools() {
  const bin = join(root, 'bin'); mkdirSync(bin); const log = join(root, 'kitty.log');
  writeFileSync(join(bin, 'kitty'), `#!${process.execPath}\nconst fs = require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_KITTY_LOG,JSON.stringify(args)+'\\n');const fail=process.env.TEST_KITTY_FAIL;if(args[0]==='@'&&!args[2].startsWith(process.env.TEST_KITTY_PREFIX||'')){process.stderr.write('Error: Failed to connect to '+args[2]+' with error: connection refused\\n');process.exit(1);}if(fail==='yes'||fail&&args.includes(fail)){process.stderr.write('Error: simulated failure\\n');process.exit(1);}if(args.includes('launch'))process.stdout.write('42\\n');if(args[0]!=='@')setTimeout(()=>{},200);if(args.includes('ls')&&process.env.TEST_KITTY_DELAY_LS)setTimeout(()=>{},500);\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  process.env.PATH = bin + ':' + env.PATH; process.env.TEST_KITTY_LOG = log;
  return { bin, log, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)) };
}
test('Kitty existing address, exact launch envelope and literal argv, no shell', async () => {
  const tools = fakeTools(); process.env.KITTY_LISTEN_ON = 'unix:@explicit';
  const id = await model.add('task'), note = store(s => s.get(id));
  const title = 'current; $(touch bad)', prompt = 'say "hello"\n🌱';
  mkdirSync(join(root, 'project/sub'), { recursive: true }); symlinkSync('project/sub', join(root, 'link'));
  await start_in_kitty(`${root}/link/..`, note, title, prompt);
  const calls = tools.calls(); assert.deepEqual(calls[0], ['@', '--to', 'unix:@explicit', 'ls']);
  assert.deepEqual(calls[1].slice(0, 5), ['@', '--to', 'unix:@explicit', 'launch', '--type=tab']);
  assert.ok(calls[1].includes(`--cwd=${root}/project`));
  const launch = JSON.parse(calls[1].find((x: string) => x.startsWith('--env=PINOTE_LAUNCH_TASK=')).slice('--env=PINOTE_LAUNCH_TASK='.length));
  assert.deepEqual(launch, { task_id: Number(id), updated_at: note.updated_at, prompt });
  assert.deepEqual(calls[2].slice(3), ['set-tab-title', '--match=window_id:42', '--', title]); assert.deepEqual(calls[3].slice(3), ['focus-window', '--match=id:42']);
  process.env.TEST_KITTY_FAIL = 'yes'; await assert.rejects(() => address(join(tools.bin, 'kitty')), /remote control failed/);
  assert.equal(tools.calls().slice(4).every((a: string[]) => a[0] === '@' && a[2] === 'unix:@explicit'), true);
  await assert.rejects(() => remote(join(tools.bin, 'missing'), 'unix:@x', 'ls'), /remote control failed/);
});
// macOS file systems reject non-UTF-8 names.
test('Kitty rejects a non-UTF-8 canonical folder without launching in its U+FFFD sibling', { skip: process.platform === 'darwin' }, async () => {
  const tools = fakeTools(); process.env.KITTY_LISTEN_ON = 'unix:@explicit';
  const id = await model.add('task'), note = store(s => s.get(id));
  const target = Buffer.concat([Buffer.from(`${root}/project-`), Buffer.from([0xff])]);
  const sibling = join(root, 'project-\ufffd'), alias = join(root, 'link');
  mkdirSync(target);
  try {
    mkdirSync(sibling); symlinkSync(target, alias);
    const launch = (directory: string) => respond({ protocol: 1, operation: 'kitty', params: { id: Number(id), revision: note.updated_at, directory } }, paths);
    assert.deepEqual(await launch(alias), { protocol: 1, ok: false, error: { code: 'invalid', message: 'Choose an existing directory.' } });
    assert.equal(existsSync(tools.log), false);
    assert.equal((await launch(sibling)).ok, true);
    assert.ok(tools.calls()[1].includes(`--cwd=${sibling}`));
  } finally { rmdirSync(target); }
});
test('Kitty new-window argv and unavailable tool/directory validation', async () => {
  const tools = fakeTools(), id = await model.add('task'), note = store(s => s.get(id));
  assert.equal(await address(join(tools.bin, 'kitty')), null);
  await start_in_kitty(root, note, 'title', 'prompt'); await sleep(300);
  const calls = tools.calls(), launch = calls.find((a: string[]) => a[0] === '--session=none');
  assert.ok(launch.includes('--listen-on=unix:@mykitty-{kitty_pid}')); assert.ok(launch.includes('--override=allow_remote_control=socket-only')); assert.ok(launch.includes('/usr/bin/env')); assert.equal(launch.at(-1), join(tools.bin, 'pi'));
  await assert.rejects(() => start_in_kitty(join(root, 'absent'), note, 'title', 'prompt'));
  process.env.TEST_KITTY_FAIL = 'set-tab-title'; // Pi may have run before Kitty exited.
  await assert.rejects(() => start_in_kitty(root, note, 'title', 'prompt'), (error: Error) => error instanceof UncertainLaunch && /^Kitty exited \(0\)/.test(error.message));
  process.env.PATH = '/nonexistent'; await assert.rejects(() => start_in_kitty(root, note, 'title', 'prompt'), /cannot find kitty and pi on PATH\. PATH: \/nonexistent$/);
  process.env.PATH = '/x'.repeat(10000); await assert.rejects(() => start_in_kitty(root, note, 'title', 'prompt'), (error: Error) => error.message.length < 1200 && error.message.endsWith('…'));
});
test('Kitty on macOS finds pi in ~/.pi/agent/bin, passes PATH and reuses only private $TMPDIR sockets', async () => {
  const tools = fakeTools(), id = await model.add('task'), note = store(s => s.get(id)), agent = join(process.env.HOME!, '.pi/agent/bin');
  mkdirSync(agent, { recursive: true }); mkdirSync(join(root, 'tmp'), { mode: 0o700 }); renameSync(join(tools.bin, 'pi'), join(agent, 'pi'));
  const temp = realpathSync(join(root, 'tmp')); // The host's temporary directory may be a symlink, as on macOS.
  symlinkSync(temp, join(root, 'tmp-link')); // Sockets use the resolved, checked directory.
  process.env.PATH = tools.bin; process.env.TMPDIR = join(root, 'tmp-link/'); process.env.DISPLAY = ':0'; process.env.TEST_KITTY_PREFIX = `unix:${temp}/`;
  process.env.KITTY_LISTEN_ON = 'unix:@stale'; // An unreachable explicit address still finds the running Kitty.
  const server = createServer(); await new Promise<void>(done => server.listen(join(temp, 'mykitty-1'), done));
  setPlatform('darwin');
  try {
    await start_in_kitty(root, note, 'title', 'prompt');
    let calls = tools.calls(); assert.deepEqual(calls.slice(0, 2), [['@', '--to', 'unix:@stale', 'ls'], ['@', '--to', `unix:${temp}/mykitty-1`, 'ls']]); delete process.env.KITTY_LISTEN_ON; calls = calls.slice(1);
    assert.deepEqual(calls[1].slice(2, 5), [`unix:${temp}/mykitty-1`, 'launch', '--type=tab']); assert.deepEqual(calls[1].slice(-2), [`--env=PATH=${tools.bin}`, join(agent, 'pi')]);
    chmodSync(temp, 0o777); rmSync(tools.log); // A shared directory is neither searched nor used.
    await assert.rejects(() => start_in_kitty(root, note, 'title', 'prompt'), /needs TMPDIR to be a private directory/); assert.equal(existsSync(tools.log), false);
    chmodSync(temp, 0o700); await new Promise(done => server.close(done));
    await start_in_kitty(root, note, 'title', 'prompt'); await sleep(300);
    calls = tools.calls(); assert.equal(calls.some((a: string[]) => a[3] === 'ls'), false);
    assert.ok(calls.find((a: string[]) => a[0] === '--session=none').includes(`--listen-on=unix:${temp}/mykitty-{kitty_pid}`));
    assert.match(calls.find((a: string[]) => a[0] === '@')[2], new RegExp(`^unix:${temp}/mykitty-\\d+$`)); // Fake processes log in any order.
  } finally { server.close(); }
});
test('bridge Kitty headings, stale revisions and unknown partial launch outcomes', async () => {
  const tools = fakeTools(); process.env.KITTY_LISTEN_ON = 'unix:@explicit';
  for (const [text, tag, expected] of [['# kitty tab name\n- keep source', 'pinote', '[pinote] kitty tab name'], ['   ######\t' + 'x'.repeat(40), null, 'x'.repeat(30)], ['#hashtag', 'Tag', '[Tag] #hashtag'], ['####### literal', null, '####### literal'], ['C# issue #42', null, 'C# issue #42']] as const) {
    const id = await model.add(text, { tag }), note = store(s => s.get(id));
    const params = { id: Number(id), revision: note.updated_at, directory: root };
    const result = await respond({ protocol: 1, operation: 'kitty', params }, paths); assert.equal(result.ok, true);
    assert.equal(tools.calls().at(-2).at(-1), expected); assert.deepEqual(store(s => s.get(id)), note);
    assert.equal((await respond({ protocol: 1, operation: 'kitty', params: { ...params, revision: 'old' } }, paths)).error.code, 'conflict');
    process.env.TEST_KITTY_FAIL = 'set-tab-title'; const failed = await respond({ protocol: 1, operation: 'kitty', params }, paths); assert.equal(failed.error.code, 'unknown'); assert.match(failed.error.message, /uncertain \(Kitty remote control failed at unix:@explicit: Error: simulated failure\)\. Check the tab/); delete process.env.TEST_KITTY_FAIL;
  }
  // A configured tab name: {title} is uncut, {title:N} keeps N characters, other braces stay literal.
  const long = await model.add('# ' + 'y'.repeat(40) + '\nbody', { tag: 'os' }), longNote = store(s => s.get(long));
  for (const [tabTitle, expected] of [['{tag}{title}', '[os] ' + 'y'.repeat(40)], ['#{id} {title:5} {other}', `#${long} yyyyy {other}`], ['  {tag}  ', '[os]'], ['{title}'.repeat(32), 'y'.repeat(1024)]]) {
    const params = { id: Number(long), revision: longNote.updated_at, directory: root, tabTitle };
    assert.equal((await respond({ protocol: 1, operation: 'kitty', params }, paths)).ok, true); assert.equal(tools.calls().at(-2).at(-1), expected);
  }
  // Electron's start prompt reaches Pi's launch handoff; without one, the default is drafted.
  const handoff = () => JSON.parse(tools.calls().filter((a: string[]) => a[3] === 'launch').at(-1).find((x: string) => x.startsWith('--env=PINOTE_LAUNCH_TASK=')).slice('--env=PINOTE_LAUNCH_TASK='.length)).prompt;
  for (const prompt of ['Check scope\n🌱', '', '🌱'.repeat(4000)]) {
    assert.equal((await respond({ protocol: 1, operation: 'kitty', params: { id: Number(long), revision: longNote.updated_at, directory: root, prompt } }, paths)).ok, true); assert.equal(handoff(), prompt);
  }
  assert.equal((await respond({ protocol: 1, operation: 'kitty', params: { id: Number(long), revision: longNote.updated_at, directory: root } }, paths)).ok, true); assert.equal(handoff(), 'is task clear?');
  const launches = tools.calls().length;
  for (const prompt of ['\x1b[31m', '\u202e', '\u200e', '\u061c', '🌱'.repeat(4001), 42])
    assert.equal((await respond({ protocol: 1, operation: 'kitty', params: { id: Number(long), revision: longNote.updated_at, directory: root, prompt } }, paths)).error.code, 'invalid');
  for (const tabTitle of ['', '   ', 'a\tb', '‮{title}', 'x'.repeat(257), 42])
    assert.equal((await respond({ protocol: 1, operation: 'kitty', params: { id: Number(long), revision: longNote.updated_at, directory: root, tabTitle } }, paths)).error.code, 'invalid');
  assert.equal(tools.calls().length, launches);
  const id = await model.add('task'), note = store(s => s.get(id)); process.env.TEST_KITTY_FAIL = 'yes';
  // Nothing launches when the Kitty at the explicit address rejects the command.
  assert.deepEqual((await respond({ protocol: 1, operation: 'kitty', params: { id: Number(id), revision: note.updated_at, directory: root } }, paths)).error, { code: 'invalid', message: 'Kitty remote control failed at unix:@explicit: Error: simulated failure' });
  assert.equal(tools.calls().length, launches + 1); delete process.env.TEST_KITTY_FAIL; process.env.TEST_KITTY_PREFIX = 'unix:@mykitty-';
  // An unreachable explicit address, such as one inherited from a Kitty that has exited, falls back to a new window.
  assert.equal((await respond({ protocol: 1, operation: 'kitty', params: { id: Number(id), revision: note.updated_at, directory: root } }, paths)).ok, true); await sleep(300);
  const fallback = tools.calls().slice(launches + 1);
  assert.deepEqual(fallback[0], ['@', '--to', 'unix:@explicit', 'ls']); assert.ok(fallback.some((a: string[]) => a[0] === '--session=none')); assert.equal(fallback.some((a: string[]) => a.includes('launch')), false);
});
test('interruption preserves signal status and prevents later Kitty launch steps', async () => {
  const tools = fakeTools(); process.env.KITTY_LISTEN_ON = 'unix:@explicit'; process.env.TEST_KITTY_DELAY_LS = 'yes';
  const id = await model.add('task'), note = store(s => s.get(id));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', resolve('src/bridge-entry.ts')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
  child.stdin.end(JSON.stringify({ protocol: 1, operation: 'kitty', params: { id: Number(id), revision: note.updated_at, directory: root } }));
  const deadline = performance.now() + 5000;
  while (!existsSync(tools.log) && performance.now() < deadline) await sleep(10);
  assert.equal(existsSync(tools.log), true); child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit'); assert.equal(code, 143); assert.equal(signal, null);
  assert.equal(JSON.parse(output).error.code, 'unknown'); assert.equal(tools.calls().some((args: string[]) => args.includes('launch')), false);
});
