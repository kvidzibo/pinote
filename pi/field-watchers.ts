import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseInstances } from './forgejo-instances.js';

export const TASK_EVENTS = ['created', 'edited', 'tagged', 'started', 'completed', 'removed', 'restored', 'scheduled'] as const;
export const FIELD_EVENTS = ['added', 'changed', 'removed'] as const;
/** `startup`: once each time the scheduler's host (the desktop) starts. */
export const APP_EVENTS = ['startup'] as const;
const unique = (items: unknown[]) => new Set(items).size === items.length;
const text = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const taskEvents = z.array(z.enum(TASK_EVENTS)).refine(unique);
const fieldEvents = z.array(z.enum(FIELD_EVENTS)).refine(unique);
const appEvents = z.array(z.enum(APP_EVENTS)).refine(unique);
// Seconds: one invocation's deadline, and the least time between the starts of two invocations.
const timeoutSeconds = z.number().int().min(1).max(600);
const cooldownSeconds = z.number().int().min(0).max(86400);
const limits = { appEvents: appEvents.optional(), timeoutSeconds: timeoutSeconds.optional(), cooldownSeconds: cooldownSeconds.optional() };
const fields = z.array(text(128)).max(64).refine(unique);
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
const rows = z.array(z.record(key, z.string().max(4096))).max(64);
const value = z.union([scalar, rows]);
const Params = z.record(key, value).refine((params) => Object.keys(params).length <= 32);
const Config = z.object({ path: z.unknown(), enabled: z.boolean(), taskEvents: taskEvents.optional(), fieldEvents: fieldEvents.optional(),
  fields: fields.optional(), params: Params.optional(), ...limits }).strict();
const Param = z.object({
  key, label: text(64), type: z.enum(['string', 'number', 'boolean', 'select', 'directory', 'list']),
  options: z.array(text(256)).min(1).max(64).optional(),
  columns: z.array(z.object({ key, label: text(64) }).strict()).min(1).max(8).optional(),
  default: value.optional(), required: z.boolean().optional(), help: text(256).optional(),
  // The value lives in this shared pi-note.json key instead of the watcher entry.
  configKey: z.literal('forgejoInstances').optional(),
}).strict().refine((param) => (param.type === 'select') === (param.options !== undefined)
  && (param.type === 'list') === (param.columns !== undefined) && (!param.configKey || param.type === 'list'));
// `coalesceTaskEvents`: declared by the script, not saved per entry. A newer queued task event replaces the older one.
const Manifest = z.object({ name: text(64).optional(), description: text(256).optional(), taskEvents: taskEvents.optional(), fieldEvents: fieldEvents.optional(), fields: fields.optional(), ...limits,
  coalesceTaskEvents: z.boolean().optional(),
  params: z.array(Param).max(32).refine((params) => unique(params.map((param) => param.key))).optional() }).strict();

export type WatcherParam = z.infer<typeof Param>;
export type WatcherValue = z.infer<typeof value>;
export type FieldWatcherConfig = { path: string; enabled: boolean; taskEvents?: typeof TASK_EVENTS[number][];
  fieldEvents?: typeof FIELD_EVENTS[number][]; fields?: string[]; params?: Record<string, WatcherValue>;
  appEvents?: typeof APP_EVENTS[number][]; timeoutSeconds?: number; cooldownSeconds?: number };
