#!/usr/bin/env node
// Configure this executable as a field-event handler. Requires authenticated `gh`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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
  if (event.field !== 'PR' || event.event === 'removed') return {};
  const value = event.value?.trim() ?? '';
  const url = /^\[[^\]\r\n]*\]\(([^\s()]+)\)$/.exec(value)?.[1] ?? value;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  if (!match || ['.', '..'].includes(match[2])) return errorResult();
  const [, owner, repo, number] = match;
  const { stdout } = await run('gh', ['pr', 'view', number, '--repo', `${owner}/${repo}`, '--json', 'state,mergeable,statusCheckRollup,headRefOid'], { timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
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
      display: { strikethrough: false, color: 'warning' },
      notification: { key: `pr:${owner}/${repo}:${number}:${fingerprint}`, message: conflict ? 'PR has merge conflicts' : 'PR checks failed' },
      recheckAfterSeconds: 60 };
  }
  const pending = pr.mergeable === 'UNKNOWN' || checks.length === 0 || checks.some((check) => check.pending);
  return { state: pending ? 'pending' : 'passing', summary: `${summary} ${pending ? 'checks pending' : 'checks passing'}`,
    display: { strikethrough: false, color: pending ? 'muted' : 'success' }, recheckAfterSeconds: 60 };
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
