import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function backendEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (key.startsWith('NODE_') || key.startsWith('ELECTRON_')) delete clean[key];
  return clean;
}
export function backendCommand(bundle: string, env: NodeJS.ProcessEnv = process.env): { executable: string; args: string[] } {
  const find = (name: string, override?: string) => {
    const candidates = override !== undefined ? [override] : (env.PATH || '').split(delimiter).filter(isAbsolute).map(path => join(path, name));
    return candidates.find(path => { try { if (!isAbsolute(path)) return false; accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
  };
  if (env.PINOTE_ELECTRON_BACKEND !== undefined) {
    const executable = find('pinote-electron-backend', env.PINOTE_ELECTRON_BACKEND);
    if (!executable) throw new Error('Install Pinote or set PINOTE_ELECTRON_BACKEND to a trusted absolute executable.');
    return { executable, args: [] };
  }
  const executable = find('node', env.PINOTE_NODE);
  if (!executable) throw new Error('Install Node.js 22.19.0+ or set PINOTE_NODE to a trusted absolute Node executable.');
  const result = spawnSync(executable, ['--version'], { env: backendEnvironment(env), encoding: 'utf8', timeout: 5000 });
  const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(result.stdout || '');
  if (result.status !== 0 || !version || +version[1] < 22 || +version[1] === 22 && +version[2] < 19) throw new Error('Pinote requires Node.js 22.19.0 or newer.');
  accessSync(bundle, constants.R_OK);
  return { executable, args: [bundle] };
}
