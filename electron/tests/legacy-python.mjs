// A stand-in for an installed legacy Python CLI: the launcher formats the switch
// recognizes and the pinote.paths API it queries, run by the system Python.
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const uvLauncherBody = 'import sys\nfrom pinote.cli import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())\n';

/** Makes `pinote.paths` importable beside a launcher in `directory`, as its environment did. */
export async function legacyPackage(directory) {
  await mkdir(join(directory, 'pinote'), { recursive: true });
  await writeFile(join(directory, 'pinote/__init__.py'), '');
  await writeFile(join(directory, 'pinote/paths.py'), `import os
from pathlib import Path


class Paths:
    def __init__(self, database):
        self.database = database

    @classmethod
    def discover(cls):
        value = os.environ.get("XDG_DATA_HOME", "")
        data = Path(value) if value and Path(value).is_absolute() else Path.home() / ".local/share"
        return cls(data / "pinote" / "notes.db")
`);
}

/** Creates `directory/bin/{python,note}` like a uv environment; returns their paths. */
export async function legacyEnvironment(directory) {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  const interpreter = join(bin, 'python'), note = join(bin, 'note');
  await symlink(await realpath('/usr/bin/python3'), interpreter);
  await legacyPackage(bin);
  await writeFile(note, `#!${interpreter}\n# -*- coding: utf-8 -*-\n${uvLauncherBody}`, { mode: 0o700 });
  return { interpreter, note };
}
