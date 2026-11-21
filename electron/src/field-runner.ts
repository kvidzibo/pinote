import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPaths, resolvePath } from '../../backend/src/runtime.ts';
import { backendEnvironment, type backendCommand } from './backend-command.ts';
import { verifiedDesktopNote, verifySwitchPaths } from './backend-switch.ts';

export async function fieldNoteCommand(bundles: string, database: string, command: ReturnType<typeof backendCommand>,
  environment: NodeJS.ProcessEnv, switchRuntime: Parameters<typeof verifiedDesktopNote>[0]) {
  const noteEnv = backendEnvironment(environment);
  verifySwitchPaths(noteEnv);
  if (!command.args.length) {
    const noteCommand = await verifiedDesktopNote(switchRuntime, database, noteEnv);
    return { noteCommand, noteEnv };
  }
  // The bundled bridge and CLI share the same profile resolver and environment.
  // Do not use PATH's note (or a stale service PINOTE_NOTE_COMMAND) after a switch.
  if (resolvePath(discoverPaths(noteEnv).database) !== database) throw new Error('The bundled CLI uses a different database.');
  const cli = join(bundles, 'cli.mjs');
  await access(cli, constants.R_OK);
  return { noteCommand: command.executable, noteArgs: [cli], noteEnv };
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

export function desktopFieldRunner(bundles: string, database: string, command: ReturnType<typeof backendCommand>,
  environment: NodeJS.ProcessEnv, switchRuntime: Parameters<typeof verifiedDesktopNote>[0], log: (message: string) => void) {
  return new FieldRunner(async () => {
    const cli = await fieldNoteCommand(bundles, database, command, environment, switchRuntime);
    const { openDesktopFieldAutomation } = await import(pathToFileURL(join(bundles, 'field-events.mjs')).href) as typeof import('./field-runtime.ts');
    return openDesktopFieldAutomation({ noteCommand: cli.noteCommand, noteArgs: cli.noteArgs, noteEnv: cli.noteEnv, database, log: failure => log(failure ?
      `Watcher check failed ${JSON.stringify(failure)}` : 'Electron field automation check failed; will retry.') });
  }, log);
}
