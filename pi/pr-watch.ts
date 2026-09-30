import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type WatchedTask = {
  id: number;
  state: string;
  updated_at: string;
  agent_notes: Record<string, string>;
};
type PR = { url: string; number: string };
type Dependencies = {
  selected: (ctx: ExtensionContext) => Promise<WatchedTask | null>;
  get: (id: number) => Promise<WatchedTask>;
  done: (task: WatchedTask, canAct: () => boolean) => Promise<void>;
  claim: () => (() => void) | undefined;
  refresh: (ctx: ExtensionContext) => Promise<void>;
};
const entryType = "pinote-pr-acknowledged";

// Accept one bare URL or Markdown link, never arbitrary hosts or terminal escapes.
export function taskPR(task: WatchedTask | null): PR | undefined {
  const field = task?.agent_notes.PR?.trim();
  if (!field) return;
  const url = /^\[[^\r\n]*\]\(([^\s]+)\)$/u.exec(field)?.[1] ?? field;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url);
  if (!match || [".", ".."].includes(match[2]) || !Number.isSafeInteger(Number(match[3]))) return;
  return { url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`, number: match[3] };
}
const keyFor = (task: WatchedTask, pr: PR) => JSON.stringify([task.id, pr.url]);

export function createPRWatcher(pi: ExtensionAPI, deps: Dependencies) {
  let ctx: ExtensionContext | undefined;
  let watched: WatchedTask | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller = new AbortController();
  let generation = 0;
  let revision = 0;
  let running = false;
  let interval = 60_000;
  let warned = false;
  let acknowledged = new Set<string>();

  const paint = () => {
    if (!ctx) return;
    const pr = taskPR(watched);
    ctx.ui.setStatus("pinote-pr", pr
      ? ctx.ui.theme.fg("mdLink", `\x1b]8;;${pr.url}\x1b\\PR #${pr.number}\x1b]8;;\x1b\\`)
      : undefined);
  };
  const schedule = (delay = interval) => {
    if (!ctx || !interval || running) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void poll(); }, delay);
    timer.unref();
  };
  const update = (context: ExtensionContext, current: WatchedTask | null) => {
    if (!ctx || ctx.cwd !== context.cwd) return;
    const previousKey = watched && taskPR(watched) ? keyFor(watched, taskPR(watched)!) : undefined;
    revision++;
    // Completion clears selection. Keep the last task until poll verifies its state.
    if (current) watched = taskPR(current) ? current : null;
    paint();
    const nextKey = watched && taskPR(watched) ? keyFor(watched, taskPR(watched)!) : undefined;
    if (nextKey !== previousKey) schedule(0);
  };
  const latest = async (context: ExtensionContext, previous: WatchedTask | null) => {
    const current = await deps.selected(context);
    if (current) return taskPR(current) ? current : null;
    if (!previous) return null;
    const old = await deps.get(previous.id);
    return old.state === "done" && taskPR(old) ? old : null;
  };
  async function poll() {
    if (!ctx || running) return;
    const context = ctx;
    const epoch = generation;
    const signal = controller.signal;
    const valid = () => ctx === context && generation === epoch && !signal.aborted;
    running = true;
    try {
      await deps.refresh(context);
      if (!valid()) return;
      const snapshot = revision;
      const candidate = await latest(context, watched);
      if (!valid() || revision !== snapshot) return;
      watched = candidate;
      paint();
      const pr = taskPR(candidate);
      if (!candidate || !pr) return;
      const key = keyFor(candidate, pr);
      const same = () => valid() && watched !== null && taskPR(watched)?.url === pr.url && watched.id === candidate.id;
      if (acknowledged.has(key)) return;
      const result = await pi.exec("gh", ["pr", "view", pr.url, "--json", "state,url"], {
        cwd: context.cwd, timeout: 10_000, signal,
      });
      if (!same()) return;
      if (result.code !== 0 || result.killed) throw new Error("GitHub CLI failed");
      const data = JSON.parse(result.stdout);
      if (data.url !== pr.url || !["OPEN", "CLOSED", "MERGED"].includes(data.state)) throw new Error("Invalid PR response");
      warned = false;
      if (data.state !== "MERGED" || !context.isIdle()) return;
      const release = deps.claim();
      if (!release) return;
      try {
        const current = await latest(context, candidate);
        if (!same() || !current || current.id !== candidate.id || taskPR(current)?.url !== pr.url || !context.isIdle()) return;
        const acknowledge = () => {
          pi.appendEntry(entryType, { cwd: context.cwd, key });
          acknowledged.add(key);
        };
        const alreadyDone = () => {
          context.ui.notify(`PR #${pr.number} was merged and the task is already completed.`, "info");
          acknowledge();
        };
        if (current.state === "done") { alreadyDone(); return; }
        if (!["active", "in_progress"].includes(current.state)) return;
        const confirmed = await context.ui.confirm(`PR #${pr.number} was merged`, "Mark this task completed?", { signal });
        if (!same() || !context.isIdle()) return;
        // Re-read selection, link, and revision after the dialog; never complete a changed task.
        const fresh = await latest(context, current);
        if (!same() || !fresh || fresh.id !== current.id || taskPR(fresh)?.url !== pr.url) return;
        if (fresh.state === "done") { alreadyDone(); return; }
        if (fresh.updated_at !== current.updated_at) {
          context.ui.notify("Pinote task changed while confirming. The merge will be checked again.", "warning");
          return;
        }
        if (confirmed) {
          await deps.done(fresh, () => same() && context.isIdle());
          if (!valid()) return;
          context.ui.notify(`Pinote #${fresh.id} completed.`, "info");
        }
        acknowledge();
      } finally {
        release();
        if (valid()) await deps.refresh(context);
      }
    } catch {
      if (valid() && !warned) {
        warned = true;
        context.ui.notify("Pinote PR check failed. Check gh authentication and note availability; polling will retry.", "warning");
      }
    } finally {
      // A previous session's request must not affect a replacement watcher's timer.
      if (valid()) { running = false; schedule(); }
    }
  }
  return {
    update,
    start(context: ExtensionContext) {
      this.stop();
      if (!context.hasUI || context.mode !== "tui") return;
      const seconds = Number(process.env.PINOTE_PR_POLL_SECONDS ?? "60");
      interval = Number.isInteger(seconds) && (seconds === 0 || seconds >= 10 && seconds <= 86400)
        ? seconds * 1000 : 60_000;
      if (interval !== seconds * 1000) context.ui.notify("Invalid PINOTE_PR_POLL_SECONDS; using 60 seconds (allowed: 0 or 10–86400).", "warning");
      ctx = context;
      acknowledged = new Set(context.sessionManager.getBranch().flatMap((entry) => {
        if (entry.type !== "custom" || entry.customType !== entryType) return [];
        const data = entry.data as { cwd?: unknown; key?: unknown } | undefined;
        return data?.cwd === context.cwd && typeof data.key === "string" ? [data.key] : [];
      }));
      schedule(0);
    },
    stop() {
      generation++;
      controller.abort();
      controller = new AbortController();
      clearTimeout(timer);
      ctx?.ui.setStatus("pinote-pr", undefined);
      ctx = undefined;
      watched = null;
      running = false;
      warned = false;
    },
  };
}
