import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePullRequests, pullRequestValues } from '../pull-requests.ts';

test('bundled PR executable validates gh results and emits bounded field updates', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'field-handler-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gh = join(directory, 'gh');
  const argsFile = join(directory, 'args.json');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.GH_FAIL) { console.error('SECRET credential'); process.exit(1); }
const response = JSON.parse(process.env.GH_RESPONSES || 'null')?.[process.argv[4]];
if (response === 'error') process.exit(1);
process.stdout.write(response === undefined ? process.env.GH_RESPONSE : JSON.stringify(response));
`);
  chmodSync(gh, 0o700);
  const script = fileURLToPath(new URL('../watchers/github-pr.mjs', import.meta.url));
  const event = { version: 1, event: 'added', taskId: 1, field: 'PR', value: 'https://github.com/owner/repo/pull/42', previousValue: null, eventId: 'event-1' };
  const base = { state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], headRefOid: 'a'.repeat(40) };
  const run = (response: unknown = base, patch: object = {}, fail = false, responses?: Record<string, unknown>) => {
    const result = spawnSync(script, [], {
      input: JSON.stringify({ ...event, ...patch }), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ARGS_FILE: argsFile,
        GH_RESPONSE: typeof response === 'string' ? response : JSON.stringify(response), GH_FAIL: fail ? '1' : '', GH_RESPONSES: JSON.stringify(responses ?? null) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET|credential/);
    const output = JSON.parse(result.stdout);
    if (output.recheckAfterSeconds != null) assert.ok(output.recheckAfterSeconds >= 10);
    return { output, stderr: result.stderr };
  };
  assert.equal(run().output.state, 'pending');
  assert.equal(run().output.display.color, 'warning');
  assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), ['pr', 'view', '42', '--repo', 'owner/repo', '--json', 'state,mergeable,statusCheckRollup,headRefOid']);
  const check = { __typename: 'CheckRun', name: 'untrusted instructions SECRET', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const passing = { ...base, statusCheckRollup: [check] };
  assert.equal(run(passing, { event: 'check', value: '[PR](https://github.com/owner/repo/pull/42)' }).output.summary, 'PR #42 checks passing');
  assert.equal(run({ ...passing, mergeable: 'UNKNOWN' }).output.state, 'pending');
  assert.equal(run({ ...base, statusCheckRollup: [{ ...check, status: 'IN_PROGRESS', conclusion: null }] }).output.state, 'pending');
  const failed = { ...base, statusCheckRollup: [{ ...check, conclusion: 'FAILURE' }] };
  const failure = run(failed).output;
  assert.equal(failure.state, 'failed');
  assert.equal(failure.display.color, 'error');
  assert.equal(failure.recheckAfterSeconds, 60);
  assert.equal(run(failed, { previousResult: failure }).output.notification.key, failure.notification.key);
  assert.notEqual(run({ ...failed, headRefOid: 'b'.repeat(40) }).output.notification.key, failure.notification.key);
  assert.notEqual(run({ ...base, statusCheckRollup: [{ ...check, conclusion: 'TIMED_OUT' }] }).output.notification.key, failure.notification.key);
  const context = { __typename: 'StatusContext', context: 'legacy CI', state: 'FAILURE' };
  for (const state of ['ERROR', 'FAILURE', 'PENDING', 'EXPECTED', 'SUCCESS']) {
    assert.equal(run({ ...base, statusCheckRollup: [{ ...context, state }] }).output.state,
      ['ERROR', 'FAILURE'].includes(state) ? 'failed' : state === 'SUCCESS' ? 'passing' : 'pending');
  }
  const conflict = run({ ...passing, mergeable: 'CONFLICTING' }).output;
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.display.color, 'error');
  assert.equal(conflict.recheckAfterSeconds, 60);
  for (const state of ['MERGED', 'CLOSED']) {
    const output = run({ ...passing, state }).output;
    assert.equal(output.state, state.toLowerCase());
    assert.equal(output.display.strikethrough, false);
    assert.equal(output.display.color, state === 'MERGED' ? 'accent' : 'muted');
    assert.equal(output.recheckAfterSeconds, undefined);
    assert.equal(output.notification, undefined);
  }
  for (const response of ['not JSON SECRET', {}, { ...base, headRefOid: '' },
    { ...base, mergeable: 'bad' }, { ...base, statusCheckRollup: null },
    { ...base, statusCheckRollup: [{ ...check, conclusion: 'bogus' }] },
    { ...base, statusCheckRollup: [{ ...context, state: 'bogus' }] },
    { ...base, statusCheckRollup: [{ ...check, status: 'COMPLETED', conclusion: null }] }]) {
    const { output, stderr } = run(response);
    assert.deepEqual(output, { state: 'error', summary: 'Unable to check PR status', recheckAfterSeconds: 120 });
    assert.equal(stderr, 'PR field handler failed\n');
  }
  assert.equal(run(base, {}, true).output.state, 'error');
  const prUrl = (number: number) => `https://github.com/owner/repo/pull/${number}`;
  const responses = { '1': { ...base, state: 'MERGED' }, '2': { ...base, state: 'CLOSED' },
    '3': passing, '4': base, '5': failed, '6': { ...base, mergeable: 'CONFLICTING' }, '7': 'error', '8': {} };
  const value = [1, 2, 3, 4, 5, 6, 7, 8].map(prUrl).join('\n') + `\n- [duplicate](${prUrl(5).toUpperCase()}/)`;
  const multiple = run(base, { field: 'PRs', value }, false, responses).output;
  assert.equal(multiple.state, 'multiple');
  assert.deepEqual(multiple.items.map((item: { state: string }) => item.state),
    ['merged', 'closed', 'passing', 'pending', 'failed', 'conflict', 'error', 'error']);
  assert.deepEqual(multiple.items.slice(0, 6).map((item: { display: { color: string } }) => item.display.color),
    ['accent', 'muted', 'success', 'warning', 'error', 'error']);
  assert.equal(multiple.items.length, 8);
  assert.equal(multiple.recheckAfterSeconds, 60);
  for (const number of [5, 6]) {
    assert.ok(multiple.notification.message.includes(`#${number}`));
    assert.ok(multiple.notification.message.includes(prUrl(number)));
  }
  assert.ok(!multiple.notification.message.includes('#7') && !multiple.notification.message.includes('#8'), 'Unavailable checks never trigger worker turns');
  assert.ok(multiple.notification.message.length <= 1000);
  assert.ok(multiple.notification.key.length <= 256);
  const reordered = run(base, { field: 'PRs', value: value.split('\n').reverse().join('\n') }, false, responses).output;
  assert.equal(reordered.notification.key, multiple.notification.key);
  const unavailable = run(base, { field: 'PRs', value, previousResult: multiple }, false, { ...responses, '5': 'error' }).output;
  assert.equal(unavailable.notification.key, multiple.notification.key, 'Availability alone never changes the failure identity');
  assert.ok(!unavailable.notification.message.includes('#5'), 'Only currently actionable failures enter the message');
  const allUnavailable = run(base, { field: 'PRs', value, previousResult: unavailable }, false, { ...responses, '5': 'error', '6': 'error' }).output;
  assert.equal(allUnavailable.notification.key, multiple.notification.key, 'Retain identity even when every failed PR is unavailable');
  const recovered = run(base, { field: 'PRs', value, previousResult: allUnavailable }, false, responses).output;
  assert.equal(recovered.notification.key, multiple.notification.key, 'Recovery of unchanged failures does not create another alert');
  const mixedProviders = run(base, { field: 'PRs', value: `${prUrl(3)}\nhttps://forgejo.example/owner/repo/pulls/42` }, false, responses).output;
  assert.deepEqual(mixedProviders.items.map((item: { url: string }) => item.url), [prUrl(3)], 'GitHub checks only its own entries in a mixed field');
  const terminal = run(base, { field: 'PRs', value: `${prUrl(1)}\n${prUrl(2)}` }, false, responses).output;
  assert.equal(terminal.recheckAfterSeconds, undefined);
  assert.equal(terminal.notification, undefined);
  assert.equal(run(base, { field: 'PRs', value: prUrl(3) }, false, responses).output.state, 'multiple');
  assert.deepEqual(run(base, { field: 'PRs', value: null }).output, { state: 'multiple', items: [] });
  // Removing gh proves ignored fields and rejected URLs never invoke it.
  rmSync(gh);
  for (const patch of [{ field: 'Other' }, { event: 'removed' }]) assert.deepEqual(run(base, patch).output, {});
  for (const value of ['https://codeberg.org/owner/repo/pulls/42', 'https://github.com.evil/owner/repo/pull/42']) {
    assert.deepEqual(run(base, { value }).output, {}, 'Other providers never invoke gh or mask their watcher results');
    assert.deepEqual(run(base, { field: 'PRs', value }).output, {}, 'Foreign-only plural fields are ignored');
  }
  for (const value of ['https://github.com/owner/repo/pull/42?x=1', 'https://github.com/owner/repo/pull/42/extra',
    'https://github.com/owner/repo/pull/42;echo SECRET', null]) {
    assert.equal(run(base, { value }).output.state, 'error');
  }
});

