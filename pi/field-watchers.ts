import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FieldWatcherConfig = { path: string; enabled: boolean };
export type FieldWatcher = FieldWatcherConfig & { id: string; name: string; bundled: boolean };
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// tsc emits this module one level below the package root; discovery stays in
// the same shipped package directory in source and compiled entry points.
const bundledDirectory = join(basename(moduleDirectory) === 'dist-mcp' ? dirname(moduleDirectory) : moduleDirectory, 'watchers');
function watcherPath(path: unknown): string {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
    throw new Error('Watcher path must be an absolute executable file path (max 4096 characters)');
  }
  return normalize(path);
}
export function parseFieldWatchers(root: Record<string, unknown>): FieldWatcherConfig[] {
  let entries = root.fieldWatchers;
  if (entries === undefined) entries = root.fieldHandler == null ? [] : [{ path: root.fieldHandler, enabled: false }];
  if (!Array.isArray(entries) || entries.length > 32) throw new Error('fieldWatchers must be an array of at most 32 watchers');
  const seen = new Set<string>();
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => key !== 'path' && key !== 'enabled')) throw new Error('Invalid field watcher');
    const config = entry as Record<string, unknown>;
    const path = watcherPath(config.path);
    if (typeof config.enabled !== 'boolean' || seen.has(path)) throw new Error('Invalid or duplicate field watcher');
    seen.add(path);
    return { path, enabled: config.enabled };
  });
}
/** Validation only: never starts the executable or invokes a shell. */
export function validateWatcherExecutable(path: string): void {
  const canonical = watcherPath(path);
  if (!lstatSync(canonical).isFile()) throw new Error('Watcher must be a regular executable file');
  accessSync(canonical, constants.X_OK);
}
export function discoverFieldWatchers(root: Record<string, unknown>): FieldWatcher[] {
  const stored = parseFieldWatchers(root);
  const bundled = new Set<string>();
  for (const name of readdirSync(bundledDirectory).sort()) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(bundledDirectory, name);
    try { validateWatcherExecutable(path); bundled.add(path); } catch { /* Not a regular executable. */ }
  }
  const merged = [...stored, ...[...bundled].filter((path) => !stored.some((entry) => entry.path === path)).map((path) => ({ path, enabled: false }))];
  if (merged.length > 32) throw new Error('At most 32 discovered field watchers are supported');
  return merged.map((config) => ({ ...config, id: createHash('sha256').update(config.path).digest('hex'), name: basename(config.path) === 'github-pr.mjs' && bundled.has(config.path) ? 'GitHub PR' : basename(config.path, '.mjs'), bundled: bundled.has(config.path) }));
}
