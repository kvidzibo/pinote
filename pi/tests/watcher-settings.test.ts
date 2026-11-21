import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FieldAutomation } from '../field-events.ts';
import { discoverFieldWatchers } from '../field-watchers.ts';
import { readConfigDocument, saveFieldWatchers } from '../footer-config.ts';
import { handleTaskEvent } from '../watchers/cleanup-worktree.mjs';

const exec = promisify(execFile);
const command = fileURLToPath(new URL('../../backend/bin/note', import.meta.url));
function profile(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pinote-watcher-settings-')));
  const names = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR', 'PINOTE_NOTE_COMMAND'], previous = names.map((name) => process.env[name]);
  Object.assign(process.env, { XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: pathToFileURL(dir).href, PINOTE_NOTE_COMMAND: command });
  t.after(() => {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('selected task and field events reach a script with its parameters; earlier history never replays', { timeout: 90_000 }, async (t) => {
  const dir = profile(t), handler = join(dir, 'deploy.mjs'), calls = join(dir, 'calls.jsonl');
  writeFileSync(handler, `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},fs.readFileSync(0,'utf8')+'\\n');console.log('{}');`, { mode: 0o700 });
  writeFileSync(join(dir, 'deploy.params.json'), JSON.stringify({ name: 'Deploy status', taskEvents: ['completed'], fieldEvents: ['changed'], fields: ['Deploy'],
    params: [{ key: 'environment', label: 'Environment', type: 'select', options: ['staging', 'production'], required: true }, { key: 'timeout', label: 'Timeout', type: 'number', default: 30 }] }));
  let entry: Record<string, unknown> = { path: handler, enabled: true };
  const watchers = () => discoverFieldWatchers({ fieldWatchers: [entry] });
  const note = async (...args: string[]) => JSON.parse((await exec(command, ['--no-notify', ...args])).stdout);
  const add = async (fields: Record<string, string>[]) => {
    let task = await note('agent', 'add', '--text=Task');
    for (const set of fields) task = await note('agent', 'update', String(task.id), '--expected-updated-at', task.updated_at, '--set-json', JSON.stringify(set));
    return task;
  };
  const done = (task: { id: number; updated_at: string }) => note('agent', 'done', String(task.id), '--expected-updated-at', task.updated_at);
  const automation = await FieldAutomation.open({ path: join(dir, 'state.db'), noteCommand: command, watchers });
  t.after(() => automation.close());
  const settle = async () => { for (let i = 0; i < 12; i++) await automation.tick(); };
  const read = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

  const custom = watchers().find((watcher) => watcher.path === handler)!;
  assert.deepEqual([custom.name, custom.problem, custom.params], ['Deploy status', 'Needs parameter: Environment', { timeout: 30 }]);
  await done(await add([{ Deploy: 'before' }]));
  await settle();
  assert.deepEqual(read(), [], 'A watcher missing a required parameter does not run');

  entry = { ...entry, params: { environment: 'staging' } };
  await settle();
  assert.deepEqual(read(), [], 'Completions from before the watcher ran are not replayed');
  const task = await add([{ Deploy: '1' }, { Other: 'x' }, { Deploy: '2' }]);
  await settle();
  await done(task);
  await done(await add([{ Other: 'y' }]));
  await settle();
  const params = { environment: 'staging', timeout: 30 };
  assert.deepEqual(read().map(({ eventId, previousValue, ...rest }) => rest), [
    { version: 1, taskId: task.id, field: 'Deploy', event: 'changed', value: '2', params },
    { version: 1, scope: 'task', event: 'completed', taskId: task.id, fields: { Deploy: '2', Other: 'x' }, params },
  ], 'Only the selected events for tasks and fields named in Fields');
});

test('watcher settings save validated entries and the shared keys their scripts declare', (t) => {
  const dir = profile(t), script = join(dir, 'custom.mjs');
  writeFileSync(script, '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(join(dir, 'custom.params.json'), JSON.stringify({ params: [{ key: 'dir', label: 'Directory', type: 'directory', required: true }] }));
  writeFileSync(join(dir, 'pi-note.json'), JSON.stringify({ handoffPrompt: 'Keep', forgejoInstances: [{ url: 'https://forgejo.example', tokenEnv: 'TOKEN' }] }));
  const { raw, value } = readConfigDocument();
  const forgejo = discoverFieldWatchers(value).find((watcher) => watcher.name === 'Forgejo PR')!;
  assert.deepEqual([forgejo.fields, forgejo.params.instances], [['PRs', 'PR'], [{ url: 'https://forgejo.example', tokenEnv: 'TOKEN' }]]);
  const cleanup = discoverFieldWatchers(value).find((watcher) => watcher.name === 'Worktree cleanup')!;
  assert.deepEqual([cleanup.taskEvents, cleanup.fieldEvents, cleanup.fields, cleanup.params], [['completed'], [], ['Worktree'], { dir: '/tmp' }]);
  const entries = [
    { path: forgejo.path, enabled: true, fieldEvents: ['added'], fields: ['PRs'], params: { instances: [{ url: 'http://127.0.0.1:3000' }] } },
    { path: script, enabled: true, taskEvents: ['completed'], params: { dir: 'relative' } },
  ];
  assert.throws(() => saveFieldWatchers(entries, raw), /Invalid parameter: Directory/);
  entries[1].params = { dir: '/tmp' } as never;
  for (const instances of [[{ tokenEnv: 'TOKEN' }], [{ url: 'forgejo.example' }], [{ url: 'https://forgejo.example' }, { url: 'https://forgejo.example/' }]]) {
    assert.throws(() => saveFieldWatchers([{ ...entries[0], params: { instances } }], raw), /Invalid Instances/, 'An instance the script would refuse is not saved');
  }
  assert.throws(() => saveFieldWatchers([{ ...entries[1], bad: true }], raw), /Invalid field watcher/);
  const saved = JSON.parse(saveFieldWatchers(entries, raw));
  assert.deepEqual(saved, { handoffPrompt: 'Keep', forgejoInstances: [{ url: 'http://127.0.0.1:3000' }], fieldWatchers: [
    { path: forgejo.path, enabled: true, fieldEvents: ['added'], fields: ['PRs'] },
    { path: script, enabled: true, taskEvents: ['completed'], params: { dir: '/tmp' } },
  ] });
  assert.throws(() => saveFieldWatchers(entries, raw), /changed while settings were open/);
  // Settings equal to the script's defaults are not written: versions without them reject unknown keys.
  const untouched = discoverFieldWatchers({}).filter((watcher) => watcher.bundled).map(({ path, enabled, taskEvents, fieldEvents, fields, params }) => ({ path, enabled, taskEvents, fieldEvents, fields, params }));
  const current = readConfigDocument().raw;
  assert.deepEqual(JSON.parse(saveFieldWatchers(untouched, current)).fieldWatchers, untouched.map(({ path }) => ({ path, enabled: false })));
  // One shared value cannot be saved with two different contents.
  const copy = join(dir, 'forgejo-pr.mjs');
  writeFileSync(copy, '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(join(dir, 'forgejo-pr.params.json'), JSON.stringify({ params: [{ key: 'hosts', label: 'Hosts', type: 'list', columns: [{ key: 'url', label: 'URL' }], configKey: 'forgejoInstances' }] }));
  assert.throws(() => saveFieldWatchers([entries[0], { path: copy, enabled: false, params: { hosts: [{ url: 'https://other.example' }] } }], readConfigDocument().raw), /differs between watchers sharing forgejoInstances/);
});

test('worktree cleanup removes only a clean linked worktree inside the configured directory', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pinote-cleanup-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), inside = join(dir, 'worktrees'), git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  mkdirSync(repo); mkdirSync(inside);
  execFileSync('git', ['init', '-q', repo]);
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
  for (const name of ['clean', 'dirty', 'locked']) git('worktree', 'add', '-q', '-b', name, join(inside, name));
  git('worktree', 'add', '-q', '-b', 'outside', join(dir, 'outside'));
  writeFileSync(join(inside, 'dirty', 'new.txt'), 'unsaved');
  git('worktree', 'lock', join(inside, 'locked'));
  const complete = (Worktree: string, event = 'completed'): Promise<{ state?: string }> => handleTaskEvent({ version: 1, scope: 'task', event, taskId: 1, eventId: '1', fields: { Worktree }, params: { dir: inside } });
  for (const [path, event] of [[join(inside, 'dirty')], [join(inside, 'locked')], [join(dir, 'outside')], [repo], [inside], [join(inside, 'clean'), 'removed']]) {
    assert.notEqual((await complete(path, event)).state, 'removed');
    assert.ok(existsSync(path), `${path} is kept`);
  }
  mkdirSync(join(inside, 'clean '));
  assert.equal((await complete(join(inside, 'clean '))).state, 'kept', 'The recorded path is used exactly');
  assert.ok(existsSync(join(inside, 'clean')));
  assert.equal((await complete(join(inside, 'clean'))).state, 'removed');
  assert.equal(existsSync(join(inside, 'clean')), false);
  assert.match(git('branch', '--list', 'clean').toString(), /clean/, 'The branch is kept');
  assert.equal((await complete(join(inside, 'clean'))).state, 'kept', 'A repeated event is harmless');
});

test('task events survive a failed read, skip field history, and start at enablement for each watcher and setting', async (t) => {
  const dir = profile(t), note = join(dir, 'note.mjs'), state = join(dir, 'history.json'), requests = join(dir, 'requests.log'), calls = join(dir, 'calls.log');
  writeFileSync(note, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(requests)}, args[1] + '\\n');
if (state.fail) process.exit(1);
const after = args.includes('--after') ? Number(args[args.indexOf('--after') + 1]) : undefined;
console.log(JSON.stringify({ cursor: state.tail, events: after === undefined ? [] : state.events.filter((event) => event.id > after) }));`, { mode: 0o700 });
  const script = (name: string) => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'${name}:'+JSON.parse(fs.readFileSync(0,'utf8')).eventId+'\\n');console.log('{}');`, { mode: 0o700 });
    writeFileSync(join(dir, `${name}.params.json`), JSON.stringify({ taskEvents: ['completed'], fields: ['Worktree'] }));
    return path;
  };
  const history = (value: Record<string, unknown>) => writeFileSync(state, JSON.stringify(value));
  const completed = (id: number) => ({ id, taskId: id, event: 'completed', fields: { Worktree: `/tmp/${id}` } });
  let entries: Record<string, unknown>[] = [{ path: script('first'), enabled: true }], failures = 0;
  const automation = await FieldAutomation.open({ path: join(dir, 'state.db'), noteCommand: note, log: () => { failures++; },
    watchers: () => discoverFieldWatchers({ fieldWatchers: entries }) });
  t.after(() => automation.close());
  const ticks = async (count: number) => { for (let i = 0; i < count; i++) await automation.tick(); };
  const delivered = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];

  history({ tail: 5, events: [completed(5)] });
  await ticks(1);
  history({ tail: 6, events: [completed(6)], fail: true });
  await ticks(1);
  assert.deepEqual([delivered(), failures], [[], 1]);
  history({ tail: 6, events: [completed(6)] });
  await ticks(2);
  assert.deepEqual(delivered(), ['first:6'], 'A change made during a failed read still runs');
  // Committed but not read yet when a second watcher is enabled: only the watcher enabled at the time receives it.
  history({ tail: 7, events: [completed(7)] });
  entries = [...entries, { path: script('second'), enabled: true }];
  await ticks(3);
  assert.deepEqual(delivered(), ['first:6', 'first:7']);
  history({ tail: 9, events: [completed(8), completed(9)] });
  await ticks(4);
  assert.deepEqual(delivered(), ['first:6', 'first:7', 'first:8', 'second:8'], 'One invocation per turn');
  // Disabled with an event still queued, then enabled again with the same settings: it starts afresh.
  const second = entries.pop()!;
  await ticks(1);
  entries = [...entries, second];
  await ticks(4);
  assert.deepEqual(delivered().slice(4), ['first:9']);
  history({ tail: 11, events: [completed(10), completed(11)] });
  await ticks(1);
  entries = entries.map((entry) => ({ ...entry, fields: ['Other'] }));
  await ticks(4);
  assert.equal(delivered().filter((call) => /:1[01]$/.test(call)).length <= 1, true, 'A queued task no longer selected by Fields does not run');
  assert.ok(!readFileSync(requests, 'utf8').includes('field-events'), 'A watcher without field events reads no field history');
});
