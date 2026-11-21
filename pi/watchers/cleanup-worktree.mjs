#!/usr/bin/env node
// Removes a completed task's recorded Git worktree. Git itself refuses the main
// working tree and dirty or locked worktrees: nothing is forced, no branch is deleted.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = async (...args) => (await run('git', args, { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const kept = (reason) => ({ state: 'kept', summary: `Worktree kept: ${reason}` });

export async function handleTaskEvent(event) {
  if (event?.scope !== 'task' || event.event !== 'completed') return {};
  // The exact recorded value: a repaired path could name another worktree.
  const recorded = event.fields?.Worktree, directory = event.params?.dir;
  if (typeof recorded !== 'string' || !isAbsolute(recorded)) return {};
  if (typeof directory !== 'string' || !isAbsolute(directory)) return kept('no worktrees directory is configured');
  let path, root;
  try { [path, root] = await Promise.all([realpath(recorded), realpath(directory)]); }
  catch { return kept('it or the worktrees directory no longer exists'); }
  const inside = relative(root, path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return kept('it is outside the worktrees directory');
  try {
    // Run from the repository, not from the directory being removed.
    const repository = await git('-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    await git('--git-dir', repository, 'worktree', 'remove', path);
  } catch { return kept('Git refused; it may be changed, locked or not a linked worktree'); }
  return { state: 'removed', summary: 'Worktree removed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
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
