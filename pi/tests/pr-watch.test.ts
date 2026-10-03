import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createPRWatcher, taskPR, type WatchedTask } from "../pr-watch.ts";

test("merged PRs notify without completing, and acknowledgements survive resume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldInterval = process.env.PINOTE_PR_POLL_SECONDS;
  process.env.PINOTE_PR_POLL_SECONDS = "10";
  t.after(() => {
    if (oldInterval === undefined) delete process.env.PINOTE_PR_POLL_SECONDS;
    else process.env.PINOTE_PR_POLL_SECONDS = oldInterval;
  });
  const url = "https://github.com/Org/Repo/pull/123";
  const item: WatchedTask = {
    id: 1, state: "in_progress", updated_at: "r1",
    agent_notes: {
      PR: `[Fix #123](${url})`,
      Dashboard: "[Metrics](https://example.com/d/app)",
      Next: "Review",
      Bar: "Dashboard\nNext\nMissing",
    },
  };
  for (const PR of [`${url} and ${url}`, "https://evil.test/org/repo/pull/123", `${url}\x1b[31m`, "https://github.com/org/../pull/123"]) {
    assert.equal(taskPR({ ...item, agent_notes: { PR } }), undefined);
  }
  let selected: WatchedTask | null = item;
  let state = "OPEN";
  let idle = true;
  let failures = false;
  let checks = 0;
  let confirmations = 0;
  let locked = false;
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
      confirm: async () => { confirmations++; throw new Error("unexpected confirmation"); },
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
    claim: () => { if (locked) return; locked = true; return () => { locked = false; }; },
    refresh: async () => { watcher.update({ ...ctx }, selected); },
  });
  t.after(() => watcher.stop());
  const tick = async (ms = 10_000) => { t.mock.timers.tick(ms); for (let n = 0; n < 12; n++) await setImmediate(); };
  watcher.start(ctx);
  await tick(0);
  assert.equal(checks, 1);
  assert.match(statuses.get("pinote-links")!, /\x1b\]8;;https:\/\/github\.com\/org\/repo\/pull\/123\x1b\\PR #123/iu);
  assert.match(statuses.get("pinote-links")!, /Dashboard: \x1b\[34m\x1b\]8;;https:\/\/example\.com\/d\/app\x1b\\Metrics/);
  assert.match(statuses.get("pinote-links")!, /Next: Review/);
  assert.doesNotMatch(statuses.get("pinote-links")!, /Missing/);
  assert.equal(statuses.get("pinote-pr"), undefined, "the old PR status key stays clear");
  assert.match(statuses.get("pinote-links")!, /^\x1b\[34m/);
  await tick(9999); assert.equal(checks, 1);
  failures = true;
  await tick(1); await tick();
  assert.equal(notices.length, 1, "failed polls warn once");
  failures = false; state = "MERGED"; idle = false;
  await tick(); assert.equal(entries.filter((entry) => entry.customType === "pinote-pr-acknowledged").length, 0, "wait for idle");
  idle = true; locked = true;
  await tick(); assert.equal(entries.filter((entry) => entry.customType === "pinote-pr-acknowledged").length, 0, "do not overlap /pinote or tools");
  locked = false;
  await tick();
  const message = "PR #123 was merged. Complete the task with the footer ✓ action or /pi-note-done.";
  assert.equal(notices.at(-1), message);
  assert.equal(item.state, "in_progress", "merged PR notification never completes the task");
  assert.equal(confirmations, 0, "merged PR notification never asks for confirmation");
  assert.equal(entries.filter((entry) => entry.customType === "pinote-pr-acknowledged").length, 1, "persist one acknowledgement");
  const acknowledgedChecks = checks;
  await tick();
  assert.equal(checks, acknowledgedChecks, "do not repeatedly query an acknowledged merge");
  assert.equal(notices.filter((notice) => notice === message).length, 1);

  // Reload with the active task selected: persisted acknowledgement suppresses another notice.
  watcher.start(ctx); await tick(0);
  assert.equal(notices.filter((notice) => notice === message).length, 1);
  assert.equal(confirmations, 0);

  // Completion clears selection but keeps the watch, including after reload.
  entries.length = 0; state = "OPEN";
  watcher.start(ctx); await tick(0);
  item.state = "done"; selected = null;
  watcher.update(ctx, selected);
  assert.equal(statuses.get("pinote-links"), undefined, "completion immediately hides the PR link");
  watcher.start(ctx); state = "MERGED"; await tick(0);
  assert.match(notices.at(-1)!, /PR #123 was merged and the task is already completed/);
  assert.equal(statuses.get("pinote-links"), undefined, "retained completed watches never repaint footer links");
  assert.equal(item.state, "done");
  assert.equal(confirmations, 0);

  // A changed selection during the GitHub request is not acknowledged or notified.
  entries.length = 0; item.state = "active"; selected = item;
  let release!: () => void;
  pendingFetch = () => new Promise<void>((resolve) => { release = resolve; });
  watcher.start(ctx); await tick(0);
  selected = { ...item, id: 2, agent_notes: {} };
  release(); await tick();
  assert.equal(entries.filter((entry) => entry.customType === "pinote-pr-acknowledged").length, 0);
  assert.equal(notices.filter((notice) => notice === message).length, 1);

  // Late network results cannot notify or persist after shutdown.
  selected = item;
  watcher.start(ctx); await tick(0);
  const beforeShutdownNotices = notices.length;
  watcher.stop(); release(); await tick();
  assert.equal(notices.length, beforeShutdownNotices);
  assert.equal(confirmations, 0);
  assert.equal(statuses.get("pinote-links"), undefined);
  pendingFetch = undefined;
  const stoppedChecks = checks;
  watcher.start({ ...ctx, hasUI: false, mode: "print" }); await tick();
  assert.equal(checks, stoppedChecks);
  process.env.PINOTE_PR_POLL_SECONDS = "0";
  watcher.start(ctx); watcher.update(ctx, item); await tick();
  assert.equal(checks, stoppedChecks);
  assert.match(statuses.get("pinote-links")!, /PR #123/);
  item.state = "done"; selected = null;
  watcher.update(ctx, selected); await tick();
  assert.equal(checks, stoppedChecks);
  assert.equal(statuses.get("pinote-links"), undefined, "completion hides the link even with polling disabled");
});
