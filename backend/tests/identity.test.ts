import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { application_id } from '../src/model.ts';
import { discoverPaths } from '../src/runtime.ts';

// Also run the same byte-level regressions against the shipped shebang wrappers
// after building: PINOTE_TEST_WRAPPERS=1 node --test --experimental-strip-types tests/identity.test.ts
const wrappers = process.env.PINOTE_TEST_WRAPPERS === '1';
const bridge = resolve(wrappers ? 'bin/pinote-electron-backend' : 'src/bridge-entry.ts');
const cli = resolve(wrappers ? 'bin/note' : 'src/cli-entry.ts');
const request = (operation: string, params: object = {}) => JSON.stringify({ protocol: 1, operation, params });
const malformed = (path: string) => Buffer.concat([Buffer.from(path), Buffer.from([0xff])]);
const hex = (value: string | Buffer) => Buffer.from(value).toString('hex');
// macOS file systems reject non-UTF-8 names, and there is no /proc to read raw bytes from.
const skip = process.platform === 'darwin' && 'needs non-UTF-8 file names and /proc';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pinote-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), LC_ALL: 'C.UTF-8' };
  function run(entry: string, { args = [], input, bindings = {}, cwd = root }: {
    args?: (string | Buffer)[]; input?: string; bindings?: Record<string, string | Buffer>; cwd?: string | Buffer;
  } = {}) {
    // JS subprocess APIs cannot produce undecodable argv/env/cwd. Bash only
    // injects the execve bytes here; neither production entry depends on it.
    const argv = wrappers ? [entry, ...args] : [process.execPath, '--disable-warning=ExperimentalWarning', '--experimental-strip-types', entry, ...args];
    const childEnv: Record<string, string | Buffer> = { ...env, ...bindings };
    if (wrappers && bindings.PATH !== undefined) childEnv.PATH = Buffer.concat([Buffer.from(bin + ':'), Buffer.from(bindings.PATH)]);
    // An ASCII-only script: $'\xHH' quoting yields each byte unchanged.
    const quote = (value: string | Buffer) => "$'" + Buffer.from(value).toString('hex').replace(/../g, '\\x$&') + "'";
    const script = `cd ${quote(cwd)} && exec /usr/bin/env -i ${Object.entries(childEnv).map(([key, value]) => quote(Buffer.concat([Buffer.from(key + '='), Buffer.from(value)]))).join(' ')} ${argv.map(quote).join(' ')}`;
    const result = spawnSync('/bin/bash', ['-c', script], { env: { LC_ALL: 'C' }, input, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  const fresh = (...extra: string[]) => {
    for (const path of [env.XDG_DATA_HOME, env.XDG_STATE_HOME, ...extra]) assert.equal(existsSync(path), false, path);
  };
  const reply = (result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, env, run, fresh, reply };
}

test('standalone import rejects raw argv rather than opening a real U+FFFD sibling', { skip }, t => {
  const f = fixture(t);
  const prefix = join(f.root, 'notes-'), raw = malformed(prefix), sibling = prefix + '\ufffd';
  writeFileSync(raw, '- [ ] raw bytes\n');
  try {
    writeFileSync(sibling, '- [ ] valid replacement character\n');
    const command = ['--no-notify', 'import'];
    for (const rejected of [f.run(cli, { args: [...command, raw] }), f.run(bridge, { args: [raw] })]) {
      assert.equal(rejected.status, 2);
      assert.match(rejected.stderr, /UTF-8/);
      assert.equal(rejected.stdout, '');
    }
    f.fresh();
    const accepted = f.run(cli, { args: [...command, sibling] });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(f.run(cli, { args: ['list'] }).stdout, /valid replacement character/);
  } finally { unlinkSync(raw); }
});

test('active inherited path values are checked without exposing or rejecting unrelated env', { skip }, t => {
  const f = fixture(t);
  const prefix = join(f.root, 'PRIVATE-env-'), raw = malformed(prefix), sibling = prefix + '\ufffd';
  const add = request('add', { text: 'must not save', tag: null });
  const reject = (bindings: Record<string, string | Buffer>, input = add) => {
    const r = f.run(bridge, { input, bindings });
    assert.equal(f.reply(r).ok, false);
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE-env-/);
    f.fresh(sibling);
  };
  reject({ XDG_DATA_HOME: raw }, request('handshake'));
  reject({ XDG_DATA_HOME: raw });
  reject({ XDG_STATE_HOME: raw });
  reject({ XDG_DATA_HOME: '', HOME: raw });
  reject({ XDG_CONFIG_HOME: raw }, request('snapshot', { view: 'archive' }));
  reject({ PATH: raw });
  const note = f.run(cli, { args: ['--no-notify', 'add', 'must not save'], bindings: { XDG_DATA_HOME: raw } });
  assert.equal(note.status, 1);
  assert.match(note.stdout, /XDG_DATA_HOME.*UTF-8/);
  assert.doesNotMatch(note.stdout + note.stderr, /PRIVATE-env-/);
  f.fresh(sibling);
  const tilde = f.run(cli, { args: ['import', '~/notes.md'], bindings: { HOME: raw } });
  assert.equal(tilde.status, 1);
  assert.match(tilde.stdout, /HOME.*UTF-8/);
  f.fresh(sibling);

  const r = f.reply(f.run(bridge, { input: request('handshake'), bindings: {
    XDG_DATA_HOME: sibling, HOME: raw, XDG_CONFIG_HOME: raw, UNRELATED: raw,
  } }));
  assert.equal(r.result.database, join(sibling, 'pinote/notes.db'));
  const fallback = f.reply(f.run(bridge, { input: request('handshake'), bindings: { XDG_DATA_HOME: malformed('relative-') } }));
  assert.equal(fallback.result.database, join(f.root, '.local/share/pinote/notes.db'));
  assert.equal(f.run(cli, { args: ['--version'], bindings: { XDG_DATA_HOME: raw } }).status, 0);
  f.fresh(sibling);
});

test('handshake and folder/selection keys never substitute a U+FFFD sibling for a symlink target', { skip }, t => {
  const f = fixture(t);
  const prefix = join(f.root, 'project-'), raw = malformed(prefix), sibling = prefix + '\ufffd';
  const bad = join(f.root, 'bad'), good = join(f.root, 'good');
  mkdirSync(raw);
  try {
    mkdirSync(sibling);
    symlinkSync(raw, bad);
    symlinkSync('project-\ufffd', good);
    const bindings = { XDG_DATA_HOME: bad };
    assert.equal(f.reply(f.run(bridge, { input: request('handshake'), bindings })).ok, false);
    assert.equal(f.reply(f.run(bridge, { input: request('add', { text: 'wrong profile', tag: null }), bindings })).ok, false);
    assert.equal(existsSync(Buffer.concat([raw, Buffer.from('/pinote')])), false);
    const tag = (folder: string) => request('create_tag', { name: 'Work', folder });
    assert.equal(f.reply(f.run(bridge, { input: tag(bad) })).error.code, 'invalid');
    const selection = f.run(cli, { args: ['agent', 'add', '--text=wrong folder', '--cwd=' + bad] });
    assert.equal(selection.status, 1);
    f.fresh(join(sibling, 'pinote'));
    const canonical = f.reply(f.run(bridge, { input: request('handshake'), bindings: { XDG_DATA_HOME: good } })).result.database;
    assert.equal(canonical, join(sibling, 'pinote/notes.db'));
    // Independent of model.ts: SHA-256 of the canonical database path's bytes, as the Python reference computed it.
    assert.equal(application_id(discoverPaths({ ...f.env, XDG_DATA_HOME: good })),
      'io.github.kvidzibo.pinote.g' + createHash('sha256').update(canonical).digest('hex').slice(0, 32));
    assert.equal(f.reply(f.run(bridge, { input: tag(good) })).ok, true);
    assert.equal(f.reply(f.run(bridge, { input: request('snapshot', { view: 'archive' }) })).result.tags[0].folder, sibling);
  } finally { rmdirSync(raw); }
});

test('relative folder identities check physical cwd bytes, but absolute input does not need cwd', { skip }, t => {
  const f = fixture(t);
  const prefix = join(f.root, 'cwd-'), raw = malformed(prefix), sibling = prefix + '\ufffd';
  mkdirSync(raw);
  try {
    mkdirSync(sibling);
    const tag = request('create_tag', { name: 'Here', folder: '.' });
    assert.equal(f.reply(f.run(bridge, { input: tag, cwd: raw })).error.code, 'invalid');
    const relativeProfile = f.run(bridge, { input: request('handshake'), cwd: raw, bindings: { XDG_DATA_HOME: '', HOME: 'relative' } });
    assert.equal(f.reply(relativeProfile).ok, false);
    assert.equal(f.reply(f.run(bridge, { input: request('handshake'), cwd: raw })).ok, true);
    f.fresh();
    assert.equal(f.reply(f.run(bridge, { input: tag, cwd: sibling })).ok, true);
    const snapshot = f.reply(f.run(bridge, { input: request('snapshot', { view: 'archive' }), cwd: raw }));
    assert.equal(snapshot.result.tags[0].folder, sibling);
  } finally { rmdirSync(raw); }
});
