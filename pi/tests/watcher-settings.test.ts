import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FieldAutomation, runFieldHandler, type WatcherFailureLog } from '../field-events.ts';
import { discoverFieldWatchers } from '../field-watchers.ts';
import { readConfigDocument, saveFieldWatchers } from '../footer-config.ts';
import { handleTaskEvent } from '../watchers/cleanup-worktree.mjs';
import { runCommand } from '../watchers/run-command.mjs';

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
  assert.deepEqual([cleanup.taskEvents, cleanup.fieldEvents, cleanup.fields, cleanup.timeoutSeconds, cleanup.params], [['completed'], [], ['Worktrees'], 120, { dir: '/tmp' }]);
  // A full configuration stays valid when a later version bundles another watcher.
  const full = [...Array.from({ length: 29 }, (_, i) => ({ path: join(dir, `full-${i}.mjs`), enabled: false })),
    ...discoverFieldWatchers({}).filter((watcher) => watcher.name !== 'Run command').map(({ path }) => ({ path, enabled: false }))];
  assert.deepEqual(discoverFieldWatchers({ fieldWatchers: full }).map((watcher) => watcher.path), full.map((entry) => entry.path));
  // Saved copies from another package directory: the desktop hides their bundled twins, not a distinct watcher
  // that shares a file name with a customized script.
  const bundledDir = dirname(discoverFieldWatchers({}).find((watcher) => watcher.name === 'Run command')!.path), packageDir = join(dir, 'package');
  mkdirSync(packageDir);
  for (const name of ['cleanup-worktree', 'forgejo-pr', 'github-pr']) cpSync(join(bundledDir, `${name}.params.json`), join(packageDir, `${name}.params.json`));
  const copies = [...full.slice(0, 27), ...['cleanup-worktree.mjs', 'forgejo-pr.mjs', 'github-pr.mjs', 'run-command.mjs'].map((name) => ({ path: join(packageDir, name), enabled: false }))];
  assert.equal(discoverFieldWatchers({ fieldWatchers: copies }).at(-1)!.path, join(bundledDir, 'run-command.mjs'));
  const entries = [
    { path: forgejo.path, enabled: true, fieldEvents: ['added'], fields: ['PRs'], params: { instances: [{ url: 'http://127.0.0.1:3000' }] } },
    { path: script, enabled: true, taskEvents: ['completed'], params: { dir: 'relative' }, appEvents: ['startup'], timeoutSeconds: 30, cooldownSeconds: 5 },
  ];
  assert.throws(() => saveFieldWatchers(entries, raw), /Invalid parameter: Directory/);
  entries[1].params = { dir: '/tmp' } as never;
  for (const instances of [[{ tokenEnv: 'TOKEN' }], [{ url: 'forgejo.example' }], [{ url: 'https://forgejo.example' }, { url: 'https://forgejo.example/' }]]) {
    assert.throws(() => saveFieldWatchers([{ ...entries[0], params: { instances } }], raw), /Invalid Instances/, 'An instance the script would refuse is not saved');
  }
  assert.throws(() => saveFieldWatchers([{ ...entries[1], bad: true }], raw), /Invalid field watcher/);
  for (const limit of [{ timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { cooldownSeconds: -1 }, { cooldownSeconds: 1.5 }]) {
    assert.throws(() => saveFieldWatchers([{ ...entries[1], ...limit }], raw), /Invalid field watcher/);
  }
  const saved = JSON.parse(saveFieldWatchers(entries, raw));
  assert.deepEqual(saved, { handoffPrompt: 'Keep', forgejoInstances: [{ url: 'http://127.0.0.1:3000' }], fieldWatchers: [
    { path: forgejo.path, enabled: true, fieldEvents: ['added'], fields: ['PRs'] },
    { path: script, enabled: true, taskEvents: ['completed'], appEvents: ['startup'], cooldownSeconds: 5, params: { dir: '/tmp' } },
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
  const complete = (Worktrees: string, event = 'completed'): Promise<{ state?: string }> => handleTaskEvent({ version: 1, scope: 'task', event, taskId: 1, eventId: '1', fields: { Worktrees }, params: { dir: inside } });
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
  for (const name of ['first', 'second']) git('worktree', 'add', '-q', '-b', name, join(inside, name));
  const several = await complete([join(inside, 'first'), join(inside, 'dirty'), join(inside, 'second')].join('\n'));
  assert.deepEqual([several.state, existsSync(join(inside, 'first')), existsSync(join(inside, 'dirty')), existsSync(join(inside, 'second'))], ['kept', false, true, false], 'Each recorded worktree is handled on its own');
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
    writeFileSync(join(dir, `${name}.params.json`), JSON.stringify({ taskEvents: ['completed'], fields: ['Worktrees'] }));
    return path;
  };
  const history = (value: Record<string, unknown>) => writeFileSync(state, JSON.stringify(value));
  const completed = (id: number) => ({ id, taskId: id, event: 'completed', fields: { Worktrees: `/tmp/${id}` } });
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
  await ticks(1);
  assert.deepEqual(delivered().slice(2).sort(), ['first:8', 'second:8'], 'Watchers run at once, each one invocation at a time');
  // Disabled with an event still queued, then enabled again with the same settings: it starts afresh.
  const second = entries.pop()!;
  await ticks(1);
  entries = [...entries, second];
  await ticks(4);
  assert.deepEqual(delivered().slice(4), ['first:9']);
  history({ tail: 11, events: [completed(10), completed(11)] });
  await ticks(1);
  const ran = delivered().length;
  entries = entries.map((entry) => ({ ...entry, fields: ['Other'] }));
  await ticks(4);
  assert.equal(delivered().length, ran, 'A queued task no longer selected by Fields does not run');
  assert.ok(!readFileSync(requests, 'utf8').includes('field-events'), 'A watcher without field events reads no field history');
});

test('startup runs once per scheduler start; watchers run at once within their time limits and cooldowns', { timeout: 30_000 }, async (t) => {
  const dir = profile(t), note = join(dir, 'note.mjs'), state = join(dir, 'history.json'), calls = join(dir, 'calls.log');
  writeFileSync(note, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const after = args.includes('--after') ? Number(args[args.indexOf('--after') + 1]) : undefined, limit = Number(args[args.indexOf('--limit') + 1]);
const events = after === undefined ? [] : state.events.filter((event) => event.id > after).slice(0, limit);
console.log(JSON.stringify({ cursor: events.length === limit ? events.at(-1).id : state.tail, events }));`, { mode: 0o700 });
  writeFileSync(state, JSON.stringify({ tail: 0, events: [] }));
  const script = (name: string, sleep = 0) => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, `#!${process.execPath}\nimport fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8')),start=Date.now();
setTimeout(()=>{fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({name:'${name}',scope:input.scope,event:input.event,eventId:input.eventId,start,end:Date.now()})+'\\n');console.log('{}');},${sleep});`, { mode: 0o700 });
    return path;
  };
  // Stops on SIGTERM, recording it: a timed-out watcher can stop what it started.
  const slow = join(dir, 'slow.mjs'), terminated = join(dir, 'terminated');
  writeFileSync(slow, `#!${process.execPath}\nimport fs from 'node:fs';process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(terminated)},'');process.exit(1);});setTimeout(()=>{},10000);`, { mode: 0o700 });
  // Without field events: this fake history serves task events only.
  let entries: Record<string, unknown>[] = [
    { path: script('a', 600), enabled: true, appEvents: ['startup'] }, { path: script('b', 600), enabled: true, appEvents: ['startup'] },
    { path: slow, enabled: true, appEvents: ['startup'], timeoutSeconds: 1 },
    { path: script('cool'), enabled: true, taskEvents: ['completed'], cooldownSeconds: 2 }, { path: script('other'), enabled: true, taskEvents: ['started'] },
  ].map((entry) => ({ ...entry, fieldEvents: [] }));
  const failures: WatcherFailureLog[] = [];
  const open = () => FieldAutomation.open({ path: join(dir, 'state.db'), noteCommand: note, log: (failure) => { if (failure) failures.push(failure); },
    watchers: () => discoverFieldWatchers({ fieldWatchers: entries }) });
  let automation = await open();
  t.after(() => automation.close());
  const delivered = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

  const began = Date.now();
  await automation.tick();
  assert.ok(Date.now() - began < 5000, 'The 1-second time limit replaces the default 30 seconds');
  const [a, b] = ['a', 'b'].map((name) => delivered().find((call) => call.name === name));
  assert.deepEqual([a.scope, a.event, b.event], ['app', 'startup', 'startup']);
  assert.ok(a.start < b.end && b.start < a.end, 'Different watchers run at the same time');
  assert.deepEqual(failures.map(({ watcher, taskId, field, reason }) => [watcher, taskId, field, reason]), [['slow', null, 'app:startup', 'Watcher timed out']]);
  assert.ok(existsSync(terminated), 'A timeout sends SIGTERM first');
  // Enabling a startup watcher later does not run it: only the next start does.
  entries = [...entries, { path: script('late'), enabled: true, appEvents: ['startup'], fieldEvents: [] }];
  writeFileSync(state, JSON.stringify({ tail: 2, events: [1, 2].map((id) => ({ id, taskId: id, event: 'completed', fields: {} })) }));
  await automation.tick(); await automation.tick();
  assert.deepEqual(delivered().filter((call) => call.name !== 'a' && call.name !== 'b').map((call) => `${call.name}:${call.eventId}`), ['cool:1'], 'Startup runs once; the cooldown holds the next event');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await automation.tick();
  assert.deepEqual(delivered().filter((call) => call.name === 'cool').map((call) => call.eventId), ['1', '2'], 'A held event runs once the cooldown ends');
  // A backlog held by one watcher's cooldown does not delay another watcher's events.
  const completions = Array.from({ length: 100 }, (_, i) => ({ id: i + 3, taskId: 1, event: 'completed', fields: {} }));
  writeFileSync(state, JSON.stringify({ tail: 103, events: [...completions, { id: 103, taskId: 1, event: 'started', fields: {} }] }));
  for (let i = 0; i < 8 && !delivered().some((call) => call.name === 'other'); i++) await automation.tick();
  assert.deepEqual(delivered().filter((call) => call.name === 'other').map((call) => call.eventId), ['103']);
  assert.ok(delivered().filter((call) => call.name === 'cool').length < 5, 'The cooling watcher still waits');
  await automation.close(); automation = await open();
  await automation.tick();
  assert.deepEqual(delivered().filter((call) => call.event === 'startup').map((call) => call.name).sort(), ['a', 'a', 'b', 'b', 'late']);
});

test('run command passes arguments without a shell; a coalescing watcher runs once for completions held by its cooldown', { timeout: 30_000 }, async (t) => {
  const dir = profile(t), note = join(dir, 'note.mjs'), state = join(dir, 'history.json'), calls = join(dir, 'calls.log'), command = join(dir, 'record.sh');
  writeFileSync(command, `#!/bin/sh\nprintf '%s|' "$PWD" "$@" >> ${JSON.stringify(calls)}\necho >> ${JSON.stringify(calls)}\n[ "$1" != fail ]\n`, { mode: 0o700 });
  const args = (...values: string[]) => values.map((value) => ({ value }));
  assert.deepEqual(await runCommand({ params: { command, args: args('$(touch pwned)', 'two words') } }), {});
  assert.equal(readFileSync(calls, 'utf8'), `${dir}|$(touch pwned)|two words|\n`, 'Arguments are passed as written, from the command directory');
  assert.ok(!existsSync(join(dir, 'pwned')));
  for (const params of [{ command, args: args('fail') }, { command: 'record.sh' }, { command: join(dir, 'missing') }, { command, args: ['bare'] }]) {
    await assert.rejects(runCommand({ params }));
  }
  rmSync(calls);
  // The executable decodes stdin as one stream: a character split between two reads survives.
  const child = spawn(fileURLToPath(new URL('../watchers/run-command.mjs', import.meta.url)), [], { stdio: ['pipe', 'ignore', 'ignore'] });
  const input = Buffer.from(JSON.stringify({ params: { command, args: args('žvėris') } })), split = input.indexOf(Buffer.from('ž')) + 1;
  child.stdin.write(input.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.stdin.end(input.subarray(split));
  assert.equal((await once(child, 'exit'))[0], 0);
  assert.equal(readFileSync(calls, 'utf8'), `${dir}|žvėris|\n`);
  rmSync(calls);
  // A stopped run ends only with its whole process group: a command ignoring SIGTERM is killed after the grace period.
  const stubborn = join(dir, 'stubborn.sh');
  writeFileSync(stubborn, `#!/bin/sh\ntrap '' TERM\nsleep 30\n`, { mode: 0o700 });
  const started = Date.now(), watcherPath = fileURLToPath(new URL('../watchers/run-command.mjs', import.meta.url));
  await assert.rejects(runFieldHandler(watcherPath, { params: { command: stubborn } }, new AbortController().signal, 300), /Watcher timed out/);
  assert.ok(Date.now() - started >= 3000 && Date.now() - started < 4500, 'The invocation waits for its process group, within the grace period');
  assert.throws(() => execFileSync('pgrep', ['-f', stubborn]), 'Nothing from the stopped run survives');

  writeFileSync(note, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const after = args.includes('--after') ? Number(args[args.indexOf('--after') + 1]) : undefined, limit = Number(args[args.indexOf('--limit') + 1]);
const events = after === undefined ? [] : state.events.filter((event) => event.id > after).slice(0, limit);
console.log(JSON.stringify({ cursor: events.length === limit ? events.at(-1).id : state.tail, events }));`, { mode: 0o700 });
  const history = (ids: number[]) => writeFileSync(state, JSON.stringify({ tail: ids.at(-1) ?? 0, events: ids.map((id) => ({ id, taskId: id, event: 'completed', fields: {} })) }));
  history([]);
  const script = fileURLToPath(new URL('../watchers/run-command.mjs', import.meta.url));
  const entries = [{ path: script, enabled: true, cooldownSeconds: 2, params: { command, args: args('check') } }];
  const watcher = discoverFieldWatchers({ fieldWatchers: entries })[0];
  assert.deepEqual([watcher.name, watcher.appEvents, watcher.taskEvents, watcher.coalesceTaskEvents, watcher.timeoutSeconds, watcher.problem], ['Run command', ['startup'], ['completed'], true, 300, undefined]);
  const automation = await FieldAutomation.open({ path: join(dir, 'state.db'), noteCommand: note, watchers: () => discoverFieldWatchers({ fieldWatchers: entries }) });
  t.after(() => automation.close());
  const runs = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const until = async (count: number) => { for (let i = 0; i < 50 && runs() < count; i++) { await automation.tick(); await new Promise((resolve) => setTimeout(resolve, 100)); } };
  await until(1);
  assert.equal(runs(), 1, 'Startup runs the command');
  // 40 completions during the cooldown take two history reads; they queue as one run.
  history(Array.from({ length: 40 }, (_, i) => i + 1));
  for (let i = 0; i < 3; i++) await automation.tick();
  assert.equal(runs(), 1, 'The cooldown holds the completions');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await until(2);
  for (let i = 0; i < 3; i++) await automation.tick();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  for (let i = 0; i < 3; i++) await automation.tick();
  assert.equal(runs(), 2, 'One run covers every completion queued before it');
  // Outside the cooldown, a burst spanning several history pages runs at once and once more after the cooldown.
  history(Array.from({ length: 80 }, (_, i) => i + 1));
  await until(3);
  for (let i = 0; i < 4; i++) await automation.tick();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await until(4);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  for (let i = 0; i < 3; i++) await automation.tick();
  assert.equal(runs(), 4, 'Events read during the cooldown merge into one run');
  // Coalescing declared while events wait: they run as one.
  const copy = join(dir, 'later.mjs'), manifest = join(dir, 'later.params.json');
  cpSync(script, copy);
  writeFileSync(manifest, JSON.stringify({ taskEvents: ['completed'], params: [{ key: 'command', label: 'Command', type: 'string' }, { key: 'args', label: 'Arguments', type: 'list', columns: [{ key: 'value', label: 'Argument' }] }] }));
  entries.splice(0, 1, { path: copy, enabled: true, cooldownSeconds: 2, params: { command, args: args('later') } });
  await automation.tick();
  history(Array.from({ length: 83 }, (_, i) => i + 1));
  await until(5);
  history(Array.from({ length: 86 }, (_, i) => i + 1));
  for (let i = 0; i < 3; i++) await automation.tick();
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), coalesceTaskEvents: true }));
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await until(6);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  for (let i = 0; i < 3; i++) await automation.tick();
  assert.equal(runs(), 6, 'Turning coalescing on merges the events already queued');
});