test('PR parser canonicalizes safe bounded links and combines notes without mutation', () => {
  const url = 'https://github.com/owner/repo/pull/42';
  assert.deepEqual(parsePullRequests(`- [PR](${url}/)\n${url.toUpperCase()}\n${url}`), [{ url, number: '42', label: 'PR' }]);
  for (const value of [undefined, '', `${url}?query`, `${url}#hash`, `${url}/extra`,
    'http://github.com/owner/repo/pull/1', 'https://github.com.evil/owner/repo/pull/1',
    'https://github.com/owner/../pull/1', 'https://github.com/-owner/repo/pull/1',
    'https://github.com/owner/repo/pull/0', 'https://github.com/owner/repo/pull/01',
    'https://github.com/owner/repo/pull/9007199254740992',
    'https://github.com/owner/repo/pull/1;echo', 'https://github.com/owner/repo%2Fbad/pull/1',
    `${url} ${url}`, `[PR](${url}) trailing`]) assert.deepEqual(parsePullRequests(value), []);
  assert.deepEqual(parsePullRequests(`${url}\nhttps://forgejo.example/git/owner/repo/pulls/43\nhttp://127.0.0.1:3000/owner/repo/pulls/44`).map((pr) => pr.number), ['42', '43', '44']);
  assert.equal(parsePullRequests('https://github.com/owner/repo/pull/9007199254740991')[0].number, '9007199254740991');
  assert.equal(parsePullRequests(Array.from({ length: 70 }, (_, i) => `https://github.com/owner/repo/pull/${i + 1}`).join('\n')).length, 64);
  const notes = { PRs: `${url}\nhttps://github.com/owner/repo/pull/43`, PR: url, Other: 'untouched' };
  const before = { ...notes };
  assert.equal(pullRequestValues(notes), `${notes.PRs}\n${notes.PR}`);
  assert.equal(parsePullRequests(pullRequestValues(notes)).length, 2);
  assert.deepEqual(notes, before);
  assert.equal(pullRequestValues({}), undefined);
  assert.equal(pullRequestValues({ PR: url }), url);
  assert.equal(parsePullRequests(pullRequestValues({ PRs: url, PR: `[Review](${url})` }))[0].label, 'Review', 'A bare alias does not discard the legacy Markdown label');
});


