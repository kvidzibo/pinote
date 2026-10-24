import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from './config-path.ts';

/** One personal service identity; never persist tokens in Pi session entries. */
export function pinoteToken(env: NodeJS.ProcessEnv = process.env): string {
  let token = env.PINOTE_TOKEN;
  if (token === undefined) {
    let fd: number | undefined;
    try {
      fd = openSync(env.PINOTE_TOKEN_FILE ?? join(getAgentDir(), 'pinote-token'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error();
      token = readFileSync(fd, 'utf8').trim();
    } catch {
      throw new Error('Pinote needs PINOTE_TOKEN or a private, owner-only token file (PINOTE_TOKEN_FILE)');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  if (token.length < 32 || /\s/.test(token)) throw new Error('Pinote token needs at least 32 non-whitespace characters');
  return token;
}
