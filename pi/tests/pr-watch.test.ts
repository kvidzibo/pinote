import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createPRWatcher, taskPR, type WatchedTask } from "../pr-watch.ts";

test("current-task PR watcher confirms safely, reports already-done, and stops with the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldInterval = process.env.PINOTE_PR_POLL_SECONDS;
  process.env.PINOTE_PR_POLL_SECONDS = "10";
  t.after(() => {
    if (oldInterval === undefined) delete process.env.PINOTE_PR_POLL_SECONDS;
    else process.env.PINOTE_PR_POLL_SECONDS = oldInterval;
  });
  const url = "https://github.com/Org/Repo/pull/123";
  const item: WatchedTask = { id: 1, state: "in_progress", updated_at: "r1", agent_notes: { PR: `[Fix #123](${url})` } };
  for (const PR of [`${url} and ${url}`, "https://evil.test/org/repo/pull/123", `${url}\x1b[31m`, "https://github.com/org/../pull/123"]) {
    assert.equal(taskPR({ ...item, agent_notes: { PR } }), undefined);
  }
  let selected: WatchedTask | null = item;
  let state = "OPEN";
  let idle = true;
  let failures = false;
  let checks = 0;
  let completions = 0;
  let confirmations = 0;
  let locked = false;
  let reply = true;
  let duringConfirm: (() => void) | undefined;
  let pendingFetch: (() => Promise<void>) | undefined;
  const entries: any[] = [];
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const ctx: any = {
    cwd: "/tmp/project", mode: "tui", hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: { fg: (color: string, value: string) => { assert.equal(color, "mdLink"); return `\x1b[34m${value}\x1b[39m`; } },
      setStatus: (key: string, value?: string) => statuses.set(key, value),
      notify: (message: string) => notices.push(message),
      confirm: async () => { confirmations++; duringConfirm?.(); return reply; },
    },
  };
  const pi: any = {
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    exec: async (command: string, args: string[], opts: any) => {
      checks++;
      assert.equal(command, "gh");
      assert.deepEqual(args, ["pr", "view", url, "--json", "state,url"]);
      assert.equal(opts.timeout, 10_000);
      await pendingFetch?.();
      return { code: failures ? 1 : 0, stdout: JSON.stringify({ state, url: url.toLowerCase() }), killed: false };
    },
  };
  const watcher = createPRWatcher(pi, {
    selected: async () => selected && structuredClone(selected),
    get: async (id) => { assert.equal(id, item.id); return structuredClone(item); },
    done: async (current, canAct) => {
      assert.ok(canAct());
      assert.equal(current.updated_at, item.updated_at);
      completions++; item.state = "done"; selected = null;
    },
    claim: () => { if (locked) return; locked = true; return () => { locked = false; }; },
    refresh: async () => { watcher.update({ ...ctx }, selected); },
  });
  t.after(() => watcher.stop());
  const tick = async (ms = 10_000) => { t.mock.timers.tick(ms); for (let n = 0; n < 12; n++) await setImmediate(); };
  watcher.start(ctx);
  await tick(0);
  assert.equal(checks, 1);
  assert.match(statuses.get("pinote-pr")!, /\x1b\]8;;https:\/\/github.com\/org\/repo\/pull\/123\x1b\\PR #123/iu);
  assert.match(statuses.get("pinote-pr")!, /^\x1b\[34m/);
  await tick(9999); assert.equal(checks, 1);
  failures = true;
  await tick(1); await tick();
  assert.equal(notices.length, 1, "failed polls warn once");
  failures = false; state = "MERGED"; idle = false;
  await tick(); assert.equal(confirmations, 0, "wait for idle");
  idle = true; locked = true;
  await tick(); assert.equal(confirmations, 0, "do not overlap /pinote or tools");
  locked = false;
  duringConfirm = () => { item.updated_at = "r2"; };
  await tick();
  assert.equal(completions, 0, "a changed revision needs a new confirmation");
  duringConfirm = undefined;
  await tick();
  assert.equal(completions, 1);
  assert.equal(statuses.get("pinote-pr"), undefined, "completion immediately hides the PR link");
  const acknowledgedChecks = checks;
  await tick();
  assert.equal(checks, acknowledgedChecks, "do not repeatedly query an acknowledged merge");
  assert.equal(confirmations, 2);

  // Reload after completion: selection is gone, but the saved watcher identity remains.
  watcher.start(ctx); await tick(0);
  assert.equal(statuses.get("pinote-pr"), undefined, "restored completed watches stay hidden");
  assert.equal(confirmations, 2);

  // Restore an active selection and resume: persistent session entries suppress the same notice.
  item.state = "in_progress"; selected = item;
  watcher.start(ctx); await tick(0);
  assert.equal(confirmations, 2);
  entries.length = 0;
  watcher.start(ctx);
  state = "OPEN"; await tick(0);
  item.state = "done"; selected = null; state = "MERGED";
  watcher.update(ctx, selected);
  assert.equal(statuses.get("pinote-pr"), undefined, "selection clearing hides the link before the next poll");
  await tick();
  assert.equal(statuses.get("pinote-pr"), undefined, "merge polling cannot repaint the retained task");
  assert.match(notices.at(-1)!, /PR #123 was merged and the task is already completed/);
  assert.equal(completions, 1);
  assert.equal(confirmations, 2);

  entries.length = 0; item.state = "active"; selected = item; reply = false;
  watcher.start(ctx); await tick(0); await tick();
  assert.equal(confirmations, 3, "decline is acknowledged without completing");
  assert.equal(completions, 1);

  entries.length = 0;
  duringConfirm = () => { selected = { ...item, id: 2, agent_notes: {} }; };
  reply = true; watcher.start(ctx); await tick(0);
  assert.equal(completions, 1, "selection switch during confirmation cannot complete the old task");
  assert.equal(entries.filter((entry) => entry.customType === "pinote-pr-acknowledged").length, 0);
  assert.equal(statuses.get("pinote-pr"), undefined);

  duringConfirm = undefined; selected = item;
  let release!: () => void;
  pendingFetch = () => new Promise<void>((resolve) => { release = resolve; });
  watcher.start(ctx); await tick(0);
  const beforeShutdown = confirmations;
  watcher.stop(); release(); await tick();
  assert.equal(confirmations, beforeShutdown, "late network results cannot prompt after shutdown");
  assert.equal(statuses.get("pinote-pr"), undefined);
  pendingFetch = undefined;
  const stoppedChecks = checks;
  watcher.start({ ...ctx, hasUI: false, mode: "print" }); await tick();
  assert.equal(checks, stoppedChecks);
  process.env.PINOTE_PR_POLL_SECONDS = "0";
  watcher.start(ctx); watcher.update(ctx, item); await tick();
  assert.equal(checks, stoppedChecks);
  assert.match(statuses.get("pinote-pr")!, /PR #123/);
  item.state = "done"; selected = null;
  watcher.update(ctx, selected); await tick();
  assert.equal(checks, stoppedChecks);
  assert.equal(statuses.get("pinote-pr"), undefined, "completion hides the link even with polling disabled");
});

test("Kitty tab progress lasts only while merge confirmation needs input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const oldInterval = process.env.PINOTE_PR_POLL_SECONDS;
  const oldKitty = process.env.KITTY_WINDOW_ID;
  const oldTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  process.env.PINOTE_PR_POLL_SECONDS = "10";
  process.env.KITTY_WINDOW_ID = "1";
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  t.after(() => {
    if (oldInterval === undefined) delete process.env.PINOTE_PR_POLL_SECONDS;
    else process.env.PINOTE_PR_POLL_SECONDS = oldInterval;
    if (oldKitty === undefined) delete process.env.KITTY_WINDOW_ID;
    else process.env.KITTY_WINDOW_ID = oldKitty;
    if (oldTTY) Object.defineProperty(process.stdout, "isTTY", oldTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  });
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (value: unknown, ...args: unknown[]) => {
    if (typeof value === "string" && value.startsWith("\x1b]9;4;")) { writes.push(value); return true; }
    return Reflect.apply(originalWrite, process.stdout, [value, ...args]);
  });
  const busy = "\x1b]9;4;3\x1b\\";
  const clear = "\x1b]9;4;0\x1b\\";
  const task: WatchedTask = { id: 1, state: "active", updated_at: "r1", agent_notes: { PR: "https://github.com/org/repo/pull/1" } };
  const entries: any[] = [];
  let idle = false;
  let confirmations = 0;
  let reply!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const ctx: any = {
    cwd: "/tmp/project", mode: "tui", hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {}, notify() {},
      confirm: (_title: string, _message: string, options: { signal: AbortSignal }) => {
        assert.equal(options.signal.aborted, false);
        confirmations++;
        return new Promise<boolean>((resolve, fail) => { reply = resolve; reject = fail; });
      },
    },
  };
  const watcher = createPRWatcher({
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    exec: async () => ({ code: 0, killed: false, stdout: JSON.stringify({ state: "MERGED", url: task.agent_notes.PR }) }),
  } as any, {
    selected: async () => task, get: async () => task,
    done: async () => { throw new Error("declined prompts must not complete tasks"); },
    claim: () => () => {}, refresh: async () => {},
  });
  t.after(() => watcher.stop());
  const tick = async (ms = 0) => { t.mock.timers.tick(ms); for (let n = 0; n < 12; n++) await setImmediate(); };
  watcher.start(ctx); await tick();
  assert.deepEqual(writes, [], "busy Pi must not signal a prompt");
  idle = true; await tick(10_000);
  assert.deepEqual(writes, [busy]);
  await tick(125);
  assert.deepEqual(writes, [busy, busy], "refresh progress while waiting for input");
  assert.equal(confirmations, 1);
  reply(false); await tick();
  assert.deepEqual(writes, [busy, busy, clear]);
  await tick(20_000);
  assert.equal(writes.length, 3, "acknowledged merges never keep or restart progress");

  entries.length = 0;
  watcher.start(ctx); await tick();
  const oldReply = reply;
  watcher.stop();
  assert.equal(writes.at(-1), clear, "shutdown clears even if the dialog ignores abort");
  const stopped = writes.length;
  await tick(1000);
  assert.equal(writes.length, stopped);
  watcher.start(ctx); await tick();
  assert.equal(writes.at(-1), busy);
  const restarted = writes.length;
  oldReply(false); await tick();
  assert.equal(writes.length, restarted, "an old dialog cannot clear a replacement session's indicator");
  reject(new Error("dialog failed")); await tick();
  assert.equal(writes.at(-1), clear, "dialog errors also clear progress");
  watcher.stop();

  for (const terminal of ["other", "redirected"]) {
    if (terminal === "other") delete process.env.KITTY_WINDOW_ID;
    else {
      process.env.KITTY_WINDOW_ID = "1";
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    }
    entries.length = 0;
    const before: number = writes.length;
    watcher.start(ctx); await tick();
    reply(false); await tick();
    watcher.stop();
    assert.equal(writes.length, before, "other terminals and redirected stdout get no Kitty sequences");
  }
});
