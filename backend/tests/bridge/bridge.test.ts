import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { decode, validate, respond, MAX_REQUEST } from '../../src/bridge.ts';
import { Store } from '../../src/store.ts';
import { discoverPaths, withDisplayLock, jsonStringify, type Paths } from '../../src/runtime.ts';
let root: string, paths: Paths, saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env }; root = realpathSync(mkdtempSync(join(tmpdir(), 'pinote-bridge-')));
  for (const [name, folder] of Object.entries({ HOME: 'home', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime' })) process.env[name] = join(root, folder);
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'KITTY_LISTEN_ON', 'I3SOCK']) delete process.env[name];
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent-bridge-test'; paths = discoverPaths();
});
afterEach(() => { process.env = saved; rmSync(root, { recursive: true, force: true }); });
const request = (operation: string, params: any = {}) => ({ protocol: 1, operation, params });
async function call(op: string, params: any = {}): Promise<any> { const r = await respond(request(op, params), paths); assert.equal(r.ok, true, jsonStringify(r)); return r.result; }
function target(id: bigint): any { const s = new Store(paths.database); try { return { id: Number(id), revision: s.get(id).updated_at }; } finally { s.close(); } }
const bridgeCommand = [process.execPath, '--disable-warning=ExperimentalWarning', '--experimental-strip-types', resolve('src/bridge-entry.ts')] as const;
function processRequest(data: Buffer | string, args: string[] = []) {
  const [node, ...flags] = bridgeCommand;
  return spawnSync(node, [...flags, ...args], { input: data, env: process.env, encoding: 'utf8', timeout: 10000 });
}
test('handshake, help and version are side-effect free', async () => {
  const r = processRequest(JSON.stringify(request('handshake'))); assert.equal(r.status, 0); assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), { protocol: 1, ok: true, result: { version: '0.32.0', protocol: 1, database: paths.database } });
  for (const flag of ['--help', '--version']) assert.equal(processRequest('', [flag]).status, 0);
  assert.equal(existsSync(paths.data), false); assert.equal(existsSync(paths.state), false);
  assert.equal((await respond(request('handshake'), paths)).ok, true);
});
test('symlink/.. in XDG_DATA_HOME resolves through the filesystem and honours a display lock held elsewhere', () => {
  mkdirSync(join(root, 'actual', 'nested'), { recursive: true });
  symlinkSync('actual/nested', join(root, 'link'));
  process.env.XDG_DATA_HOME = `${root}/link/../profile`;
  const expected = join(root, 'actual', 'profile', 'pinote', 'notes.db');
  const handshake = processRequest(JSON.stringify(request('handshake')));
  assert.equal(handshake.status, 0, handshake.stderr);
  assert.equal(JSON.parse(handshake.stdout).result.database, expected);
  assert.equal(existsSync(join(root, 'actual', 'profile')), false);
  assert.equal(existsSync(paths.state), false);

  // Another process holds display.lock in the physical directory.
  mkdirSync(dirname(expected), { recursive: true, mode: 0o700 });
  const holder = `const {DatabaseSync}=require('node:sqlite');const {spawnSync}=require('node:child_process');new DatabaseSync(${JSON.stringify(join(dirname(expected), 'display.lock'))}).exec('BEGIN EXCLUSIVE');const r=spawnSync(${JSON.stringify(bridgeCommand[0])},${JSON.stringify(bridgeCommand.slice(1))},{input:require('node:fs').readFileSync(0),encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status;`;
  const locked = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', holder],
    { input: JSON.stringify(request('add', { text: 'blocked', tag: null })), env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(locked.status, 0, locked.stderr);
  assert.equal(JSON.parse(locked.stdout).error.code, 'busy');
  assert.equal(existsSync(expected), false);

  const added = processRequest(JSON.stringify(request('add', { text: 'shared note', tag: null })));
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).ok, true);
  const shared = new DatabaseSync(expected, { readOnly: true });
  try { assert.equal(shared.prepare('SELECT text FROM notes WHERE id = 1').get()!.text, 'shared note'); } finally { shared.close(); }
  assert.equal(existsSync(join(root, 'profile')), false);
});
test('untraversable XDG_DATA_HOME parent step fails without opening a different profile', () => {
  symlinkSync('missing/nested', join(root, 'link'));
  process.env.XDG_DATA_HOME = `${root}/link/../profile`;
  for (const value of [request('handshake'), request('add', { text: 'must not save', tag: null })]) {
    const response = processRequest(JSON.stringify(value));
    assert.equal(response.status, 0, response.stderr);
    const body = JSON.parse(response.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
  }
  for (const dir of [join(root, 'profile'), join(root, 'missing'), paths.state]) assert.equal(existsSync(dir), false);
});
test('strict JSON rejects malformed UTF8, duplicate decoded keys, floats, unsafe numeric tokens, nesting and oversize without side effects', () => {
  const bad = ['', '{}{}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}', '{"x":1.0}', '{"x":1e0}', '{"protocol":1,"protoc\\u006fl":1}', '['.repeat(18) + ']'.repeat(18), '['.repeat(1100) + ']'.repeat(1100), ' '.repeat(MAX_REQUEST + 1), '\ufeff{}'];
  for (const data of [...bad.map(x => Buffer.from(x)), Buffer.from([255]), Buffer.from([0xc0, 0xaf])]) {
    assert.throws(() => decode(data)); const r = processRequest(data); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).error.code, 'invalid');
    assert.equal(existsSync(paths.data), false); assert.equal(existsSync(paths.state), false);
  }
  for (const data of ['{"protocol":1.0,"operation":"handshake","params":{}}', '{"protocol":1e0,"operation":"handshake","params":{}}', '{"protocol":9007199254740993,"operation":"handshake","params":{}}']) assert.throws(() => validate(decode(Buffer.from(data))));
  assert.deepEqual((decode(Buffer.from('{"__proto__":{"x":1}}')) as any).__proto__, Object.assign(Object.create(null), { x: 1 }));
});
test('exact fields, primitives and read-only domain validation', async () => {
  const bad = [{}, request('handshake', { extra: true }), { ...request('handshake'), protocol: true }, request('get', { id: 1 }), request('snapshot', { view: 'all' }), request('add', { text: 1, tag: null }), request('add', { text: 'a', tag: false }), request('edit', { id: true, revision: 'x', text: 'a' }), request('edit', { id: 2 ** 53, revision: 'x', text: 'a' }), request('edit', { id: 1, revision: '', text: 'a' }), request('edit', { id: 1, revision: 'x', text: '\ud800' }), request('create_tag', { name: 'a', folder: null, id: 1 }), request('transition', { id: 1, revision: 'x', state: 'done', action: 'start' }), request('completions', { ids: [false] }), request('completions', { ids: Array(1001).fill(1) }), request('add', { text: ' ', tag: null }), request('create_tag', { name: ' ', folder: null }), request('kitty', { id: 1, revision: 'x', directory: join(root, 'missing') }), request('kitty', { id: 1, revision: 'x', directory: '\0' }), request('schedule', { id: 1, revision: 'x', when: '2000-01-01T00:00:00Z' }), request('tag_folder', { name: '', folder: null }), request('tag_folder', { name: 'invalid\nname', folder: null })];
  for (const r of bad) { assert.equal((await respond(r, paths)).error.code, 'invalid'); assert.equal(existsSync(paths.data), false); assert.equal(existsSync(paths.state), false); }
  const r = processRequest(JSON.stringify(request('add', { text: ' ', tag: null }))); assert.equal(JSON.parse(r.stdout).error.code, 'invalid'); assert.equal(existsSync(paths.state), false);
});
test('all routes, canonical tags, revision acknowledgements, schedules and metadata', async () => {
  assert.equal((await call('create_tag', { name: ' Work ', folder: root })).tag, 'Work');
  assert.equal((await call('snapshot', { view: 'active' })).tags[0].available, true);
  const id = (await call('add', { text: '你好 🌱\nsecond line', tag: 'work' })).id;
  const first = target(id);
  const edited = await call('edit', { ...first, text: 'task edited' }); assert.equal(edited.changed, true); assert.notEqual(edited.revision, first.revision);
  assert.equal((await call('edit', { id: Number(id), revision: edited.revision, text: 'task edited' })).changed, false);
  assert.equal((await call('tag', { ...target(id), tag: null })).changed, true);
  const attached = await call('create_tag', { ...target(id), name: 'WORK', folder: root }); assert.equal(attached.tag, 'Work'); assert.equal(attached.revision, target(id).revision);
  // folderIfNew is created and saved only for a tag the call inserts; an existing (case-folded) tag keeps its folder.
  const fresh = join(root, 'Fresh'), loop = join(root, 'loop'); writeFileSync(join(root, 'Blocked'), ''); symlinkSync(loop, loop);
  await call('tag_folder', { name: 'Work', folder: null }); await call('create_tag', { name: 'WORK', folder: null, folderIfNew: loop }); // never touched for an existing tag
  await call('create_tag', { ...target(id), name: 'Fresh', folder: null, folderIfNew: fresh });
  assert.match((await respond(request('create_tag', { name: 'Blocked', folder: null, folderIfNew: join(root, 'Blocked') }), paths)).error.message, /exists but is not a folder/);
  symlinkSync(join(root, 'outside'), join(root, 'Dangling'));
  assert.match((await respond(request('create_tag', { name: 'Dangling', folder: null, folderIfNew: join(root, 'Dangling') }), paths)).error.message, /exists but is not a folder/);
  assert.equal(existsSync(join(root, 'outside')), false);
  assert.deepEqual((await call('snapshot', { view: 'active' })).tags.filter((t: { name: string }) => ['Work', 'Fresh', 'Blocked', 'Dangling'].includes(t.name)).map((t: { name: string; folder: string | null }) => [t.name, t.folder]).sort(), [['Fresh', fresh], ['Work', null]]);
  assert.equal(statSync(fresh).isDirectory(), true);
  await call('tag', { ...target(id), tag: 'Work' }); await call('tag_folder', { name: 'Work', folder: root }); await call('delete_tag', { name: 'Fresh' });
  for (const [op, params] of [['rename_tag', { name: 'Work', newName: 'Project' }], ['tag_folder', { name: 'Project', folder: null }], ['delete_tag', { name: 'Project' }]] as const) assert.equal((await call(op, params)).changed, true);
  for (const [action, state] of [['start', 'active'], ['reset', 'in_progress'], ['done', 'active']]) assert.equal((await call('transition', { ...target(id), action, state })).changed, true);
  assert.deepEqual(await call('completions', { ids: [Number(id), 9999] }), [id]);
  assert.ok((await call('snapshot', { view: 'archive' })).notes[0].archived_at);
  for (const [action, state] of [['restore', 'done'], ['rm', 'active'], ['restore', 'removed']]) assert.equal((await call('transition', { ...target(id), action, state })).changed, true);
  assert.equal((await call('schedule', { ...target(id), when: '2099-01-01T00:00:00.123456Z' })).changed, true);
  assert.deepEqual((await call('snapshot', { view: 'active' })).notes, []);
  assert.equal((await call('snapshot', { view: 'scheduled' })).notes[0].remind_at, '2099-01-01T00:00:00.123456+00:00');
  await call('transition', { ...target(id), action: 'restore', state: 'scheduled' }); assert.deepEqual(await call('completions', { ids: [Number(id)] }), []);
});
test('agent sets and removes handoff fields against the task revision', async () => {
  const id = (await call('add', { text: 'task', tag: null })).id, first = target(id);
  const set = await call('agent', { ...first, fields: { PRs: 'https://example.test/pulls/1\nhttps://example.test/pulls/2', Worktree: '/tmp/work' } });
  assert.equal(set.changed, true); assert.notEqual(set.revision, first.revision); assert.ok(set.agentEvent > 0);
  assert.equal((await respond(request('agent', { ...first, fields: { Worktree: '/tmp/stale' } }), paths)).error.code, 'conflict');
  for (const fields of [{ Worktree: 1 }, { Worktree: ' ' }, { ' ': 'value' }, [], 'x', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, null]))]) assert.equal((await respond(request('agent', { id: Number(id), revision: set.revision, fields }), paths)).error.code, 'invalid');
  const same = await call('agent', { id: Number(id), revision: set.revision, fields: { Worktree: '/tmp/work' } });
  assert.deepEqual([same.changed, same.revision, same.agentEvent], [false, set.revision, set.agentEvent]);
  const removed = await call('agent', { id: Number(id), revision: set.revision, fields: { Worktree: null, Notes: 'kept' } });
  assert.ok(removed.agentEvent > set.agentEvent);
  assert.deepEqual({ ...(await call('snapshot', { view: 'active' })).notes[0].agent_notes }, { Notes: 'kept', PRs: 'https://example.test/pulls/1\nhttps://example.test/pulls/2' });
  // A list is saved and returned as a JSON array.
  const listed = await call('agent', { id: Number(id), revision: removed.revision, fields: { PRs: ['https://example.test/pulls/1', 'https://example.test/pulls/2'] } });
  assert.equal(listed.changed, true);
  assert.deepEqual((await call('snapshot', { view: 'active' })).notes[0].agent_notes.PRs, ['https://example.test/pulls/1', 'https://example.test/pulls/2']);
  for (const fields of [{ PRs: [] }, { PRs: ['a\nb'] }, { PRs: [1] }, { PRs: [null] }, { PRs: Array(257).fill('x') }]) assert.equal((await respond(request('agent', { id: Number(id), revision: listed.revision, fields }), paths)).error.code, 'invalid');
});
test('stale writes preserve history and create no tags; display and SQLite busy', async () => {
  const id = (await call('add', { text: 'task', tag: null })).id, old = target(id);
  await call('edit', { ...old, text: 'new' });
  const s = new Store(paths.database);
  try {
    const before = s.history();
    for (const [op, p] of [['edit', { text: 'bad' }], ['tag', { tag: 'bad' }], ['schedule', { when: '2099-01-01T00:00:00Z' }], ['transition', { state: 'active', action: 'done' }], ['create_tag', { name: 'bad', folder: null }]] as const) assert.equal((await respond(request(op, { ...old, ...p }), paths)).error.code, 'conflict');
    assert.deepEqual(s.history(), before); assert.deepEqual(s.tags(), []);
    await withDisplayLock(paths, false, async () => { assert.equal((await respond(request('add', { text: 'blocked', tag: null }), paths)).error.code, 'busy'); });
    s.connection.exec('BEGIN IMMEDIATE');
    try { assert.equal((await respond(request('add', { text: 'blocked', tag: null }), paths)).error.code, 'busy'); } finally { s.connection.exec('ROLLBACK'); }
    assert.equal(s.notes().length, 1);
  } finally { s.close(); }
});
test('no postcommit reads, exact revisions even after an external writer', async () => {
  const originalGet = Store.prototype.get, originalNotes = Store.prototype.notes;
  Store.prototype.get = () => { throw new Error('read failed'); }; Store.prototype.notes = () => { throw new Error('read failed'); };
  let id: bigint;
  try {
    id = (await call('add', { text: 'task', tag: null })).id;
    const s = new Store(paths.database); let revision: string; try { revision = s.row('SELECT updated_at FROM notes')!.updated_at; } finally { s.close(); }
    const r = await call('create_tag', { id: Number(id), revision, name: 'Tag', folder: null });
    await call('transition', { id: Number(id), revision: r.revision, state: 'active', action: 'start' });
    assert.equal((await respond(request('snapshot', { view: 'active' }), paths)).error.code, 'internal');
  } finally { Store.prototype.get = originalGet; Store.prototype.notes = originalNotes; }
  const original = Store.prototype.edit_with_revision;
  let committed: string = '';
  Store.prototype.edit_with_revision = function (...args) { const result = original.apply(this, args); committed = result[1]; const external = new Store(paths.database); try { original.call(external, args[0], 'external', { expected_updated_at: result[1] }); } finally { external.close(); } return result; };
  try { const r = await call('edit', { ...target(id!), text: 'final' }); assert.equal(r.revision, committed); assert.notEqual(r.revision, target(id!).revision); }
  finally { Store.prototype.edit_with_revision = original; }
});
test('subprocess unicode framing, private logging, redacted conflicts', () => {
  const added = processRequest(JSON.stringify(request('add', { text: '你好 🌱\nsecond line', tag: 'é' })));
  assert.equal(added.status, 0); assert.equal(added.stdout.trim().split('\n').length, 1); const id = JSON.parse(added.stdout).result.id;
  const snap = JSON.parse(processRequest(JSON.stringify(request('snapshot', { view: 'active' }))).stdout); assert.equal(snap.result.notes[0].text, '你好 🌱\nsecond line');
  const stale = processRequest(JSON.stringify(request('edit', { id, revision: 'old', text: 'SECRET' })));
  assert.equal(JSON.parse(stale.stdout).error.code, 'conflict'); assert.equal(stale.stderr.includes('SECRET'), false); assert.equal(readFileSync(paths.log, 'utf8').includes('SECRET'), false); assert.equal(statSync(paths.log).mode & 0o777, 0o600);
});
test('stats reports task states, images, history and file sizes without writing', async () => {
  const missing = processRequest(JSON.stringify(request('stats')));
  assert.equal(JSON.parse(missing.stdout).ok, false); assert.deepEqual([existsSync(paths.database), existsSync(paths.log)], [false, false]);
  const s = new Store(paths.database);
  try {
    const [, progress, scheduled, done, removed] = ['a', 'b', 'c', 'd', 'e'].map(text => s.add(text));
    s.transition(progress, 'start'); s.schedule(scheduled, '2999-01-01T00:00:00.000000+00:00'); s.transition(done, 'done'); s.transition(removed, 'rm');
  } finally { s.close(); }
  const before = await call('stats');
  assert.deepEqual(before.tasks, { active: 1, in_progress: 1, scheduled: 1, done: 1, removed: 1 });
  assert.deepEqual([before.images, before.events, before.log], [{ count: 0, bytes: 0 }, 9, { path: paths.log, bytes: null }]);
  assert.equal(before.database.path, paths.database); assert.ok(before.database.bytes > 0);
  assert.equal(before.database.modified, new Date(statSync(paths.database).mtimeMs).toISOString());
  assert.deepEqual(JSON.parse(processRequest(JSON.stringify(request('stats'))).stdout).result.log, before.log); assert.equal(existsSync(paths.log), false);
  const image = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0])]);
  await call('image_add', { data: image.toString('base64') });
  const after = await call('stats');
  assert.deepEqual(after.images, { count: 1, bytes: image.length }); assert.deepEqual(after.tasks, before.tasks); assert.equal(after.events, 9);
});
test('bad config and unsupported database IDs return bounded errors', async () => {
  const dir = join(process.env.XDG_CONFIG_HOME!, 'pinote'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'config.toml'), '[gui]\nmarkdown_preview=42\n');
  assert.equal((await respond(request('snapshot', { view: 'active' }), paths)).error.code, 'invalid');
  rmSync(dir, { recursive: true }); const s = new Store(paths.database);
  try { s.add('large'); s.connection.exec('DELETE FROM events; UPDATE notes SET id=9007199254740992'); } finally { s.close(); }
  assert.equal((await respond(request('snapshot', { view: 'active' }), paths)).error.code, 'internal');
});
test('snapshots match the reference for schema8 metadata, config and ordering', async () => {
  // A frozen database and its expected snapshots; see fixtures/reference/README.md.
  const reference = (name: string) => readFileSync(new URL('../fixtures/reference/' + name, import.meta.url), 'utf8');
  const config = join(process.env.XDG_CONFIG_HOME!, 'pinote'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'config.toml'), '[gui]\nmax_visible_notes=4\nmarkdown_preview=false');
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  // The dump inserts rows before the tables their foreign keys name exist.
  const database = new DatabaseSync(paths.database, { enableForeignKeyConstraints: false });
  try { database.exec(reference('bridge-snapshots.sql')); } finally { database.close(); }
  const expected = JSON.parse(reference('bridge-snapshots.json'));
  // The start prompt has since moved to Electron's own settings; snapshots keep the default for older releases.
  for (const view of Object.values(expected) as any[]) view.result.config.kittyStartPrompt = 'is task clear?';
  for (const view of ['active', 'archive', 'scheduled']) {
    assert.deepEqual(JSON.parse(jsonStringify(await respond(request('snapshot', { view }), paths))), expected[view]);
  }
});
