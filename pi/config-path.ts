import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same personal configuration location in Pi and the standalone MCP process.
export function getAgentDir(): string {
  let path = process.env.PI_CODING_AGENT_DIR;
  if (!path) return join(homedir(), '.pi', 'agent');
  if (path === '~') return homedir();
  if (process.platform === 'win32' && !path.includes('\\')) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
    if (match) path = `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}`;
  }
  if (path.startsWith('~/') || process.platform === 'win32' && path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path.startsWith('file://') ? fileURLToPath(path) : path;
}
