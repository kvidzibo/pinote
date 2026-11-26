import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Kitty user variable naming the task selected in a Pi pane, so a pane in the same tab can tell. */
const TASK_VAR = 'pinote_task';
type Exec = ExtensionAPI['exec'];
type Window = { id?: unknown; is_active?: unknown; user_vars?: Record<string, unknown> };
type OsWindow = { is_active?: unknown; tabs?: { is_active?: unknown; windows?: Window[] }[] };

/** This pane in a local Kitty with remote control; SSH and other terminals are left alone. */
function pane(): { window: string; socket: string } | undefined {
  const window = process.env.KITTY_WINDOW_ID, socket = process.env.KITTY_LISTEN_ON;
  if (!window || !/^[1-9]\d*$/.test(window) || !socket || process.env.SSH_CONNECTION || process.env.SSH_TTY) return undefined;
  return { window, socket };
}

/** Best-effort Kitty tab control for one Pi pane. Failures never affect task state. */
export class KittyPane {
  private exec: Exec;
  private marked?: number | null;
  private marks = Promise.resolve();
  constructor(exec: Exec) { this.exec = exec; }
  private kitty(socket: string, args: string[], signal?: AbortSignal) {
    return this.exec('kitty', ['@', '--to', socket, ...args], { signal, timeout: 1500 });
  }
  /** Record this pane's selected task (or none) once per change, in order. */
  mark(taskId: number | null): Promise<void> {
    const target = pane();
    if (!target || taskId === this.marked) return this.marks;
    this.marked = taskId;
    const value = taskId === null ? TASK_VAR : `${TASK_VAR}=${taskId}`;
    this.marks = this.marks.then(() => this.kitty(target.socket, ['set-user-vars', `--match=id:${target.window}`, value])).then(() => {}, () => {});
    return this.marks;
  }
  /** Clear the variable only if this process set it. */
  release(): Promise<void> { return this.marked === undefined ? this.marks : this.mark(null); }
  /** Name this pane's tab after a newly selected task. With one task per tab, a pane sharing its tab with
   * another task's pane first moves to a new tab beside it. Returns a warning, if any. */
  async select(taskId: number, title: string, oneTaskPerTab: boolean, signal: AbortSignal): Promise<string | undefined> {
    const target = pane();
    if (!target || !title) return;
    try {
      if (oneTaskPerTab) {
        const listed = await this.kitty(target.socket, ['ls', `--match-tab=window_id:${target.window}`], signal);
        if (listed.code !== 0) throw new Error('Kitty listing failed');
        const id = Number(target.window);
        let shared = false, active = false;
        for (const os of JSON.parse(listed.stdout) as OsWindow[]) for (const tab of os.tabs ?? []) {
          const self = tab.windows?.find((window) => window.id === id);
          if (!self) continue;
          active = os.is_active === true && tab.is_active === true && self.is_active === true;
          shared = tab.windows!.some((window) => {
            const task = window.user_vars?.[TASK_VAR];
            return window.id !== id && typeof task === 'string' && task !== '' && task !== String(taskId);
          });
        }
        if (shared) {
          // detach_window acts on the active window: never move another pane, or rename the shared tab.
          if (!active) return 'Pinote task selected, but this pane was not focused, so it stays in its shared Kitty tab.';
          const moved = await this.kitty(target.socket, ['action', `--match=id:${target.window}`, 'detach_window', 'new-tab-right'], signal);
          if (moved.code !== 0) throw new Error('Kitty move failed');
        }
      }
    } catch {
      return signal.aborted ? undefined : 'Pinote task selected, but this pane could not be moved to its own Kitty tab.';
    }
    try {
      const renamed = await this.kitty(target.socket, ['set-tab-title', `--match=window_id:${target.window}`, '--', title], signal);
      if (renamed.code !== 0) throw new Error('Kitty title update failed');
    } catch {
      return signal.aborted ? undefined : 'Pinote task selected, but the Kitty tab could not be renamed.';
    }
  }
}
