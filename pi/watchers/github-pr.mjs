#!/usr/bin/env node
// Configure this executable as a field-event handler. Requires authenticated `gh`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parsePullRequests } from '../pull-requests.ts';
import { checkPRBatch } from '../pr-batch.ts';

const run = promisify(execFile);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorResult = () => ({ state: 'error', summary: 'Unable to check PR status', recheckAfterSeconds: 120 });

function validateResponse(pr) {
  if (!object(pr) || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
    || !['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable)
    || typeof pr.headRefOid !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(pr.headRefOid)
    || !Array.isArray(pr.statusCheckRollup)) throw new Error('Invalid response');
  return pr.statusCheckRollup.map((check) => {
    if (!object(check)) throw new Error('Invalid check');
    if (check.__typename === 'CheckRun') {
      if (typeof check.name !== 'string' || !check.name
        || !['COMPLETED', 'IN_PROGRESS', 'QUEUED', 'REQUESTED', 'WAITING', 'PENDING'].includes(check.status)
        || !(check.conclusion === null || ['', 'SUCCESS', 'NEUTRAL', 'SKIPPED', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'].includes(check.conclusion))
        || (check.status === 'COMPLETED' && !check.conclusion)
        || (check.status !== 'COMPLETED' && check.conclusion)) throw new Error('Invalid check run');
      const failed = check.status === 'COMPLETED' && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion);
      return { failed, pending: check.status !== 'COMPLETED', fingerprint: ['CheckRun', check.name, check.status, check.conclusion] };
    }
    if (check.__typename === 'StatusContext') {
      if (typeof check.context !== 'string' || !check.context
        || !['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'].includes(check.state)) throw new Error('Invalid status context');
      return { failed: ['ERROR', 'FAILURE'].includes(check.state), pending: ['EXPECTED', 'PENDING'].includes(check.state), fingerprint: ['StatusContext', check.context, check.state] };
    }
    throw new Error('Unknown check type');
  });
}

export async function handleFieldEvent(event) {
  if (!object(event) || event.version !== 1 || !['added', 'changed', 'removed', 'check'].includes(event.event)
    || !Number.isSafeInteger(event.taskId) || typeof event.field !== 'string'
    || !(event.value === null || typeof event.value === 'string')
    || !(event.previousValue === null || typeof event.previousValue === 'string')
    || typeof event.eventId !== 'string'
    || (event.previousResult !== undefined && !object(event.previousResult))) throw new Error('Invalid event');
  if (!['PR', 'PRs'].includes(event.field) || event.event === 'removed') return {};
  const parsed = parsePullRequests(event.value ?? undefined);
  const requests = parsed.filter((pr) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//.test(pr.url));
  if (event.field === 'PR') {
    const value = event.value?.trim() ?? '';
    const url = /^\[[^\]\r\n]*\]\(([^\s()]+)\)$/.exec(value)?.[1] ?? value;
    try { if (new URL(url).hostname !== 'github.com') return {}; } catch { /* Invalid GitHub values remain errors. */ }
    if (requests.length !== 1) return errorResult();
    return checkPullRequest(requests[0], AbortSignal.timeout(25_000));
  }
  if (!requests.length && event.value?.trim()) return {};
  return checkPRBatch(event, requests, checkPullRequest, errorResult);
}

async function checkPullRequest({ url, number }, signal) {
  const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//.exec(url);
  signal.throwIfAborted();
  const execution = run('gh', ['pr', 'view', number, '--repo', `${owner}/${repo}`, '--json', 'state,mergeable,statusCheckRollup,headRefOid'], { timeout: 20_000, signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' });
  // execFile's signal cancellation uses SIGTERM independently of its timeout killSignal.
  const abort = () => execution.child.kill('SIGKILL');
  signal.addEventListener('abort', abort, { once: true });
  let stdout;
  try {
    ({ stdout } = await execution);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  const pr = JSON.parse(stdout);
  const checks = validateResponse(pr);
  const summary = `PR #${number}`;
  if (pr.state === 'MERGED') return { state: 'merged', summary: `${summary} merged`, display: { strikethrough: false, color: 'accent' } };
  if (pr.state === 'CLOSED') return { state: 'closed', summary: `${summary} closed`, display: { strikethrough: false, color: 'muted' } };
  const conflict = pr.mergeable === 'CONFLICTING';
  const failed = checks.filter((check) => check.failed);
  if (conflict || failed.length) {
    const state = conflict ? 'conflict' : 'failed';
    const fingerprint = createHash('sha256').update(JSON.stringify([
      pr.headRefOid.toLowerCase(), state,
      failed.map((check) => JSON.stringify(check.fingerprint)).sort(),
    ])).digest('hex');
    return { state, summary: `${summary} ${conflict ? 'has merge conflicts' : 'checks failed'}`,
      display: { strikethrough: false, color: 'error' },
      notification: { key: `pr:${owner}/${repo}:${number}:${fingerprint}`, message: conflict ? 'PR has merge conflicts' : 'PR checks failed' },
      recheckAfterSeconds: 60 };
  }
  const pending = pr.mergeable === 'UNKNOWN' || checks.length === 0 || checks.some((check) => check.pending);
  return { state: pending ? 'pending' : 'passing', summary: `${summary} ${pending ? 'checks pending' : 'checks passing'}`,
    display: { strikethrough: false, color: pending ? 'warning' : 'success' }, recheckAfterSeconds: 60 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Input too large');
    }
    process.stdout.write(`${JSON.stringify(await handleFieldEvent(JSON.parse(input)))}\n`);
  } catch {
    process.stderr.write('PR field handler failed\n');
    process.stdout.write(`${JSON.stringify(errorResult())}\n`);
  }
}
