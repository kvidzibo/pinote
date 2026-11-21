import { fileURLToPath } from 'node:url';
import { discoverFieldWatchers } from '../../pi/field-watchers.ts';
import { readConfigDocument } from '../../pi/footer-config.ts';
import { FieldAutomation } from '../../pi/mcp/field-events.ts';

const watchers = fileURLToPath(new URL('./watchers', import.meta.url));

export function openDesktopFieldAutomation(options: Parameters<typeof FieldAutomation.open>[0]) {
  return FieldAutomation.open({ ...options, watchers: () => discoverFieldWatchers(readConfigDocument().value, watchers) });
}