/** Effective settings: saved values, else the script's declared defaults. `config` is the saved entry. */
export type FieldWatcher = Required<FieldWatcherConfig> & { id: string; name: string; bundled: boolean; config: FieldWatcherConfig;
  spec: WatcherParam[]; declared: string; description?: string; problem?: string; coalesceTaskEvents: boolean };
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// Beside this module in the package, and beside the bundle the desktop builds.
const bundledDirectory = join(moduleDirectory, 'watchers');
const names: Record<string, string> = { 'github-pr.mjs': 'GitHub PR', 'forgejo-pr.mjs': 'Forgejo PR' };
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
    const parsed = Config.safeParse(entry);
    if (!parsed.success) throw new Error('Invalid field watcher');
    const path = watcherPath(parsed.data.path);
    if (seen.has(path)) throw new Error('Invalid or duplicate field watcher');
    seen.add(path);
    // JSON round trip drops the keys left undefined.
    return JSON.parse(JSON.stringify({ ...parsed.data, path })) as FieldWatcherConfig;
  });
}
/** Validation only: never starts the executable or invokes a shell. */
export function validateWatcherExecutable(path: string): void {
  const canonical = watcherPath(path);
  if (!lstatSync(canonical).isFile()) throw new Error('Watcher must be a regular executable file');
  accessSync(canonical, constants.X_OK);
}
/** `<script name>.params.json` beside the script declares its name, defaults and parameters. Read, never executed. */
function readManifest(path: string): z.infer<typeof Manifest> | string | undefined {
  const file = join(dirname(path), `${basename(path).replace(/\.[^.]+$/, '')}.params.json`);
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Unsupported file');
    return Manifest.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch { return `Invalid ${basename(file)}`; }
}
function paramProblem(param: WatcherParam, current: WatcherValue | undefined): string | undefined {
  if (current === undefined || current === '' || Array.isArray(current) && !current.length) return param.required ? `Needs parameter: ${param.label}` : undefined;
  const valid = param.type === 'number' ? typeof current === 'number'
    : param.type === 'boolean' ? typeof current === 'boolean'
    : param.type === 'select' ? typeof current === 'string' && param.options!.includes(current)
    : param.type === 'directory' ? typeof current === 'string' && isAbsolute(current)
    : param.type === 'list' ? Array.isArray(current) && current.every((row) => Object.keys(row).every((column) => param.columns!.some((c) => c.key === column)))
    : typeof current === 'string';
  return valid ? undefined : `Invalid parameter: ${param.label}`;
}
/** What a watcher uses for keys its saved entry leaves out. Scripts without a declaration keep receiving every field event. */
const defaults = (manifest: z.infer<typeof Manifest> | undefined) => ({
  taskEvents: manifest?.taskEvents ?? [], fieldEvents: manifest?.fieldEvents ?? (manifest ? [] : [...FIELD_EVENTS]), fields: manifest?.fields ?? [],
  appEvents: manifest?.appEvents ?? [], timeoutSeconds: manifest?.timeoutSeconds ?? 30, cooldownSeconds: manifest?.cooldownSeconds ?? 0,
});
export function discoverFieldWatchers(root: Record<string, unknown>): FieldWatcher[] {
  const stored = parseFieldWatchers(root);
  const bundled = new Set<string>();
  for (const name of readdirSync(bundledDirectory).sort()) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(bundledDirectory, name);
    try { validateWatcherExecutable(path); bundled.add(path); } catch { /* Not a regular executable. */ }
  }
  // Unconfigured bundled watchers fill only the room left: a new bundled script cannot invalidate a full configuration.
  // Copies of saved scripts (same file name and declaration), which the desktop hides, go last.
  const copy = (path: string) => { const read = readManifest(path); return `${basename(path)}\0${JSON.stringify(typeof read === 'string' ? null : read ?? null)}`; };
  const saved = new Set(stored.map((entry) => copy(entry.path)));
  const unconfigured = [...bundled].filter((path) => !stored.some((entry) => entry.path === path))
    .sort((a, b) => Number(saved.has(copy(a))) - Number(saved.has(copy(b))));
  const merged = [...stored, ...unconfigured.map((path) => ({ path, enabled: false }))].slice(0, 32);
  return merged.map((config: FieldWatcherConfig) => {
    const read = readManifest(config.path), manifest = typeof read === 'string' ? undefined : read;
    const spec = manifest?.params ?? [], params: Record<string, WatcherValue> = { ...config.params };
    let problem = typeof read === 'string' ? read : undefined;
    for (const param of spec) {
      if (param.configKey) {
        const shared = rows.safeParse(root[param.configKey] ?? []);
        if (shared.success) params[param.key] = shared.data; else problem ??= `Invalid ${param.configKey} in pi-note.json`;
      } else if (params[param.key] === undefined && param.default !== undefined) params[param.key] = param.default;
      problem ??= paramProblem(param, params[param.key]);
    }
    const file = basename(config.path);
    return { ...defaults(manifest), ...config, id: createHash('sha256').update(config.path).digest('hex'), bundled: bundled.has(config.path), config, spec, params, declared: JSON.stringify(manifest ?? null),
      coalesceTaskEvents: manifest?.coalesceTaskEvents ?? false,
      // A custom script cannot take a built-in watcher's name, which selects PR alert handling.
      name: names[file] ?? (manifest?.name && !Object.values(names).includes(manifest.name) ? manifest.name : basename(file, '.mjs')),
      ...(manifest?.description ? { description: manifest.description } : {}), ...(problem ? { problem } : {}) };
  });
}
/** Entries to save for edited watchers: validated against each script's declaration; shared keys are returned separately.
 * Settings equal to the script's defaults are left out, so untouched entries stay readable by versions without them. */
export function watcherEntries(input: unknown): { entries: FieldWatcherConfig[]; shared: Record<string, WatcherValue> } {
  const shared: Record<string, WatcherValue> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const entries = parseFieldWatchers({ fieldWatchers: input }).map((entry) => {
    const read = readManifest(entry.path), manifest = typeof read === 'object' ? read : undefined;
    const params = { ...entry.params };
    for (const param of manifest?.params ?? []) {
      const problem = paramProblem(param, params[param.key]);
      if (entry.enabled && problem) throw new Error(problem);
      if (param.configKey) {
        const value = rows.parse(params[param.key] ?? []);
        // The script refuses the whole list when one instance is invalid.
        try { parseInstances(value); } catch { throw new Error(`Invalid ${param.label}: each needs a different https base URL (http only for 127.0.0.1 or [::1]); a token variable name uses letters, digits and _`); }
        if (shared[param.configKey] !== undefined && !same(shared[param.configKey], value)) throw new Error(`${param.label} differs between watchers sharing ${param.configKey}`);
        shared[param.configKey] = value;
      }
      if (param.configKey || same(params[param.key], param.default)) delete params[param.key];
    }
    if (entry.enabled) { if (typeof read === 'string') throw new Error(read); validateWatcherExecutable(entry.path); }
    const saved: FieldWatcherConfig = { path: entry.path, enabled: entry.enabled };
    for (const [key, value] of Object.entries(defaults(manifest)) as [keyof ReturnType<typeof defaults>, unknown][]) {
      if (entry[key] !== undefined && !same(entry[key], value)) Object.assign(saved, { [key]: entry[key] });
    }
    return Object.keys(params).length ? { ...saved, params } : saved;
  });
  return { entries, shared };
}
