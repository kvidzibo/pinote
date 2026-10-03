import assert from "node:assert/strict";
import { test } from "node:test";
import { updateTaskFooter, clearTaskFooter, taskPR, type FooterTask } from "../footer-status.ts";

test("task PR parsing and footer rendering retain active-task visibility", () => {
  const url = "https://github.com/Org/Repo/pull/123";
  const item: FooterTask = {
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
  assert.deepEqual(taskPR(item), { url, number: "123" });

  const statuses = new Map<string, string | undefined>();
  const ctx: any = {
    hasUI: true, mode: "tui",
    ui: {
      theme: { fg: (color: string, value: string) => { assert.equal(color, "mdLink"); return `\x1b[34m${value}\x1b[39m`; } },
      setStatus: (key: string, value?: string) => statuses.set(key, value),
    },
  };
  updateTaskFooter(ctx, item);
  assert.match(statuses.get("pinote-links")!, /\x1b\]8;;https:\/\/github\.com\/org\/repo\/pull\/123\x1b\\PR #123/iu);
  assert.match(statuses.get("pinote-links")!, /Dashboard: \x1b\[34m\x1b\]8;;https:\/\/example\.com\/d\/app\x1b\\Metrics/);
  assert.match(statuses.get("pinote-links")!, /Next: Review/);
  assert.doesNotMatch(statuses.get("pinote-links")!, /Missing/);
  assert.equal(statuses.get("pinote-pr"), undefined, "the old PR status key stays clear");
  assert.match(statuses.get("pinote-links")!, /^\x1b\[34m/);

  for (const state of ["done", "removed", "scheduled"]) {
    updateTaskFooter(ctx, { ...item, state });
    assert.equal(statuses.get("pinote-links"), undefined, `${state} tasks clear the footer`);
  }
  updateTaskFooter(ctx, null);
  assert.equal(statuses.get("pinote-links"), undefined, "clearing selection hides the footer");
  updateTaskFooter(ctx, item, {
    titleWidth: 60, fieldWidth: 60, maxFields: 4,
    fields: [{ name: "Next", label: "Up next", link: true, format: "<value>" }],
  });
  assert.equal(statuses.get("pinote-links"), "Up next: Review");
  clearTaskFooter(ctx);
  assert.equal(statuses.get("pinote-pr"), undefined);
  assert.equal(statuses.get("pinote-links"), undefined);
});
