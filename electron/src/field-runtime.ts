import { fileURLToPath } from 'node:url';
import { backendEnvironment } from './backend-command.ts';
import { configureFieldHandlerGuardian } from '../../pi/mcp/handler-process.ts';
import { discoverFieldWatchers } from '../../pi/field-watchers.ts';
import { readConfigDocument } from '../../pi/footer-config.ts';
import { FieldAutomation } from '../../pi/mcp/field-events.ts';

const watchers = fileURLToPath(new URL('./watchers', import.meta.url));

export function openDesktopFieldAutomation(node: string, options: Parameters<typeof FieldAutomation.open>[0]) {
  if (process.platform !== 'linux') throw new Error('Desktop watcher supervision requires Linux.');
  const script = fileURLToPath(new URL('./field-handler-guardian.mjs', import.meta.url));
  configureFieldHandlerGuardian({ node, script, env: backendEnvironment(process.env) });
  return FieldAutomation.open({ ...options, watchers: () => discoverFieldWatchers(readConfigDocument().value, watchers) });
}
