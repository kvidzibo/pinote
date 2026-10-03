import assert from "node:assert/strict";
import { test } from "node:test";
import { setupCLI, cliSource, cliAction } from "../setup.ts";
import pinote from "../index.ts";

const context = (confirm: () => Promise<boolean>) => ({
  ui: { confirm, notify: (message: string, level: string) => notices.push({ message, level }) },
} as any);
let notices: Array<{ message: string; level: string }> = [];

test("setup CLI gates installation and uses the immutable uv source", async (t) => {
  const calls: Array<{ command: string; args: string[] }> = [];
  notices = [];
  let results: any[] = [];
  const pi = { exec: async (command: string, args: string[]) => {
    calls.push({ command, args });
    const result = results.shift();
    if (result instanceof Error) throw result;
    return result;
  } } as any;
  const active = () => true;
  const signal = new AbortController().signal;
  const ctx = context(async () => true);

  assert.equal(cliAction("pinote 0.2.99"), "upgrade");
  assert.equal(cliAction("pinote 0.3.0"), "upgrade");
  assert.equal(cliAction("pinote 0.4.0"), "ready");
  assert.equal(cliAction("pinote 1.0.0"), "ready");

  // Probe note before uv; setup handles missing CLIs, upgrade handles older versions.
  results = [new Error("missing note"), { code: 0, stdout: "uv 0.6" }];
  await setupCLI(pi, context(async () => false), false, active, signal);
  assert.equal(calls.length, 2); // note probe, uv probe
  assert.ok(!calls.some((call) => call.args.includes("install")));
  calls.length = 0;
  results = [new Error("missing note"), new Error("missing uv")];
  await setupCLI(pi, ctx, false, active, signal);
  assert.equal(calls.length, 2);
  assert.match(notices.at(-1)!.message, /Install uv/);

  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 0.4.1\n" }];
  await setupCLI(pi, ctx, false, active, signal);
  assert.deepEqual(calls, [{ command: "note", args: ["--version"] }]);
  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 0.2.9" }];
  await setupCLI(pi, context(async () => true), false, active, signal);
  assert.match(notices.at(-1)!.message, /pi-note-upgrade/);
  assert.deepEqual(calls.at(-1), { command: "note", args: ["--version"] });
  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 1.0.0" }];
  await setupCLI(pi, ctx, true, active, signal);
  assert.match(notices.at(-1)!.message, /ready/);
  assert.deepEqual(calls, [{ command: "note", args: ["--version"] }]);
  calls.length = 0;
  results = [new Error("missing note"), { code: 0, stdout: "uv 0.6" }, new Error("missing note"), { code: 0 }, { code: 0, stdout: "pinote 0.4.0" }];
  await setupCLI(pi, ctx, false, active, signal);
  assert.match(notices.at(-1)!.message, /is ready/);
  assert.deepEqual(calls[3], { command: "uv", args: ["--no-config", "tool", "install", "--reinstall", "--python", ">=3.11", `pinote @ ${cliSource}`] });

  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 0.2.0" }, { code: 0 }, { code: 0, stdout: "pinote 0.2.0" }, { code: 1, stderr: "network down" }];
  await assert.rejects(setupCLI(pi, ctx, true, active, signal), /network down/);
  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 0.2.0" }, { code: 0 }, { code: 0, stdout: "pinote 0.2.0" }, { code: 0 }, { code: 0, stdout: "pinote 0.2.0" }];
  await setupCLI(pi, ctx, true, active, signal);
  assert.match(notices.at(-1)!.message, /PATH/);

  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 0.2.0" }, { code: 0 }, { code: 0, stdout: "pinote 1.0.0" }];
  await setupCLI(pi, ctx, true, active, signal);
  assert.match(notices.at(-1)!.message, /installation skipped/);
  assert.ok(!calls.some((call) => call.args.includes("install")), "external upgrade during confirmation must not be downgraded");

  // A session invalidated while confirmation is open must not launch installation.
  calls.length = 0;
  let valid = true;
  results = [{ code: 0, stdout: "pinote 0.2.0" }, { code: 0 }];
  await setupCLI(pi, context(async () => { valid = false; return true; }), true, () => valid, signal);
  assert.deepEqual(calls, [{ command: "note", args: ["--version"] }, { command: "uv", args: ["--version"] }]);

  // Losing idle status after installation starts must not hide an install failure.
  valid = true;
  await assert.rejects(setupCLI({ exec: async (_command: string, args: string[]) => {
    if (args.includes("install")) { valid = false; return { code: 1, stderr: "late failure" }; }
    return { code: 0, stdout: "pinote 0.2.0" };
  } } as any, ctx, true, () => valid, signal), /late failure/);

  // Session replacement must hold the setup lock until the aborted child exits.
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const tools = new Map<string, any>();
  let finishInstall!: () => void;
  let started!: () => void;
  const installing = new Promise<void>((resolve) => { started = resolve; });
  let installs = 0;
  let cliVersion = "pinote 0.2.0";
  const taskCalls: string[][] = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const savedPoll = process.env.PINOTE_PR_POLL_SECONDS;
  process.env.PINOTE_PR_POLL_SECONDS = "60";
  t.after(() => {
    if (savedPoll === undefined) delete process.env.PINOTE_PR_POLL_SECONDS;
    else process.env.PINOTE_PR_POLL_SECONDS = savedPoll;
  });
  pinote({
    registerEntryRenderer() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => events.set(name, handler),
    exec: async (_command: string, args: string[]) => {
      if (args.includes("install")) {
        installs++;
        started();
        await new Promise<void>((resolve) => { finishInstall = resolve; });
        return { code: 1, killed: true };
      }
      if (_command === "note") {
        if (args[0] === "--version") return { code: 0, stdout: cliVersion };
        taskCalls.push(args);
        return { code: 0, stdout: "null" };
      }
      return { code: 0, stdout: "uv 0.6" };
    },
  } as any);
  const commandCtx: any = { ...ctx, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [] }, ui: { ...ctx.ui, setStatus() {}, addAutocompleteProvider() {} } };
  await events.get("session_start")({}, commandCtx);
  const setup = commands.get("pi-note-upgrade").handler("", commandCtx);
  await installing;
  const replacementCtx = { ...commandCtx, cwd: "/tmp/replacement-project" };
  await events.get("session_start")({}, replacementCtx);
  const countWhileInstalling = taskCalls.length;
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(taskCalls.length, countWhileInstalling, "PR polls stay paused during setup");
  assert.ok(!notices.some(({ message }) => message.includes("PR check failed")));
  await commands.get("pi-note-upgrade").handler("", commandCtx);
  assert.equal(installs, 1);
  assert.match(notices.at(-1)!.message, /Wait until Pi is idle/);
  await assert.rejects(tools.get("pinote_get_current").execute("get", {}, undefined, undefined, commandCtx), /setup is still running/);
  cliVersion = "pinote 0.4.0";
  finishInstall();
  await setup;
  assert.ok(!taskCalls.some((args) => args.includes("selected") || args.includes(commandCtx.cwd)));
  assert.equal((await tools.get("pinote_get_current").execute("get", {}, undefined, undefined, replacementCtx)).details, null);
  await events.get("session_shutdown")({}, replacementCtx);
});

