import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** In-process change detector for notes.db, so idle polling starts no CLI process.
 * read() changes after any other connection commits or the file is replaced;
 * undefined means it cannot tell and the caller must read through the CLI.
 * close() while idle: an open connection can block journal-mode changes. */
export function notesVersion() {
  const dataHome = process.env.XDG_DATA_HOME;
  // Not join(): like the CLI, a '..' after a symlink must be resolved by the filesystem.
  const database = `${dataHome && isAbsolute(dataHome) ? dataHome : `${homedir()}/.local/share`}/pinote/notes.db`;
  let db: DatabaseSync | undefined, inode: number | undefined, opened = 0;
  const close = () => { try { db?.close(); } catch { /* Already closed. */ } db = undefined; };
  return {
    read(): string | undefined {
      try {
        const current = statSync(database).ino;
        if (current !== inode) close();
        if (!db) { db = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(database, { readOnly: true }); opened++; }
        inode = current;
        // data_version is only comparable on one connection.
        return `${opened}:${db.prepare('PRAGMA data_version').get()!.data_version}`;
      } catch { close(); return undefined; }
    },
    close,
  };
}
/** Unchanged databases are still re-read this often, in case a change was not observable. */
export const RECHECK_MS = 60_000;
