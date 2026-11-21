import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FieldAutomation } from './field-events.ts';

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
