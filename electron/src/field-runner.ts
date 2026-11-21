import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type BigIntStats } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPaths, realpathUtf8, resolvePath } from '../../backend/src/runtime.ts';
import { backendEnvironment, type backendCommand } from './backend-command.ts';
import { verifySwitchPaths } from './backend-switch.ts';

const sameFile = (original: BigIntStats, current: BigIntStats) => original.dev === current.dev && original.ino === current.ino;

export function fieldDatabaseIdentity(database: string, environment: NodeJS.ProcessEnv) {
  if (environment.PINOTE_ELECTRON_BACKEND !== undefined) throw new Error('Watcher execution requires the bundled desktop bridge.');
  const desktopEnv = backendEnvironment(environment);
  const noteEnv = { ...desktopEnv };
  verifySwitchPaths(noteEnv);
  // Keep service wrappers, loader overrides and profile-specific PATH
  // helpers out of polling. Watcher environments are unchanged.
  for (const key of Object.keys(noteEnv)) {
    if (/^(LD_|PYTHON)/.test(key) || ['GCONV_PATH', 'GLIBC_TUNABLES'].includes(key)) delete noteEnv[key];
  }
  delete noteEnv.PINOTE_NOTE_COMMAND;
  delete noteEnv.PINOTE_TASK_RESPONSE; // Expect raw CLI response objects.
  noteEnv.PATH = '/usr/bin:/bin';
  if (resolvePath(discoverPaths(noteEnv).database) !== database) throw new Error('The field CLI uses a different database.');
  // Pass the canonical XDG root so retargeting the original alias cannot redirect polling.
  noteEnv.XDG_DATA_HOME = dirname(dirname(database));
  if (discoverPaths(noteEnv).database !== database) throw new Error('The field CLI cannot pin this database layout.');

  const parent = dirname(database);
  const stat = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
  let directory = stat(parent);
  if (!directory) {
    if (!mkdirSync(parent, { recursive: true, mode: 0o700 })) throw new Error('The notes database directory changed during setup.');
    directory = stat(parent);
  }
  const parentMatches = () => {
    const current = stat(parent);
    return directory?.isDirectory() && current?.isDirectory() && sameFile(directory, current) && realpathUtf8(parent) === parent;
  };
  if (!parentMatches()) throw new Error('Cannot verify the notes database directory.');

  let file = stat(database);
  if (!file) {
    // Reserve this inode, rather than trusting whichever DB happens to appear
    // first. The backend/CLI initializes the schema on its next open as usual.
    if (!parentMatches()) throw new Error('The notes database directory changed during setup.');
    const fd = openSync(database, 'wx', 0o600);
    try { file = fstatSync(fd, { bigint: true }); } finally { closeSync(fd); }
  }
  const original = file;
  let replaced = false;
  const matches = () => {
    if (replaced) return false;
    try {
      const current = stat(database);
      if (resolvePath(discoverPaths(desktopEnv).database) === database && parentMatches() && current?.isFile() && sameFile(original, current) && realpathUtf8(database) === database) return true;
    } catch { /* A missing or inaccessible path is also a lost identity. */ }
    replaced = true;
    return false;
  };
  if (!file.isFile() || !matches()) throw new Error('Cannot verify the notes database file.');
  return { database, noteEnv, matches };
}

type FieldDatabase = ReturnType<typeof fieldDatabaseIdentity>;

export async function fieldNoteCommand(bundles: string, profile: FieldDatabase, command: ReturnType<typeof backendCommand>) {
  if (!command.args.length) throw new Error('Watcher execution requires the bundled desktop bridge.');
  if (!profile.matches()) throw new Error('The notes database changed during setup.');
  const cli = join(bundles, 'cli.mjs');
  await access(cli, constants.R_OK);
  return { noteCommand: command.executable, noteArgs: [cli], noteEnv: profile.noteEnv };
}

type Scheduler = { start(): void; close(): Promise<void> };

// One lifecycle per desktop instance. A quit during asynchronous setup must not
// allow a late open() to start the scheduler after cleanup has begun.
export class FieldRunner {
  private opening?: Promise<Scheduler | undefined>;
  private stopping?: Promise<void>;
  private open: () => Promise<Scheduler>;
  private log: (message: string) => void;

  constructor(open: () => Promise<Scheduler>, log: (message: string) => void) {
    this.open = open;
    this.log = log;
  }

  start(): void {
    if (this.opening || this.stopping) return;
    this.opening = (async () => {
      let scheduler: Scheduler | undefined;
      try {
        scheduler = await this.open();
        if (!this.stopping) scheduler.start();
        return scheduler;
      } catch {
        this.log('Cannot start Electron field automation; check the CLI and watcher configuration.');
        await scheduler?.close().catch(() => this.log('Cannot close Electron field automation.'));
      }
    })();
  }

  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      try { await (await this.opening)?.close(); }
      catch { this.log('Cannot close Electron field automation.'); }
    })();
  }
}

export function desktopFieldRunner(bundles: string, profile: FieldDatabase, command: ReturnType<typeof backendCommand>,
  log: (message: string) => void) {
  return new FieldRunner(async () => {
    const cli = await fieldNoteCommand(bundles, profile, command);
    const { openDesktopFieldAutomation } = await import(pathToFileURL(join(bundles, 'field-events.mjs')).href) as typeof import('./field-runtime.ts');
    let stopped = false;
    const databaseMatches = () => {
      if (stopped) return false;
      if (profile.matches()) return true;
      stopped = true;
      log('Electron field automation stopped: the notes database identity changed. Restart Electron to verify the profile.');
      return false;
    };
    return openDesktopFieldAutomation(cli.noteCommand, { ...cli, database: profile.database, databaseMatches, log: failure => log(failure ?
      `Watcher check failed ${JSON.stringify(failure)}` : 'Electron field automation check failed; will retry.') });
  }, log);
}
