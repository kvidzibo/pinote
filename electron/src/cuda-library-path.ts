import type { Stats } from 'node:fs';
import { lstat, opendir, readlink, statfs } from 'node:fs/promises';

const CUDA_LIBRARY_PATH = '/usr/local/cuda/lib64';
const MAX_OPERATIONS = 16_384;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_SYMLINKS = 40;
const MAX_PATH_BYTES = 4095;
const PROC_SUPER_MAGIC = 0x9fa0;

interface Budget { remaining: number }
interface Directory { kind: 'directory'; path: string }
type Entry = Directory | { kind: 'file' };

const ROOT: Directory = { kind: 'directory', path: '/' };

function reject(): never {
  throw new Error('Untrusted CUDA library path');
}

function spend(budget: Budget): void {
  if (budget.remaining <= 0) reject();
  budget.remaining--;
}

async function rootOwnedStat(path: string, work: Budget): Promise<Stats> {
  spend(work);
  const info = await lstat(path);
  if (info.uid !== 0) reject();
  return info;
}

// The parent path has already been verified and contains no symlink components.
async function inspectChild(parent: Directory, name: string, work: Budget, links: Budget): Promise<Entry> {
  // Node decodes names as UTF-8; do not mistake an undecodable name for another entry.
  if (name === '..' || name.includes('\uFFFD')) reject();
  const path = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) reject();
  const info = await rootOwnedStat(path, work);

  if (info.isSymbolicLink()) {
    // Linux ignores symlink mode bits. Trust the link's owner and its verified parent.
    spend(links);
    spend(work);
    // procfs magic links need not resolve to the textual path returned by readlink.
    if ((await statfs(parent.path)).type === PROC_SUPER_MAGIC) reject();
    spend(work);
    return resolvePath(parent, await readlink(path), work, links);
  }

  if ((info.mode & 0o022) !== 0) reject();
  if (info.isDirectory()) return { kind: 'directory', path };
  if (info.isFile()) return { kind: 'file' };
  return reject();
}

async function resolvePath(parent: Directory, path: string, work: Budget, links: Budget): Promise<Entry> {
  if (path.length === 0 || Buffer.byteLength(path) > MAX_PATH_BYTES) reject();
  const absolute = path.startsWith('/');
  let entry: Entry = absolute ? ROOT : parent;
  for (const name of (absolute ? path.slice(1) : path).split('/')) {
    // Even a trailing slash or dot requires the preceding component to be a directory.
    if (entry.kind !== 'directory') reject();
    if (name === '' || name === '.') continue;
    entry = await inspectChild(entry, name, work, links);
  }
  return entry;
}

async function checkDirectory(directory: Directory, work: Budget, ancestors: Set<string>): Promise<void> {
  if (ancestors.size >= MAX_DIRECTORY_DEPTH || ancestors.has(directory.path)) reject();
  spend(work);
  const handle = await opendir(directory.path);
  ancestors.add(directory.path);
  try {
    // Stream entries so a large directory cannot force an unbounded allocation.
    while (true) {
      spend(work);
      const item = await handle.read();
      if (item === null) break;
      const entry = await inspectChild(directory, item.name, work, { remaining: MAX_SYMLINKS });
      if (entry.kind === 'directory') await checkDirectory(entry, work, ancestors);
    }
  } finally {
    ancestors.delete(directory.path);
    await handle.close();
  }
}

// Validate metadata only. This assumes trusted system mounts and no privileged
// modifications to the installation during validation or before the loader uses it.
export async function trustedCudaLibraryPath(value: string): Promise<boolean> {
  if (process.platform !== 'linux' || value !== CUDA_LIBRARY_PATH) return false;
  try {
    const work = { remaining: MAX_OPERATIONS };
    const root = await rootOwnedStat(ROOT.path, work);
    if (!root.isDirectory() || (root.mode & 0o022) !== 0) return false;
    const entry = await resolvePath(ROOT, value, work, { remaining: MAX_SYMLINKS });
    if (entry.kind !== 'directory') return false;
    await checkDirectory(entry, work, new Set<string>());
    return true;
  } catch {
    return false;
  }
}
