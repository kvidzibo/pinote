import assert from "node:assert/strict";
import { test } from "node:test";
import { setupCLI, cliSource } from "../setup.ts";
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

  // Cancellation and missing uv never install.
  results = [new Error("missing note"), { code: 0, stdout: "uv 0.6" }];
  await setupCLI(pi, context(async () => false), false, active, signal);
  assert.equal(calls.length, 2); // note probe, uv probe
  assert.ok(!calls.some((call) => call.args.includes("install")));
  calls.length = 0;
  results = [new Error("missing note"), new Error("missing uv")];
  await setupCLI(pi, ctx, false, active, signal);
  assert.equal(calls.length, 2);
  assert.match(notices.at(-1)!.message, /Install uv/);

  // Compatible CLI is a no-op; installer uses exact pinned arguments.
  calls.length = 0;
  results = [{ code: 0, stdout: "pinote 0.3.1\n" }];
  await setupCLI(pi, ctx, false, active, signal);
  assert.deepEqual(calls, [{ command: "note", args: ["--version"] }]);
  calls.length = 0;
  results = [{ code: 0, stdout: "uv 0.6" }, { code: 0 }, { code: 0, stdout: "pinote 0.3.0" }];
  await setupCLI(pi, ctx, true, active, signal);
  assert.match(notices.at(-1)!.message, /is ready/);
  assert.deepEqual(calls[1], { command: "uv", args: ["--no-config", "tool", "install", "--reinstall", "--python", ">=3.11", `pinote @ ${cliSource}`] });

  calls.length = 0;
  results = [{ code: 0 }, { code: 1, stderr: "network down" }];
  await assert.rejects(setupCLI(pi, ctx, true, active, signal), /network down/);
  calls.length = 0;
  results = [{ code: 0 }, { code: 0 }, { code: 0, stdout: "pinote 0.2.0" }];
  await setupCLI(pi, ctx, true, active, signal);
  assert.match(notices.at(-1)!.message, /PATH/);

  // A session invalidated while confirmation is open must not launch installation.
  calls.length = 0;
  let valid = true;
  results = [{ code: 0 }];
  await setupCLI(pi, context(async () => { valid = false; return true; }), true, () => valid, signal);
  assert.deepEqual(calls, [{ command: "uv", args: ["--version"] }]);

  // Losing idle status after installation starts must not hide an install failure.
  valid = true;
  await assert.rejects(setupCLI({ exec: async (_command: string, args: string[]) => {
    if (args.includes("install")) { valid = false; return { code: 1, stderr: "late failure" }; }
    return { code: 0 };
  } } as any, ctx, true, () => valid, signal), /late failure/);

  // Session replacement must hold the setup lock until the aborted child exits.
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const tools = new Map<string, any>();
  let finishInstall!: () => void;
  let started!: () => void;
  const installing = new Promise<void>((resolve) => { started = resolve; });
  let installs = 0;
  const taskCalls: string[][] = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const savedPoll = process.env.PINOTE_PR_POLL_SECONDS;
  process.env.PINOTE_PR_POLL_SECONDS = "60";
  t.after(() => {
    if (savedPoll === undefined) delete process.env.PINOTE_PR_POLL_SECONDS;
    else process.env.PINOTE_PR_POLL_SECONDS = savedPoll;
  });
  pinote({
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
        if (args[0] === "--version") return { code: 0, stdout: "pinote 0.3.0" };
        taskCalls.push(args);
        return { code: 0, stdout: "null" };
      }
      return { code: 0, stdout: "uv 0.6" };
    },
  } as any);
  const commandCtx: any = { ...ctx, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [] }, ui: { ...ctx.ui, setStatus() {} } };
  await events.get("session_start")({}, commandCtx);
  const setup = commands.get("pi-note-setup").handler("--upgrade", commandCtx);
  await installing;
  const replacementCtx = { ...commandCtx, cwd: "/tmp/replacement-project" };
  await events.get("session_start")({}, replacementCtx);
  const countWhileInstalling = taskCalls.length;
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(taskCalls.length, countWhileInstalling, "PR polls stay paused during setup");
  assert.ok(!notices.some(({ message }) => message.includes("PR check failed")));
  await commands.get("pi-note-setup").handler("--upgrade", commandCtx);
  assert.equal(installs, 1);
  assert.match(notices.at(-1)!.message, /Wait until Pi is idle/);
  await assert.rejects(tools.get("pinote_get").execute("get", {}, undefined, undefined, commandCtx), /setup is still running/);
  finishInstall();
  await setup;
  assert.deepEqual(taskCalls.at(-1), ["agent", "selected", "--cwd", replacementCtx.cwd]);
  await events.get("session_shutdown")({}, replacementCtx);
});
