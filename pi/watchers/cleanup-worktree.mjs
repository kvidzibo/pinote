#!/usr/bin/env node
// Removes a completed task's recorded Git worktrees. Git itself refuses the main
// working tree and dirty or locked worktrees: nothing is forced, no branch is deleted.
// Ignored files (dependencies, build output, local configuration) go with the worktree.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';

const run = promisify(execFile);
const git = async (...args) => (await run('git', args, { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const kept = (reason) => ({ state: 'kept', summary: `Worktree kept: ${reason}` });

async function remove(recorded, root) {
  let path;
  try { path = await realpath(recorded); }
  catch { return kept('it no longer exists'); }
  const inside = relative(root, path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return kept('it is outside the worktrees directory');
  try {
    // Run from the repository, not from the directory being removed.
    const repository = await git('-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    await git('--git-dir', repository, 'worktree', 'remove', path);
  } catch { return kept('Git refused; it may be changed, locked or not a linked worktree'); }
  return { state: 'removed', summary: 'Worktree removed' };
}

export async function handleTaskEvent(event) {
  if (event?.scope !== 'task' || event.event !== 'completed') return {};
  // Exact recorded values, one per line: a repaired path could name another worktree.
  const recorded = event.fields?.Worktrees, directory = event.params?.dir;
  const paths = typeof recorded === 'string' ? [...new Set(recorded.split(/\r?\n/))].filter((path) => isAbsolute(path)) : [];
  if (!paths.length) return {};
  if (typeof directory !== 'string' || !isAbsolute(directory)) return kept('no worktrees directory is configured');
  let root;
  try { root = await realpath(directory); }
  catch { return kept('the worktrees directory no longer exists'); }
  const results = [];
  for (const path of paths) results.push(await remove(path, root));
  const summaries = [...new Set(results.map((result) => result.summary))];
  const state = results.every((result) => result.state === 'removed') ? 'removed' : 'kept';
  return { state, summary: (paths.length > 1 ? `${results.filter((result) => result.state === 'removed').length} of ${paths.length} removed. ` : '') + summaries.join('; ').slice(0, 900) };
}

// import.meta.main needs Node 22.18/24.2; Node runs the entry point from its real path.
const main = import.meta.main ?? (() => { try { return import.meta.filename === realpathSync(process.argv[1]); } catch { return false; } })();
if (main) {
  try {
    let input = '';
    // Decoded as one stream: a multibyte character can span two reads.
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Input too large');
    }
    process.stdout.write(`${JSON.stringify(await handleTaskEvent(JSON.parse(input)))}\n`);
  } catch {
    process.stderr.write('Worktree cleanup failed\n');
    process.exitCode = 1;
  }
}