test("tree navigation during setup restores the active branch", async () => {
  const entries: Array<{ type: string; customType: string; data: { id: number | null } }> = [];
  let finishInstall!: () => void;
  let started!: () => void;
  const installing = new Promise<void>((resolve) => { started = resolve; });
  let cliVersion = "pinote 0.2.0";
  let status: string | undefined;
  const task = {
    id: 4, text: "Branch task", state: "in_progress", tag: null, updated_at: "r4",
    agent_notes: {}, markdown: "Branch task",
  };
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const tools = new Map<string, any>();
  pinote({
    registerEntryRenderer() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => events.set(name, handler),
    appendEntry: (customType: string, data: { id: number | null }) => entries.push({ type: "custom", customType, data }),
    exec: async (command: string, args: string[]) => {
      if (args.includes("install")) {
        started();
        await new Promise<void>((resolve) => { finishInstall = resolve; });
        cliVersion = "pinote 0.4.0";
        return { code: 0, stdout: "" };
      }
      if (command === "note" && args[0] === "--version") return { code: 0, stdout: cliVersion };
      if (command === "note" && args[1] === "get") return { code: 0, stdout: JSON.stringify(task) };
      if (command === "uv") return { code: 0, stdout: "uv 0.6" };
      return { code: 0, stdout: "null" };
    },
  } as any);
  const ctx: any = {
    cwd: "/tmp/project", mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (key: string, value?: string) => { if (key === "pinote") status = value; },
      notify() {}, addAutocompleteProvider() {}, confirm: async () => true,
      theme: { fg: (_color: string, value: string) => value },
    },
  };
  await events.get("session_start")({}, ctx);
  const setup = commands.get("pi-note-upgrade").handler("", ctx);
  await installing;
  entries.push({ type: "custom", customType: "pinote-selection", data: { id: 4 } });
  await events.get("session_tree")({}, ctx);
  finishInstall();
  await setup;
  assert.match(status!, /Branch task/);
  assert.equal((await tools.get("pinote_get_current").execute("get", {}, undefined, undefined, ctx)).details.id, 4);
  await events.get("session_shutdown")({}, ctx);
});
