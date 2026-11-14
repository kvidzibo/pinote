#!/usr/bin/env node
// Trusted instances live in the service's pi-note.json; tokens stay in its environment.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAgentDir } from '../dist-mcp/config-path.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorResult = () => ({ state: 'error', summary: 'Unable to check Forgejo PR status', recheckAfterSeconds: 120 });
const unsafe = /[\s\\\u0000-\u001f\u007f-\u009f]/u;
const segment = /^[A-Za-z0-9_.-]+$/;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const states = new Set(['pending', 'success', 'error', 'failure', 'warning', 'skipped']);

function httpsURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || unsafe.test(value)) throw new Error('Invalid URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !value.startsWith(`https://${url.host}/`) && value !== `https://${url.host}`) throw new Error('Invalid URL');
  // Check the raw path before URL normalization can hide traversal.
  const path = value.slice(`https://${url.host}`.length).replace(/\/$/, '');
  if (path && path.slice(1).split('/').some((part) => !segment.test(part) || ['.', '..'].includes(part))) throw new Error('Invalid path');
  return url;
}

async function instances() {
  let root;
  try { root = JSON.parse(await readFile(join(getAgentDir(), 'pi-note.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!object(root)) throw new Error('Invalid configuration');
  const entries = root.forgejoInstances === undefined ? [] : root.forgejoInstances;
  if (!Array.isArray(entries) || entries.length > 32) throw new Error('Invalid instances');
  const seen = new Set();
  return entries.map((entry) => {
    if (!object(entry) || Object.keys(entry).some((key) => !['url', 'tokenEnv'].includes(key))) throw new Error('Invalid instance');
    const url = httpsURL(entry.url).href.replace(/\/$/, '');
    if (seen.has(url) || entry.tokenEnv !== undefined && (typeof entry.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.tokenEnv))) throw new Error('Invalid instance');
    seen.add(url);
    return { url, tokenEnv: entry.tokenEnv };
  }).sort((a, b) => b.url.length - a.url.length);
}

function validatePR(pr) {
  if (!object(pr) || !['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean') throw new Error('Invalid PR');
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
  if (event.field !== 'PR' || event.event === 'removed') return {};
  const value = event.value?.trim() ?? '';
  const raw = /^\[[^\]\r\n]*\]\(([^\s()]+)\)$/.exec(value)?.[1] ?? value;
  let url;
  try { url = httpsURL(raw).href.replace(/\/$/, ''); } catch { return {}; }
  const instance = (await instances()).find((entry) => url.startsWith(`${entry.url}/`));
  if (!instance) return {};
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/([1-9][0-9]*)$/.exec(url.slice(instance.url.length));
  if (!match || !Number.isSafeInteger(Number(match[3]))) return {};
  const [, owner, repo, number] = match;
  const headers = { Accept: 'application/json' };
  if (instance.tokenEnv !== undefined) {
    const token = process.env[instance.tokenEnv];
    if (!token || unsafe.test(token)) throw new Error('Missing token');
    headers.Authorization = `token ${token}`;
  }
  const signal = AbortSignal.timeout(20_000);
  const api = `${instance.url}/api/v1/repos/${owner}/${repo}`;
  async function request(path) {
    // Never follow API redirects or URLs returned by the server with credentials.
    const response = await fetch(`${api}/${path}`, { headers, redirect: 'error', signal });
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
    if (current.merged) return { state: 'merged', summary: `${summary} merged`, display: { strikethrough: true, color: 'muted' } };
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
  const current = validatePR(await request(`pulls/${number}`));
  const finished = terminal(current);
  if (finished) return finished;
  if (current.head.sha.toLowerCase() !== pr.head.sha.toLowerCase()) return {
    state: 'pending', summary: `${summary} head changed; checks pending`, display: { strikethrough: false, color: 'muted' }, recheckAfterSeconds: 60,
  };
  const failed = checks.filter((check) => ['error', 'failure', 'warning'].includes(check.status));
  if (failed.length) {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      instance.url, owner, repo, number, pr.head.sha.toLowerCase(),
      failed.map((check) => JSON.stringify([check.context, check.status])).sort(),
    ])).digest('hex');
    return { state: 'failed', summary: `${summary} checks failed`, display: { strikethrough: false, color: 'warning' },
      notification: { key: `forgejo-pr:${fingerprint}`, message: 'PR checks failed' }, recheckAfterSeconds: 60 };
  }
  // mergeable=false also means checking, errors or drafts: never invent a conflict alert.
  const pending = !current.mergeable || checks.length === 0 || checks.some((check) => check.status === 'pending');
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
    process.stderr.write('Forgejo PR field handler failed\n');
    process.stdout.write(`${JSON.stringify(errorResult())}\n`);
  }
}
