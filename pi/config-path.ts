import { homedir } from 'node:os';
import { join } from 'node:path';

// Same personal configuration location in Pi and the standalone MCP process.
export function getAgentDir(): string {
  const path = process.env.PI_CODING_AGENT_DIR;
  if (!path) return join(homedir(), '.pi', 'agent');
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
