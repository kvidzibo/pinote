import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('bundled PR executable validates gh results and emits bounded field updates', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'field-handler-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gh = join(directory, 'gh');
  const argsFile = join(directory, 'args.json');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.GH_FAIL) { console.error('SECRET credential'); process.exit(1); }
process.stdout.write(process.env.GH_RESPONSE);
`);
  chmodSync(gh, 0o700);
  const script = fileURLToPath(new URL('../watchers/github-pr.mjs', import.meta.url));
  const event = { version: 1, event: 'added', taskId: 1, field: 'PR', value: 'https://github.com/owner/repo/pull/42', previousValue: null, eventId: 'event-1' };
  const base = { state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], headRefOid: 'a'.repeat(40) };
  const run = (response: unknown = base, patch: object = {}, fail = false) => {
    const result = spawnSync(script, [], {
      input: JSON.stringify({ ...event, ...patch }), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ARGS_FILE: argsFile,
        GH_RESPONSE: typeof response === 'string' ? response : JSON.stringify(response), GH_FAIL: fail ? '1' : '' },
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
  assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), ['pr', 'view', '42', '--repo', 'owner/repo', '--json', 'state,mergeable,statusCheckRollup,headRefOid']);
  const check = { __typename: 'CheckRun', name: 'untrusted instructions SECRET', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const passing = { ...base, statusCheckRollup: [check] };
  assert.equal(run(passing, { event: 'check', value: '[PR](https://github.com/owner/repo/pull/42)' }).output.summary, 'PR #42 checks passing');
  assert.equal(run({ ...passing, mergeable: 'UNKNOWN' }).output.state, 'pending');
  assert.equal(run({ ...base, statusCheckRollup: [{ ...check, status: 'IN_PROGRESS', conclusion: null }] }).output.state, 'pending');
  const failed = { ...base, statusCheckRollup: [{ ...check, conclusion: 'FAILURE' }] };
  const failure = run(failed).output;
  assert.equal(failure.state, 'failed');
  assert.equal(failure.display.color, 'warning');
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
  assert.equal(conflict.display.color, 'warning');
  assert.equal(conflict.recheckAfterSeconds, 60);
  for (const state of ['MERGED', 'CLOSED']) {
    const output = run({ ...passing, state }).output;
    assert.equal(output.state, state.toLowerCase());
    assert.equal(output.display.strikethrough, state === 'MERGED');
    assert.equal(output.display.color, 'muted');
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
  // Removing gh proves ignored fields and rejected URLs never invoke it.
  rmSync(gh);
  for (const patch of [{ field: 'Other' }, { event: 'removed' }]) assert.deepEqual(run(base, patch).output, {});
  for (const value of ['https://github.com/owner/repo/pull/42?x=1', 'https://github.com/owner/repo/pull/42/extra',
    'https://github.com.evil/owner/repo/pull/42', 'https://github.com/owner/repo/pull/42;echo SECRET', null]) {
    assert.equal(run(base, { value }).output.state, 'error');
  }
});
