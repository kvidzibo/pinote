import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** In-process change detector for notes.db, so idle polling starts no CLI process.
 * read() changes after any other connection commits or the file is replaced;
 * undefined means it cannot tell and the caller must read through the CLI. */
export function notesVersion() {
  const dataHome = process.env.XDG_DATA_HOME;
  const database = join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local/share'), 'pinote/notes.db');
  let db: DatabaseSync | undefined, inode: number | undefined;
  const close = () => { try { db?.close(); } catch { /* Already closed. */ } db = undefined; };
  return {
    read(): string | undefined {
      try {
        const current = statSync(database).ino;
        if (current !== inode) close();
        db ??= new (process.getBuiltinModule('node:sqlite').DatabaseSync)(database, { readOnly: true });
        inode = current;
        return `${current}:${db.prepare('PRAGMA data_version').get()!.data_version}`;
      } catch { close(); return undefined; }
    },
    close,
  };
}
/** Unchanged databases are still re-read this often, in case a change was not observable. */
export const RECHECK_MS = 60_000;
