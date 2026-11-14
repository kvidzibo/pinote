import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { FieldResult } from '../mcp/field-events.ts';

test('Forgejo executable trusts configured instances only and checks complete current-head statuses', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forgejo-watcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'pi-note.json');
  const requestsFile = join(dir, 'requests.json');
  const preload = join(dir, 'fetch.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
const scenario = JSON.parse(process.env.SCENARIO);
const requests = []; let pulls = 0;
globalThis.fetch = async (url, options) => {
  requests.push({url, headers:options.headers, redirect:options.redirect, timed:!!options.signal});
  writeFileSync(process.env.REQUESTS_FILE, JSON.stringify(requests));
  if (scenario.fail) throw new Error('SECRET credential');
  if (scenario.httpStatus) return new Response('SECRET credential', {status:scenario.httpStatus});
  if (scenario.oversize) return new Response('x'.repeat(1024 * 1024 + 1));
  if (scenario.raw !== undefined) return new Response(scenario.raw);
  const page = /[?&]page=(\\d+)/.exec(url)?.[1];
  const body = page ? scenario.pages[Number(page)-1] ?? {statuses:null,total_count:0} : scenario.pulls[Math.min(pulls++,scenario.pulls.length-1)];
  return new Response(JSON.stringify(body));
};`);
  const script = fileURLToPath(new URL('../watchers/forgejo-pr.mjs', import.meta.url));
  const base = 'https://forgejo.example/git';
  const value = `${base}/owner/repo/pulls/42`;
  const event = { version: 1, event: 'added', taskId: 1, field: 'PR', value, previousValue: null, eventId: 'event-1' };
  const pr = { state: 'open', merged: false, mergeable: true, head: { sha: 'a'.repeat(40) } };
  const check = { context: 'CI untrusted SECRET', status: 'success' };
  const page = (statuses: object[]) => ({ sha: pr.head.sha, total_count: statuses.length, statuses });
  const trusted = [{ url: base, tokenEnv: 'TEST_FORGEJO_TOKEN' }];
  function run(scenario: object = {}, patch: object = {}, entries: unknown = trusted, token = 'SECRET') {
    writeFileSync(config, JSON.stringify({ forgejoInstances: entries }));
    rmSync(requestsFile, { force: true });
    const result = spawnSync(script, [], {
      input: JSON.stringify({ ...event, ...patch }), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, TEST_FORGEJO_TOKEN: token,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, REQUESTS_FILE: requestsFile,
        SCENARIO: JSON.stringify({ pulls: [pr], pages: [page([check])], ...scenario }) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET|credential|untrusted/);
    let requests: any[] = [];
    try { requests = JSON.parse(readFileSync(requestsFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { output: FieldResult.parse(JSON.parse(result.stdout)), requests, stderr: result.stderr };
  }
  const passing = run({}, { event: 'check', value: `[PR](${value})` });
  assert.equal(passing.output.state, 'passing');
  assert.deepEqual(passing.requests.map((r) => r.url), [
    `${base}/api/v1/repos/owner/repo/pulls/42`,
    `${base}/api/v1/repos/owner/repo/commits/${pr.head.sha}/status?page=1&limit=50`,
    `${base}/api/v1/repos/owner/repo/commits/${pr.head.sha}/status?page=2&limit=50`,
    `${base}/api/v1/repos/owner/repo/pulls/42`,
  ]);
  assert.ok(passing.requests.every((r) => r.headers.Authorization === 'token SECRET' && r.redirect === 'error' && r.timed));
  for (const origin of ['https://forgejo.example:443/git', 'https://forgejo.example:8443/git', 'https://FORGEJO.example:443',
    'http://127.0.0.1:3000', 'http://127.0.0.1:3000/git', 'http://[::1]:3000/git']) {
    const { output, requests } = run({}, { value: `${origin}/owner/repo/pulls/42` }, [{ url: origin, tokenEnv: 'TEST_FORGEJO_TOKEN' }]);
    assert.equal(output.state, 'passing');
    assert.ok(requests.every((r) => r.url.startsWith(`${new URL(origin).href.replace(/\/$/, '')}/api/v1/`) && r.headers.Authorization === 'token SECRET'));
  }
  assert.equal(run({}, { value: value.replace('forgejo.example', 'forgejo.example:443') }).output.state, 'passing');
  assert.equal(run({}, {}, [{ url: base.replace('forgejo.example', 'forgejo.example:443') }]).output.state, 'passing');
  const anonymous = run({}, {}, [{ url: base }]);
  assert.ok(anonymous.requests.every((r) => !r.headers.Authorization));
  const failureScenario = { pages: [page([check]), page([{ ...check, context: 'other', status: 'failure' }])] };
  const failure = run(failureScenario).output;
  assert.equal(failure.state, 'failed', 'Server-capped pages and per-page totals cannot hide a later failure');
  assert.equal(failure.display?.color, 'warning');
  assert.equal(failure.recheckAfterSeconds, 60);
  assert.equal(run(failureScenario, { previousResult: failure }).output.notification?.key, failure.notification?.key);
  assert.notEqual(run(failureScenario, { value: value.replace('forgejo.example', 'other.example') },
    [{ url: base.replace('forgejo.example', 'other.example') }]).output.notification?.key, failure.notification?.key);
  const moved = { ...pr, head: { sha: 'b'.repeat(40) } };
  assert.notEqual(run({ pulls: [moved], pages: [{ ...page([{ ...check, status: 'failure' }]), sha: moved.head.sha }] }).output.notification?.key,
    run({ pages: [page([{ ...check, status: 'failure' }])] }).output.notification?.key);
  const stale = run({ ...failureScenario, pulls: [pr, moved] }).output;
  assert.equal(stale.state, 'pending');
  assert.equal(stale.notification, undefined, 'A changed head never triggers an obsolete failure');
  for (const status of ['pending', 'error', 'failure', 'warning', 'success', 'skipped']) {
    assert.equal(run({ pages: [page([{ ...check, status }])] }).output.state,
      ['error', 'failure', 'warning'].includes(status) ? 'failed' : status === 'pending' ? 'pending' : 'passing');
  }
  assert.equal(run({ pages: [] }).output.state, 'pending');
  const unmergeable = run({ pulls: [{ ...pr, mergeable: false }] }).output;
  assert.equal(unmergeable.state, 'pending');
  assert.equal(unmergeable.notification, undefined, 'False mergeability is not definitive conflict evidence');
  for (const merged of [false, true]) {
    const terminal = { ...pr, state: 'closed', merged };
    for (const response of [terminal, { state: 'closed', merged, head: { sha: '' } }, { state: 'closed', merged, head: null }]) {
      for (const pulls of [[response], [pr, response]]) {
        const { output, requests } = run({ pulls });
        assert.equal(output.state, merged ? 'merged' : 'closed');
        assert.equal(output.display?.strikethrough, false);
        assert.equal(output.display?.color, merged ? 'accent' : 'muted');
        assert.equal(output.recheckAfterSeconds, undefined);
        assert.equal(output.notification, undefined);
        if (pulls.length === 1) assert.equal(requests.length, 1, 'Terminal PRs need no commit-status request');
      }
    }
  }
  for (const scenario of [{ fail: true }, { httpStatus: 401 }, { httpStatus: 302 }, { raw: 'SECRET not JSON' },
    { oversize: true }, { pulls: [{}] }, { pulls: [{ ...pr, head: { sha: 'invalid' } }] },
    { pages: [{}] }, { pages: [{ statuses: [], total_count: 1 }] }, { pages: [page([{ ...check, status: 'bogus' }])] },
    { pages: [{ ...page([check]), sha: moved.head.sha }] }, { pages: [page([check]), page([check])] },
    { pages: Array.from({ length: 21 }, (_, i) => page([{ ...check, context: `CI ${i}` }])) }]) {
    const { output, stderr } = run(scenario);
    assert.deepEqual(output, { state: 'error', summary: 'Unable to check Forgejo PR status', recheckAfterSeconds: 120 });
    assert.equal(stderr, 'Forgejo PR field handler failed\n');
  }
  for (const origin of ['http://forgejo.example', 'http://localhost:3000', 'http://localhost.localdomain:3000',
    'http://127.0.0.2:3000', 'http://192.168.1.1:3000', 'http://[::2]:3000', 'http://127.0.0.1.evil:3000']) {
    const { output, requests } = run({}, {}, [{ url: origin }]);
    assert.equal(output.state, 'error', `Non-loopback HTTP configuration must be rejected: ${origin}`);
    assert.equal(requests.length, 0);
    const untrusted = run({}, { value: `${origin}/owner/repo/pulls/42` });
    assert.deepEqual(untrusted.output, {});
    assert.equal(untrusted.requests.length, 0);
  }
  const localBase = 'http://127.0.0.1:3000/git';
  for (const candidate of ['http://127.0.0.1:3001/git', 'http://[::1]:3000/git',
    'http://127.0.0.1:3000/git-other', 'http://user:SECRET@127.0.0.1:3000/git']) {
    const { output, requests } = run({}, { value: `${candidate}/owner/repo/pulls/42` }, [{ url: localBase, tokenEnv: 'TEST_FORGEJO_TOKEN' }]);
    assert.deepEqual(output, {});
    assert.equal(requests.length, 0, 'Loopback HTTP still requires the exact configured instance scope');
  }
  for (const entries of [null, {}, [{ url: 'http://forgejo.example' }], [{ url: `${base}/../evil` }],
    [{ url: base, tokenEnv: 'bad-name' }], [{ url: base, token: 'SECRET' }], [...trusted, ...trusted]]) {
    const { output, requests } = run({}, {}, entries);
    assert.equal(output.state, 'error');
    assert.equal(requests.length, 0);
  }
  assert.equal(run({}, {}, trusted, '').output.state, 'error');
  for (const patch of [{ field: 'Other' }, { event: 'removed' }, ...[
    'https://github.com/owner/repo/pull/42', 'https://untrusted.example/owner/repo/pulls/42',
    'https://forgejo.example.evil/git/owner/repo/pulls/42', 'https://forgejo.example/git-other/owner/repo/pulls/42',
    'https://user:SECRET@forgejo.example/git/owner/repo/pulls/42',
    `${value}?x=1`, `${value}#fragment`, `${value}/extra`, `${value}\u001b[31m`,
    `${base}/owner/../pulls/42`, `${base}/owner/%2e%2e/pulls/42`, `${base}/owner/repo/pulls/9007199254740992`, null,
  ].map((value) => ({ value }))]) {
    const { output, requests } = run({}, patch);
    assert.deepEqual(output, {});
    assert.equal(requests.length, 0, 'Untrusted values cannot cause authenticated requests');
  }
  assert.deepEqual(run({}, {}, []).output, {});
});

