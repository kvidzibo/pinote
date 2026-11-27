#!/usr/bin/env node
// Trusted instances live in pi-note.json; tokens stay in the scheduler's environment.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { getAgentDir } from '../config-path.js';
import { instanceURL, parseInstances } from '../forgejo-instances.js';
import { checkPRBatch, withInterval } from '../pr-batch.js';
import { parsePullRequests } from '../pull-requests.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorResult = () => ({ state: 'error', summary: 'Unable to check Forgejo PR status', recheckAfterSeconds: 120 });
const unsafe = /[\s\\\u0000-\u001f\u007f-\u009f]/u;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const states = new Set(['pending', 'success', 'error', 'failure', 'warning', 'skipped']);

async function instances() {
  let root;
  try { root = JSON.parse(await readFile(join(getAgentDir(), 'pi-note.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!object(root)) throw new Error('Invalid configuration');
  return parseInstances(root.forgejoInstances === undefined ? [] : root.forgejoInstances);
}

function validatePR(pr) {
  if (!object(pr) || !['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean'
    || pr.draft !== undefined && typeof pr.draft !== 'boolean') throw new Error('Invalid PR');
  // Deleted source branches can leave terminal PRs without a resolvable head.
  if (!pr.merged && pr.state === 'open' && (typeof pr.mergeable !== 'boolean'
    || !object(pr.head) || typeof pr.head.sha !== 'string' || !sha.test(pr.head.sha))) throw new Error('Invalid PR');
  return pr;
}

export async function handleFieldEvent(event) {
  if (!object(event) || event.version !== 1 || !['added', 'changed', 'removed', 'check'].includes(event.event)
    || !Number.isSafeInteger(event.taskId) || event.taskId < 1 || typeof event.field !== 'string'
    || !(event.value === null || typeof event.value === 'string')
    || !(event.previousValue === null || typeof event.previousValue === 'string')
    || typeof event.eventId !== 'string'
    || (event.previousResult !== undefined && !object(event.previousResult))) throw new Error('Invalid event');
  if (!['PR', 'PRs'].includes(event.field) || event.event === 'removed') return {};
  const value = event.value?.trim() ?? '';
  if (event.field === 'PRs') {
    const parsed = parsePullRequests(value);
    if (!parsed.length) return {};
    const trusted = await instances();
    const requests = parsed.filter((request) => matchRequest(request.url, trusted));
    if (!requests.length) return {};
    return checkPRBatch(event, requests, (request, signal) => checkPR(matchRequest(request.url, trusted),
      event.previousResult?.items?.find((item) => item.url === request.url), signal), errorResult);
  }
  const raw = /^\[[^\]\r\n]*\]\(([^\s()]+)\)$/.exec(value)?.[1] ?? value;
  // Preserve legacy validation before loading configuration.
  try { instanceURL(raw); } catch { return {}; }
  const request = matchRequest(raw, await instances());
  return request ? withInterval(event, await checkPR(request, event.previousResult)) : {};
}

function matchRequest(raw, trusted) {
  let url;
  try { url = instanceURL(raw).href.replace(/\/$/, ''); } catch { return; }
  const instance = trusted.find((entry) => url.startsWith(`${entry.url}/`));
  if (!instance) return;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/([1-9][0-9]*)$/.exec(url.slice(instance.url.length));
  if (!match || !Number.isSafeInteger(Number(match[3]))) return;
  const [, owner, repo, number] = match;
  return { instance, owner, repo, number };
}

// Forgejo's API reduces conflicts, merge-check errors and checking to mergeable=false, and Actions may not have
// queued its runs yet. Only the same ambiguous observation on two consecutive checks is treated as final.
async function checkPR({ instance, owner, repo, number }, previous, batchSignal) {
  const headers = { Accept: 'application/json' };
  if (instance.tokenEnv !== undefined) {
    const token = process.env[instance.tokenEnv];
    if (!token || unsafe.test(token)) throw new Error('Missing token');
    headers.Authorization = `token ${token}`;
  }
  const timeout = AbortSignal.timeout(20_000);
  const signal = batchSignal ? AbortSignal.any([timeout, batchSignal]) : timeout;
  const api = `${instance.url}/api/v1/repos/${owner}/${repo}`;
  async function request(path, deadline) {
    // Never follow API redirects or URLs returned by the server with credentials.
    const response = await fetch(path ? `${api}/${path}` : api, { headers, redirect: 'error',
      signal: deadline ? AbortSignal.any([signal, AbortSignal.timeout(deadline)]) : signal });
    if (!response.ok) throw new Error('API request failed');
    let body = '';
    let size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1024 * 1024) throw new Error('Response too large');
      body += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  }
  const pr = validatePR(await request(`pulls/${number}`));
  const summary = `PR #${number}`;
  function terminal(current) {
    if (current.merged) return { state: 'merged', summary: `${summary} merged`, display: { strikethrough: false, color: 'accent' } };
    if (current.state === 'closed') return { state: 'closed', summary: `${summary} closed`, display: { strikethrough: false, color: 'muted' } };
  }
  const done = terminal(pr);
  if (done) return done;
  const checks = [];
  const contexts = new Set();
  // JSON total_count/state describe only the current page on some Forgejo versions.
  // Continue to an empty page rather than trusting totals or a server-capped limit.
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Too many status pages');
    const combined = await request(`commits/${pr.head.sha}/status?page=${page}&limit=50`);
    if (!object(combined) || !Number.isSafeInteger(combined.total_count) || combined.total_count < 0
      || !(Array.isArray(combined.statuses) || combined.total_count === 0 && combined.statuses === null)) throw new Error('Invalid statuses');
    const statuses = combined.statuses ?? [];
    if (statuses.length > 50 || combined.total_count < statuses.length || !statuses.length && combined.total_count !== 0) throw new Error('Invalid status count');
    if (!statuses.length) break;
    if (combined.sha?.toLowerCase() !== pr.head.sha.toLowerCase()) throw new Error('Unexpected commit');
    for (const check of statuses) {
      if (!object(check) || typeof check.context !== 'string' || !check.context || check.context.length > 1000
        || !states.has(check.status) || contexts.has(check.context)) throw new Error('Invalid status');
      contexts.add(check.context);
      checks.push({ context: check.context, status: check.status });
    }
  }
  // Failures here matter only if the final snapshot still needs this evidence.
  let repository, runs;
  if (!checks.length && pr.mergeable && !pr.draft) {
    repository = await request('').catch(() => null);
    // Actions publishes each queued job as a commit status; also look for runs that have yet to queue one.
    // An unavailable runs API is no evidence, and its own deadline leaves time for the final read.
    if (repository?.has_actions === true) runs = await request(`actions/runs?head_sha=${pr.head.sha}`
      + '&status=unknown&status=waiting&status=running&status=blocked&limit=1', 5_000).catch(() => undefined);
  }
  // Evidence describes the head it was collected for; decisions use this later snapshot.
  const current = validatePR(await request(`pulls/${number}`));
  const finished = terminal(current);
  if (finished) return finished;
  const pending = (text) => ({ state: 'pending', summary: `${summary} ${text}`, display: { strikethrough: false, color: 'warning' }, recheckAfterSeconds: 60 });
  const passing = (text) => ({ state: 'passing', summary: `${summary} ${text}`, display: { strikethrough: false, color: 'success' }, recheckAfterSeconds: 60 });
  if (current.head.sha.toLowerCase() !== pr.head.sha.toLowerCase()) return pending('head changed; checks pending');
  const failed = checks.filter((check) => ['error', 'failure', 'warning'].includes(check.status));
  if (failed.length) {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      instance.url, owner, repo, number, pr.head.sha.toLowerCase(),
      failed.map((check) => JSON.stringify([check.context, check.status])).sort(),
    ])).digest('hex');
    return { state: 'failed', summary: `${summary} checks failed`, display: { strikethrough: false, color: 'error' },
      notification: { key: `forgejo-pr:${fingerprint}`, message: 'PR checks failed' }, recheckAfterSeconds: 60 };
  }
  // One-time observations name their head, so a later check confirms them only for the same commit.
  const head = `(head ${pr.head.sha.toLowerCase().slice(0, 12)})`;
  if (checks.some((check) => check.status === 'pending')) return pending('checks pending');
  if (current.draft) return pending('is a draft');
  if (!current.mergeable) {
    const fingerprint = createHash('sha256').update(JSON.stringify(['conflict', instance.url, owner, repo, number, pr.head.sha.toLowerCase()])).digest('hex');
    const notification = { key: `forgejo-pr:${fingerprint}`, message: 'PR is not mergeable (conflict or merge check error)' };
    // The alert key binds a confirmed conflict to this head; a new push is checked afresh.
    if (previous?.notification?.key !== notification.key && previous?.summary !== `${summary} checking mergeability ${head}`) return pending(`checking mergeability ${head}`);
    return { state: 'conflict', summary: `${summary} not mergeable`, display: { strikethrough: false, color: 'error' }, notification, recheckAfterSeconds: 60 };
  }
  if (checks.length) return passing('checks passing');
  // Mergeability changed during the check: no Actions evidence was collected.
  if (repository === undefined) return pending('checks pending');
  if (!object(repository) || typeof repository.has_actions !== 'boolean') throw new Error('Invalid repository');
  if (!repository.has_actions) return passing('has no checks');
  // Any active, uncounted or unrecognized run evidence never lets a PR pass without checks.
  if (!object(runs) || !Array.isArray(runs.workflow_runs) || runs.workflow_runs.length || runs.total_count !== 0) return pending('checks pending');
  const confirmed = [`${summary} awaiting checks ${head}`, `${summary} has no checks ${head}`].includes(previous?.summary);
  return confirmed ? passing(`has no checks ${head}`) : pending(`awaiting checks ${head}`);
}

// import.meta.main needs Node 22.18/24.2; Node runs the entry point from its real path.
const main = import.meta.main ?? (() => { try { return import.meta.filename === realpathSync(process.argv[1]); } catch { return false; } })();
if (main) {
  let event;
  try {
    let input = '';
    // Decoded as one stream: a multibyte character can span two reads.
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Input too large');
    }
    process.stdout.write(`${JSON.stringify(await handleFieldEvent(event = JSON.parse(input)))}\n`);
  } catch {
    process.stderr.write('Forgejo PR field handler failed\n');
    process.stdout.write(`${JSON.stringify(withInterval(event, errorResult()))}\n`);
  }
}
