import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Kitty user variable naming the task selected in a Pi pane, so a pane in the same tab can tell. */
const TASK_VAR = 'pinote_task';
type Exec = ExtensionAPI['exec'];
type Window = { id?: unknown; is_active?: unknown; user_vars?: Record<string, unknown> };
type OsWindow = { tabs?: { is_active?: unknown; windows?: Window[] }[] };

/** This pane in a local Kitty with remote control; SSH and other terminals are left alone. */
function pane(): { window: string; socket: string } | undefined {
  const window = process.env.KITTY_WINDOW_ID, socket = process.env.KITTY_LISTEN_ON;
  if (!window || !/^[1-9]\d*$/.test(window) || !socket || process.env.SSH_CONNECTION || process.env.SSH_TTY) return undefined;
  return { window, socket };
}

let closing = false;
/** After Pi exits, close this Kitty pane too, ending any shell Pi ran in. Best effort; a pane whose
 * only program was Pi is already gone. The command is detached so Pi can finish exiting first. */
export function closePaneOnExit(): void {
  const target = pane();
  if (!target || closing) return;
  closing = true;
  process.once('exit', () => {
    try { spawn('kitty', ['@', '--to', target.socket, 'close-window', `--match=id:${target.window}`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); }
    catch { /* Pi still exits. */ }
  });
}

/** Best-effort Kitty tab control for one Pi pane. Failures never affect task state. */
export class KittyPane {
  private exec: Exec;
  /** The task this pane holds, and the value Kitty last acknowledged (undefined: unknown). */
  private wanted?: number | null;
  private marked?: number | null;
  private failures = 0;
  private marks = Promise.resolve();
  constructor(exec: Exec) { this.exec = exec; }
  /** A timed-out command counts as failed, whatever its exit code. */
  private async kitty(socket: string, args: string[], signal?: AbortSignal) {
    const result = await this.exec('kitty', ['@', '--to', socket, ...args], { signal, timeout: 1500 });
    if (result.code !== 0 || result.killed) throw new Error('Kitty remote control failed');
    return result;
  }
  /** Record this pane's selected task (or none), in order. A failed update is retried on later calls,
   * at most three times per value, so a stale marker cannot split another pane indefinitely. */
  mark(taskId: number | null): Promise<void> {
    const target = pane();
    if (!target) return this.marks;
    if (taskId !== this.wanted) { this.wanted = taskId; this.failures = 0; }
    // Compare inside the queue, after earlier writes settle.
    this.marks = this.marks.then(async () => {
      const value = this.wanted;
      if (value === undefined || value === this.marked || this.failures >= 3) return;
      try {
        await this.kitty(target.socket, ['set-user-vars', `--match=id:${target.window}`, value === null ? TASK_VAR : `${TASK_VAR}=${value}`]);
        this.marked = value;
      } catch {
        this.marked = undefined; // A timed-out update may still apply.
        if (value === this.wanted) this.failures++;
      }
    });
    return this.marks;
  }
  /** On exit: clear the variable if this process may have set it. */
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
        for (const os of JSON.parse((await this.kitty(target.socket, ['ls'], signal)).stdout) as OsWindow[]) for (const tab of os.tabs ?? []) {
          const self = tab.windows?.find((window) => window.id === id);
          if (!self) continue;
          active = tab.is_active === true && self.is_active === true;
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
  }
}