test('Forgejo loopback HTTP uses native fetch, configured API scope and token without following redirects', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forgejo-http-'));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousToken = process.env.TEST_FORGEJO_HTTP_TOKEN;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousToken === undefined) delete process.env.TEST_FORGEJO_HTTP_TOKEN;
    else process.env.TEST_FORGEJO_HTTP_TOKEN = previousToken;
    rmSync(dir, { recursive: true, force: true });
  });
  const sha = 'c'.repeat(40);
  const api = '/git/api/v1/repos/tomas/production-deploy';
  const pullPath = `${api}/pulls/135`;
  const statusPath = `${api}/commits/${sha}/status`;
  const requests: { path: string | undefined; token: string | undefined; accept: string | undefined }[] = [];
  let mode: 'passing' | 'merged' | 'redirect' = 'passing';
  const server = createServer((req, res) => {
    requests.push({ path: req.url, token: req.headers.authorization, accept: req.headers.accept });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'redirect' && req.url === pullPath) {
      res.writeHead(302, { Location: '/redirect-target' });
      res.end('{}');
    } else if (req.url === pullPath) {
      res.end(JSON.stringify(mode === 'merged' ? { state: 'closed', merged: true, head: null }
        : { state: 'open', merged: false, mergeable: true, head: { sha } }));
    } else if (req.url === `${statusPath}?page=1&limit=50`) {
      res.end(JSON.stringify({ sha, total_count: 1, statuses: [{ context: 'CI', status: 'success' }] }));
    } else if (req.url === `${statusPath}?page=2&limit=50`) {
      res.end(JSON.stringify({ sha, total_count: 0, statuses: [] }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/git`;
  writeFileSync(join(dir, 'pi-note.json'), JSON.stringify({
    forgejoInstances: [{ url: base, tokenEnv: 'TEST_FORGEJO_HTTP_TOKEN' }],
  }));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.TEST_FORGEJO_HTTP_TOKEN = 'fake-loopback-only-token';
  const { handleFieldEvent } = await import(new URL('../watchers/forgejo-pr.mjs', import.meta.url).href);
  const event = { version: 1, event: 'check', taskId: 1, field: 'PR',
    value: `[PR](${base}/tomas/production-deploy/pulls/135)`, previousValue: null, eventId: 'local-http' };
  const passing = FieldResult.parse(await handleFieldEvent(event));
  assert.equal(passing.state, 'passing');
  assert.equal(passing.summary, 'PR #135 checks passing');
  assert.deepEqual(requests.map((r) => r.path), [pullPath,
    `${statusPath}?page=1&limit=50`, `${statusPath}?page=2&limit=50`, pullPath]);
  assert.ok(requests.every((r) => r.token === 'token fake-loopback-only-token' && r.accept === 'application/json'));

  requests.length = 0;
  mode = 'merged';
  const merged = FieldResult.parse(await handleFieldEvent(event));
  assert.equal(merged.state, 'merged');
  assert.equal(merged.recheckAfterSeconds, undefined);
  assert.equal(merged.notification, undefined);
  assert.deepEqual(requests.map((r) => r.path), [pullPath], 'Merged PRs do not fetch commit statuses');

  requests.length = 0;
  mode = 'redirect';
  await assert.rejects(() => handleFieldEvent(event));
  assert.deepEqual(requests.map((r) => r.path), [pullPath], 'Native fetch must not follow the redirect even on the local server');
});
