import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FieldAutomation } from './field-events.ts';
import { discoverFieldWatchers, parseFieldWatchers, validateWatcherExecutable } from './field-watchers.ts';
import { footerCatalog, parseFooterConfig, readConfigDocument } from './footer-config.ts';

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

/** The desktop's Watchers settings. An unsaved bundled script is hidden when a saved entry has the same name:
 * entries saved by Pi point at the package's own copy of that watcher. */
export function watcherSettings() {
  const { raw, value } = readConfigDocument();
  const saved = new Set(parseFieldWatchers(value).map((entry) => entry.path));
  const all = discoverFieldWatchers(value);
  const watchers = all.filter((watcher) => saved.has(watcher.path) || !all.some((other) => saved.has(other.path) && other.name === watcher.name))
    .map(({ config, ...watcher }) => watcher);
  let fieldNames: string[] = [];
  try { fieldNames = footerCatalog(parseFooterConfig(value)).map((field) => field.name); } catch { /* Invalid footer settings: no suggestions. */ }
  return { raw, watchers, fieldNames };
}
export { saveFieldWatchers as saveWatcherSettings } from './footer-config.ts';
/** A script chosen in the desktop but not saved yet, with the defaults its parameter file declares. */
export function describeWatcher(path: string) {
  validateWatcherExecutable(path);
  const { config, ...watcher } = discoverFieldWatchers({ fieldWatchers: [{ path, enabled: false }] })[0];
  return watcher;
}
