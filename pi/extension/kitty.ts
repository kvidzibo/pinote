import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { database } from '../engine.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Kitty user variable naming the task selected in a Pi pane, so a pane in the same tab can tell. */
const TASK_VAR = 'pinote_task';
/** Kitty user variable with the selected task's most urgent PR state, for a tab bar to show while idle. */
const PR_VAR = 'pinote_pr';
export type PRStatus = 'failing' | 'pending' | 'passing' | 'merged';
type Exec = ExtensionAPI['exec'];
type Window = { id?: unknown; is_active?: unknown; user_vars?: Record<string, unknown>; foreground_processes?: { pid?: unknown }[] };
type Tab = { id?: unknown; is_active?: unknown; windows?: Window[] };
type OsWindow = { tabs?: Tab[] };

/** This pane in a local Kitty with remote control; SSH and other terminals are left alone. */
function pane(): { window: string; socket: string } | undefined {
  const window = process.env.KITTY_WINDOW_ID, socket = process.env.KITTY_LISTEN_ON;
  if (!window || !/^[1-9]\d*$/.test(window) || !socket || process.env.SSH_CONNECTION || process.env.SSH_TTY) return undefined;
  return { window, socket };
}

/** Where this Kitty's tabs record the task they were named after, one file per tab. Kitty has no tab
 * variables, and a pane's own variables go with it. Only under a directory of ours that nobody else
 * can write, so another user can neither plant nor redirect a record; unavailable elsewhere. */
function tabRecords(): { dir: string; prefix: string } | undefined {
  const root = process.env.XDG_RUNTIME_DIR || (process.platform === 'darwin' ? process.env.TMPDIR : undefined), kitty = process.env.KITTY_PID;
  if (!root || !isAbsolute(root) || !kitty || !/^[1-9]\d*$/.test(kitty)) return undefined;
  try {
    // Resolve symlinks and `..` once, so the directory used is the one checked.
    const base = realpathSync.native(root), stat = statSync(base);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) return undefined;
    return { dir: join(base, 'pinote', 'kitty-tabs'), prefix: `${kitty}-` };
  } catch { return undefined; }
}

let closing = false;
/** Prepares closing this Kitty pane after Pi exits, ending any shell Pi ran in. Returns the function that
 * arms it, so callers can recheck their state after this check; call it only right before exiting.
 * Only a pane running Pi in its foreground qualifies: inherited Kitty variables (tmux, screen, child
 * processes) can name another pane. Best effort; a pane whose only program was Pi is already gone.
 * The close command is detached so Pi can finish exiting first. */