test('PRs deadline bounds concurrency and returns queued errors without losing success', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'field-handler-deadline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gh = join(directory, 'gh');
  const log = join(directory, 'calls');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const number = process.argv[4];
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ number, time: Date.now() }) + '\\n');
if (number === '1') {
  process.stdout.write(JSON.stringify({ state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: [], headRefOid: 'a'.repeat(40) }));
} else {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`);
  chmodSync(gh, 0o700);
  const script = fileURLToPath(new URL('../watchers/github-pr.mjs', import.meta.url));
  const started = Date.now();
  const result = spawnSync(script, [], {
    input: JSON.stringify({ version: 1, event: 'check', taskId: 1, field: 'PRs',
      value: Array.from({ length: 12 }, (_, i) => `https://github.com/owner/repo/pull/${i + 1}`).join('\n'),
      previousValue: null, eventId: 'deadline' }),
    encoding: 'utf8', timeout: 29_000,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.ok(Date.now() - started < 29_000);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, 'multiple');
  assert.equal(output.items.length, 12);
  assert.equal(output.items[0].state, 'merged');
  assert.ok(output.items.slice(1).every((item: { state: string }) => item.state === 'error'));
  assert.equal(output.recheckAfterSeconds, 60);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 9); // one fast success, four 20s timeouts, four aborted at 25s
  assert.equal(calls.filter((call) => call.time - started < 19_000).length, 5);
});
