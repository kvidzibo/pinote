import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FieldAutomation } from './field-events.ts';
import { discoverFieldWatchers, parseFieldWatchers, validateWatcherExecutable, watcherEntries, type FieldWatcher } from './field-watchers.ts';
import { defaultFieldInstructions, footerCatalog, parseFooterConfig, parseKittyOneTaskPerTab, parseTaskCompletion, readConfigDocument } from './footer-config.ts';
import { fieldType } from './field-values.ts';

/** Run the field-watcher scheduler for as long as the hosting process (the desktop) lives.
 * Pi sessions only read the results it saves. Failure details go to watchers.log beside the
 * watcher state, where Pi points to them; no task text, values or tokens are logged. */
export async function startFieldWatchers(options: { log?: (event: string) => void } = {}): Promise<{ logPath: string; close(): Promise<void> }> {
  let logPath = '', changes = '';
  const automation = await FieldAutomation.open({
    // Pi sessions watch this file, not the database: lease renewals must not refresh them.
    changed: () => { if (changes) try { writeFileSync(changes, `${Date.now()}\n`, { mode: 0o600 }); } catch { options.log?.('watcher change marker write failed'); } },
    log: (failure) => {
      options.log?.(failure ? 'watcher check failed' : 'field automation check failed; will retry');
      if (!failure) return;
      try { appendFileSync(logPath, `${new Date().toISOString()} watcher check failed ${JSON.stringify(failure)}\n`, { mode: 0o600 }); }
      catch { options.log?.('watcher log write failed'); }
    },
  });
  logPath = join(dirname(automation.path), 'watchers.log'); changes = automation.changes;
  automation.start();
  return { logPath, close: () => automation.close() };
}

/** The desktop's Watchers settings. An unsaved bundled script is hidden when a saved entry is a copy of it (same
 * file name and parameter file): entries saved by Pi point at the package's own copy of that watcher. */
export function watcherSettings() {
  const { raw, value } = readConfigDocument();
  const saved = new Set(parseFieldWatchers(value).map((entry) => entry.path));
  const all = discoverFieldWatchers(value);
  const copy = (a: FieldWatcher, b: FieldWatcher) => basename(a.path) === basename(b.path) && a.declared === b.declared;
  const watchers = all.filter((watcher) => saved.has(watcher.path) || !all.some((other) => saved.has(other.path) && copy(other, watcher)))
    .map(({ config, declared, ...watcher }) => watcher);
  let fieldNames: string[] = [];
  try { fieldNames = footerCatalog(parseFooterConfig(value)).map((field) => field.name); } catch { /* Invalid footer settings: no suggestions. */ }
  return { raw, watchers, fieldNames };
}
export { saveFieldWatchers as saveWatcherSettings } from './footer-config.ts';
/** The desktop's Kitty settings, shared with Pi's settings. */
export function kittySettings() {
  const { raw, value } = readConfigDocument();
  return { raw, oneTaskPerTab: parseKittyOneTaskPerTab(value), onTaskComplete: parseTaskCompletion(value) };
}
export { saveKittySettings } from './footer-config.ts';
/** The desktop's Fields settings: every definition (saved ones, then unsaved presets) with its effective values, and the footer layout.
 * `saved` is false for a preset that pi-note.json does not define yet. */
export function fieldSettings() {
  const { raw, value } = readConfigDocument();
  const config = parseFooterConfig(value), { fields: _fields, bar, ...layout } = config;
  const saved = new Set((config.fields ?? []).map((field) => field.name === 'PR' ? 'PRs' : field.name));
  const fields = footerCatalog(config).map((field) => ({ ...field, type: fieldType(field), enabled: field.enabled !== false,
    instructions: field.instructions ?? defaultFieldInstructions(field.name), saved: saved.has(field.name) }));
  return { raw, footer: { ...layout, bar: bar ?? null, fields } };
}
export { saveFooterSettings as saveFieldSettings } from './footer-config.ts';
/** What saving these entries will trust, for the desktop's confirmation: enabled scripts and the shared values they are given. */
export function watcherSaveSummary(input: unknown): string[] {
  const { entries, shared } = watcherEntries(input);
  return [...entries.filter((entry) => entry.enabled).map((entry) => entry.path),
    ...Object.entries(shared).flatMap(([key, value]) => Array.isArray(value) ? value.map((row) => `${key}: ${JSON.stringify(row)}`) : [])];
}
/** A script chosen in the desktop but not saved yet, with the defaults its parameter file declares. */
export function describeWatcher(path: string) {
  validateWatcherExecutable(path);
  const { config, declared, ...watcher } = discoverFieldWatchers({ fieldWatchers: [{ path, enabled: false }] })[0];
  return watcher;
}
