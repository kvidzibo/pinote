import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const limit = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function runtimeInjection(name: string): boolean { return /^(LD_|NODE_|ELECTRON_)/.test(name) || name === 'GCONV_PATH' || name === 'GLIBC_TUNABLES'; }
// Verifies, as UTF-8, the inherited profile paths and runtime flags that backend children receive.
export async function processEnvironment(pid: number): Promise<NodeJS.ProcessEnv> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Cannot verify the process environment.');
  const allowed = new Set(['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PINOTE_NOTE_COMMAND', 'PINOTE_NODE', 'PINOTE_BRIDGE_COMMAND', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'KITTY_LISTEN_ON']);
  const kept = (name: string) => name && (allowed.has(name) || runtimeInjection(name));
  if (process.platform === 'darwin') {
    // macOS has no /proc. Node decodes invalid UTF-8 as U+FFFD, so reject every U+FFFD.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => kept(name)));
    if (pid !== process.pid || Object.values(env).some(value => value?.includes('\ufffd'))) throw new Error('Cannot verify the process environment.');
    return env;
  }
  const raw = await readFile(`/proc/${pid}/environ`);
  if (raw.length > limit) throw new Error('Cannot verify the process environment.');
  return Object.fromEntries(raw.toString('latin1').split('\0').map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }).filter(([name]) => kept(name)).map(([key, value]) => [key, utf8.decode(Buffer.from(value, 'latin1'))]));
}
export function verifyProfilePaths(env: NodeJS.ProcessEnv, keys: string[]): void {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error('Pinote requires an absolute HOME independent of the working directory.');
  for (const key of keys) {
    if (env[key]?.split('/').includes('..')) throw new Error('Pinote requires unambiguous home and XDG paths without parent-directory components.');
  }
}
