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
  /** The task this pane holds, and the value Kitty last acknowledged. */
  private wanted?: number | null;
  private marked?: number | null;
  private failures = 0;
  private marks = Promise.resolve();
  constructor(exec: Exec) { this.exec = exec; }
  private kitty(socket: string, args: string[], signal?: AbortSignal) {
    return this.exec('kitty', ['@', '--to', socket, ...args], { signal, timeout: 1500 });
  }
  /** Record this pane's selected task (or none), in order. A failed update is retried on later calls,
   * at most three times per value, so a stale marker cannot split another pane indefinitely. */
  mark(taskId: number | null): Promise<void> {
    const target = pane();
    if (!target) return this.marks;
    if (taskId !== this.wanted) { this.wanted = taskId; this.failures = 0; }
    if (this.wanted === this.marked || this.failures >= 3) return this.marks;
    this.marks = this.marks.then(async () => {
      const value = this.wanted;
      if (value === undefined || value === this.marked || this.failures >= 3) return;
      try {
        const result = await this.kitty(target.socket, ['set-user-vars', `--match=id:${target.window}`, value === null ? TASK_VAR : `${TASK_VAR}=${value}`]);
        if (result.code !== 0) throw new Error('Kitty user variable update failed');
        this.marked = value;
      } catch {
        this.marked = undefined; // Unknown: a timed-out update may still apply.
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
    if (!target || !title) return;
    try {
      if (oneTaskPerTab) {
        const listed = await this.kitty(target.socket, ['ls'], signal);
        if (listed.code !== 0) throw new Error('Kitty listing failed');
        const id = Number(target.window);
        let shared = false, active = false, later = 0;
        for (const os of JSON.parse(listed.stdout) as OsWindow[]) (os.tabs ?? []).forEach((tab, index, tabs) => {
          const self = tab.windows?.find((window) => window.id === id);
          if (!self) return;
          active = os.is_active === true && tab.is_active === true && self.is_active === true;
          shared = tab.windows!.some((window) => {
            const task = window.user_vars?.[TASK_VAR];
            return window.id !== id && typeof task === 'string' && task !== '' && task !== String(taskId);
          });
          later = tabs.length - index - 1;
        });
        if (shared) {
          // Kitty opens the new tab in its focused OS window and reorders its active tab.
          if (!active) return 'Pinote task selected, but this pane was not focused, so it stays in its shared Kitty tab.';
          // Move this pane by ID, never whichever pane is active. The new tab is appended, then moved beside the old one.
          const moved = await this.kitty(target.socket, ['detach-window', `--match=id:${target.window}`, '--target-tab=new'], signal);
          if (moved.code !== 0) throw new Error('Kitty move failed');
          if (later) await this.kitty(target.socket, ['action', 'combine', ...Array.from({ length: later }, () => [':', 'move_tab_backward']).flat()], signal).catch(() => {});
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