export async function paneCloser(exec: Exec): Promise<(() => void) | undefined> {
  const target = pane();
  if (!target) return;
  try {
    const result = await exec('kitty', ['@', '--to', target.socket, 'ls', `--match=id:${target.window}`], { timeout: 1500 });
    if (result.code !== 0 || result.killed) return;
    const owned = (JSON.parse(result.stdout) as OsWindow[]).some((os) => os.tabs?.some((tab) => tab.windows?.some((window) =>
      window.id === Number(target.window) && window.foreground_processes?.some((process_) => process_.pid === process.pid))));
    if (!owned) return;
  } catch { return; }
  return () => {
    if (closing) return;
    closing = true;
    process.once('exit', () => {
      try { spawn('kitty', ['@', '--to', target.socket, 'close-window', `--match=id:${target.window}`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); }
      catch { /* Pi still exits. */ }
    });
  };
}

/** Best-effort Kitty tab control for one Pi pane. Failures never affect task state. */
export class KittyPane {
  private exec: Exec;
  /** The last requested task; the task and PR state this pane holds, and the values Kitty last acknowledged (undefined: unknown). */
  private task?: number | null;
  private wanted?: string;
  private marked?: string;
  private failures = 0;
  private marks = Promise.resolve();
  constructor(exec: Exec) { this.exec = exec; }
  /** A timed-out command counts as failed, whatever its exit code. */
  private async kitty(socket: string, args: string[], signal?: AbortSignal) {
    const result = await this.exec('kitty', ['@', '--to', socket, ...args], { signal, timeout: 1500 });
    if (result.code !== 0 || result.killed) throw new Error('Kitty remote control failed');
    return result;
  }
  /** The tab holding this pane. `own`: only if Pi runs in the pane's foreground, as inherited Kitty
   * variables (tmux, screen) can name a pane Pi is not in. */
  private async tab(target: { window: string; socket: string }, signal?: AbortSignal, own = false): Promise<Tab | undefined> {
    const id = Number(target.window);
    for (const os of JSON.parse((await this.kitty(target.socket, ['ls'], signal)).stdout) as OsWindow[]) for (const tab of os.tabs ?? []) {
      const self = tab.windows?.find((window) => window.id === id);
      if (self) return !own || self.foreground_processes?.some((process_) => process_.pid === process.pid) ? tab : undefined;
    }
  }
  /** Record that this pane's tab belongs to a task, so a later Pi in the tab can continue it. Best effort. */
  async claim(taskId: number, signal?: AbortSignal): Promise<void> {
    const target = pane(), records = tabRecords();
    if (!target || !records) return;
    try {
      const tab = await this.tab(target, signal, true);
      if (!Number.isSafeInteger(tab?.id)) return;
      mkdirSync(records.dir, { recursive: true, mode: 0o700 });
      // A later Kitty can reuse a process ID and its tab IDs: drop records of Kitty instances that have exited.
      for (const name of readdirSync(records.dir)) {
        try { process.kill(Number(name.split('-')[0]), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(join(records.dir, name), { force: true }); }
      }
      writeFileSync(join(records.dir, `${records.prefix}${tab!.id}`), `${taskId}\n${database()}`); // IDs repeat across databases.
    } catch { /* The tab only loses its automatic pickup. */ }
  }
  /** The task this pane's tab belongs to, unless another pane in the tab holds it: one agent per task. */
  async tabTask(signal?: AbortSignal): Promise<number | undefined> {
    const target = pane(), records = tabRecords();
    if (!target || !records) return;
    try {
      if (!readdirSync(records.dir).some((name) => name.startsWith(records.prefix))) return; // No Kitty call for nothing.
      const tab = await this.tab(target, signal, true);
      if (!Number.isSafeInteger(tab?.id)) return;
      const file = join(records.dir, `${records.prefix}${tab!.id}`);
      // After a reboot, another Kitty can have this process ID and these tab IDs.
      if (statSync(file).mtimeMs < Date.now() - uptime() * 1000) return;
      const [task, notes] = readFileSync(file, 'utf8').split('\n');
      if (!/^[1-9]\d{0,14}$/.test(task) || notes !== database()) return;
      if (tab!.windows!.some((window) => window.id !== Number(target.window) && window.user_vars?.[TASK_VAR] === task)) return;
      return Number(task);
    } catch { return; }
  }
  /** Record this pane's selected task (or none) and its PR state, in order. A failed update is retried on later calls,
   * at most three times per value, so a stale marker cannot split another pane indefinitely. */
  mark(taskId: number | null, pr?: PRStatus): Promise<void> {
    const target = pane();
    if (!target) return this.marks;
    this.task = taskId;
    const vars = [taskId === null ? TASK_VAR : `${TASK_VAR}=${taskId}`, taskId !== null && pr ? `${PR_VAR}=${pr}` : PR_VAR].join(' ');
    if (vars !== this.wanted) { this.wanted = vars; this.failures = 0; }
    // Compare inside the queue, after earlier writes settle.
    this.marks = this.marks.then(async () => {
      const value = this.wanted;
      if (value === undefined || value === this.marked || this.failures >= 3) return;
      try {
        await this.kitty(target.socket, ['set-user-vars', `--match=id:${target.window}`, ...value.split(' ')]);
        this.marked = value;
      } catch {
        this.marked = undefined; // A timed-out update may still apply.
        if (value === this.wanted) this.failures++;
      }
    });
    return this.marks;
  }
  /** Without a current view: keep the task marker but stop showing a PR status that may be outdated. */
  clearPR(): Promise<void> {
    return this.task === undefined ? this.marks : this.mark(this.task);
  }
  /** On exit: clear the variables if this process may have set them. */
  release(): Promise<void> {
    if (this.wanted === undefined) return this.marks;
    this.failures = 0;
    return this.mark(null);
  }
  /** Name this pane's tab after an explicitly selected task. With one task per tab, a pane sharing its tab with
   * another task's pane first moves to a new tab beside it. Returns a warning, if any. */
  async select(taskId: number, title: string, oneTaskPerTab: boolean, signal: AbortSignal): Promise<string | undefined> {
    const target = pane();
    if (!target) return;
    const name = title || `Task #${taskId}`;
    try {
      if (oneTaskPerTab) {
        const id = Number(target.window);
        let shared = false, active = false;
        const tab = await this.tab(target, signal);
        if (tab) {
          active = tab.is_active === true && tab.windows!.find((window) => window.id === id)!.is_active === true;
          shared = tab.windows!.some((window) => {
            const task = window.user_vars?.[TASK_VAR];
            return window.id !== id && typeof task === 'string' && task !== '' && task !== String(taskId);
          });
        }
        if (shared) {
          // Kitty places a new tab after the active tab of this pane's OS window.
          if (!active) return 'Pinote task selected, but this pane was not focused, so it stays in its shared Kitty tab.';
          // Every step names this pane or a tagged placeholder tab: a focus change can shift the placement,
          // never move another pane or tab. The placeholder is closed by tag, even if launch's reply is lost.
          const placeholder = `pinote_placeholder=${randomUUID()}`;
          try {
            await this.kitty(target.socket, ['launch', '--type=tab', '--location=after', `--match=window_id:${target.window}`, `--var=${placeholder}`, `--tab-title=${name}`, 'sleep', '60'], signal);
            await this.kitty(target.socket, ['detach-window', `--match=id:${target.window}`, `--target-tab=var:${placeholder}`], signal);
          } finally { await this.kitty(target.socket, ['close-window', `--match=var:${placeholder}`]).catch(() => {}); }
        }
      }
    } catch {
      return signal.aborted ? undefined : 'Pinote task selected, but this pane could not be moved to its own Kitty tab.';
    }
    try {
      await this.kitty(target.socket, ['set-tab-title', `--match=window_id:${target.window}`, '--', name], signal);
    } catch {
      return signal.aborted ? undefined : 'Pinote task selected, but the Kitty tab could not be renamed.';
    }
    await this.claim(taskId, signal);
  }
}
