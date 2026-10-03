import assert from "node:assert/strict";
import { test } from "node:test";
import pinote from "../index.ts";

test("current-task operations reject navigation during reads, write probes and pending writes", async () => {
  const tasks = [1, 2].map((id) => ({
    id, text: `Task ${id}`, state: "in_progress", tag: null, updated_at: "same-revision",
    agent_notes: {}, markdown: `Task ${id}`,
  }));
  const entries = [{ type: "custom", customType: "pinote-selection", data: { id: 1 } }];
  const ctx: any = { hasUI: false, mode: "print", sessionManager: { getBranch: () => entries } };
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  let switchOn: "get" | "probe" | undefined;
  let navigateDuringWrite: "branch" | "session" | undefined;
  let switchTo = 2;
  let probes = 0;
  let writes = 0;
  const switchBranch = async () => {
    switchOn = undefined;
    entries.push({ type: "custom", customType: "pinote-selection", data: { id: switchTo } });
    await events.get("session_tree")({}, ctx);
  };
  const success = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "", killed: false });
  pinote({
    registerEntryRenderer() {}, registerCommand() {}, appendEntry() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => events.set(name, handler),
    async exec(_command: string, args: string[]) {
      if (args[0] === "--version") {
        if (++probes === 3 && switchOn === "probe") await switchBranch();
        return { code: 0, stdout: "pinote 0.4.0", stderr: "", killed: false };
      }
      const task = tasks.find((task) => task.id === Number(args[2]));
      assert.ok(task);
      if (args[1] === "get") {
        if (switchOn === "get") await switchBranch();
        return success(task);
      }
      assert.equal(args[1], "update");
      writes++;
      Object.assign(task.agent_notes, JSON.parse(args[args.indexOf("--set-json") + 1]));
      if (navigateDuringWrite === "branch") await switchBranch();
      if (navigateDuringWrite === "session") await events.get("session_start")({}, ctx);
      return success(task);
    },
  } as any);
  await events.get("session_start")({}, ctx);
  const get = () => tools.get("pinote_get_current").execute("get", {}, undefined, undefined, ctx);
  const update = () => tools.get("pinote_update_current").execute("update", {
    expected_updated_at: "same-revision", set: { Next: "Saved" },
  }, undefined, undefined, ctx);
  assert.equal((await get()).details.id, 1);
  switchOn = "get";
  assert.equal((await get()).details, null, "a stale current-task read must not return the old task");
  for (const [phase, target] of [["get", 2], ["probe", 2], ["probe", 1]] as const) {
    entries.push({ type: "custom", customType: "pinote-selection", data: { id: 1 } });
    await events.get("session_tree")({}, ctx);
    probes = 0;
    switchOn = phase;
    switchTo = target;
    await assert.rejects(update(), /cancelled/);
    assert.equal(writes, 0, "neither the old nor the new task may be mutated after navigation");
  }
  assert.equal((await update()).details.id, 1);
  assert.equal(writes, 1);
  assert.deepEqual(tasks[0].agent_notes, { Next: "Saved" });
  assert.deepEqual(tasks[1].agent_notes, {});
  for (const [navigation, target] of [["branch", 2], ["branch", 1], ["session", 1]] as const) {
    entries.push({ type: "custom", customType: "pinote-selection", data: { id: 1 } });
    await events.get("session_tree")({}, ctx);
    navigateDuringWrite = navigation;
    switchTo = target;
    const previousWrites: number = writes;
    await assert.rejects(update(), /write may have committed/);
    assert.equal(writes, previousWrites + 1, "a committed write must not be reported as stale success");
    assert.deepEqual(tasks[1].agent_notes, {}, "navigation must not redirect the pending write to another task");
  }
  navigateDuringWrite = undefined;
  await events.get("session_shutdown")({}, ctx);
});
