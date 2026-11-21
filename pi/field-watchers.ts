import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FieldWatcherConfig = { path: string; enabled: boolean; activation?: string };
export type FieldWatcher = FieldWatcherConfig & { id: string; name: string; bundled: boolean };
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// Source: repo/watchers; compiled HTTP service: npm-package/watchers.
const bundledDirectory = join(dirname(moduleDirectory), 'watchers');
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
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => key !== 'path' && key !== 'enabled' && key !== 'activation')) throw new Error('Invalid field watcher');
    const config = entry as Record<string, unknown>;
    const path = watcherPath(config.path);
    if (typeof config.enabled !== 'boolean' || seen.has(path)) throw new Error('Invalid or duplicate field watcher');
    seen.add(path);
    const activation = config.activation;
    if (activation !== undefined && (typeof activation !== 'string' || !/^[0-9a-f-]{36}$/.test(activation))) throw new Error('Invalid watcher activation');
    return { path, enabled: config.enabled, ...(activation ? { activation } : {}) };
  });
}
/** Validation only: never starts the executable or invokes a shell. */
export function validateWatcherExecutable(path: string): void {
  const canonical = watcherPath(path);
  if (!lstatSync(canonical).isFile()) throw new Error('Watcher must be a regular executable file');
  accessSync(canonical, constants.X_OK);
}
export function discoverFieldWatchers(root: Record<string, unknown>, directory = bundledDirectory): FieldWatcher[] {
  const stored = parseFieldWatchers(root);
  const bundled = new Set<string>();
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(directory, name);
    try { validateWatcherExecutable(path); bundled.add(path); } catch { /* Not a regular executable. */ }
  }
  // Preserve legacy/plural PR receipt grouping when Electron runs the explicitly
  // enabled pi-note package copy. Classification grants no execution permission.
  for (const { path } of stored) {
    const folder = dirname(path);
    if (basename(folder) !== 'watchers' || !['github-pr.mjs', 'forgejo-pr.mjs'].includes(basename(path))) continue;
    try {
      const manifest = join(dirname(folder), 'package.json'), info = lstatSync(manifest);
      if (info.isFile() && info.size < 64 * 1024 && JSON.parse(readFileSync(manifest, 'utf8')).name === 'pi-note') bundled.add(path);
    } catch { /* Standalone custom watcher. */ }
  }
  const merged = [...stored, ...[...bundled].filter((path) => !stored.some((entry) => entry.path === path || bundled.has(entry.path) && basename(entry.path) === basename(path))).map((path) => ({ path, enabled: false }))];
  if (merged.length > 32) throw new Error('At most 32 discovered field watchers are supported');
  const names: Record<string, string> = { 'github-pr.mjs': 'GitHub PR', 'forgejo-pr.mjs': 'Forgejo PR' };
  return merged.map((config) => ({ ...config, id: createHash('sha256').update(config.path).digest('hex'), name: bundled.has(config.path) ? names[basename(config.path)] ?? basename(config.path, '.mjs') : basename(config.path, '.mjs'), bundled: bundled.has(config.path) }));
}
