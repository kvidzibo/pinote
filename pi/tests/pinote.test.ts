import assert from "node:assert/strict";
import { test } from "node:test";
import pinote from "../index.ts";
import { CombinedAutocompleteProvider, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("task selection, handoff, guarded Done and tools stay session-local without submission", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-note-unit-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const tasks = [
    { id: 1, text: "Older task", state: "active", tag: null, updated_at: "r1", agent_notes: {} as Record<string, string>, markdown: "Older task" },
    { id: 2, text: "Unicode 日本語 task\nHidden details", state: "active", tag: null, updated_at: "r2", agent_notes: {} as Record<string, string>, markdown: "Unicode 日本語 task" },
  ];
  let cliVersion = "pinote 0.2.0";
  const entries: Array<{ type: string; customType: string; data: { id: number | null } }> = [];
  const sessionTask = (sessionEntries = entries) => {
    let id: number | null = null;
    for (const entry of sessionEntries) if (entry.customType === "pinote-selection") id = entry.data.id;
    return id;
  };
  const autocompleteWrappers: Array<(current: any) => any> = [];
  let failSelection = false;
  let beforeChoice: (() => void) | undefined;
  let delaySelected: (() => Promise<void>) | undefined;
  let draft = "Existing draft";
  let status: string | undefined;
  const calls: string[][] = [];
  const notices: string[] = [];
  const choices: Array<string | undefined> = [];
  const success = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "", killed: false });
  const ctx: any = {
    cwd: "/tmp/project", hasUI: true, mode: "tui", isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (key: string, value?: string) => { if (key === "pinote") status = value; },
      notify: (value: string) => { notices.push(value); },
      addAutocompleteProvider: (wrapper: any) => autocompleteWrappers.push(wrapper),
      getEditorText: () => draft,
      setEditorText: (value: string) => { draft = value; },
      custom: async (factory: any) => new Promise((resolve) => {
        const picker = factory({ requestRender() {} }, ctx.ui.theme, {
          matches: (data: string, action: string) => getKeybindings().matches(data, action as any),
        }, resolve);
        beforeChoice?.();
        const choice = choices.shift();
        if (picker.render(100).join("\n").includes("Continue")) {
          resolve(choice === "pick" ? "Continue" : choice); return;
        }
        if (choice === "save-fields") {
          const down = (n: number) => { for (let i = 0; i < n; i++) picker.handleInput("\x1b[B"); };
          const enter = () => picker.handleInput("\r");
          down(4); enter(); down(4); enter(); // remove PR
          down(4); enter(); picker.handleInput("Next"); enter(); // add
          enter(); // link off
          down(1); enter(); picker.handleInput("\x0b"); enter(); // blank label
          picker.handleInput("\x1b");
          down(1); enter(); picker.handleInput("\x0b"); picker.handleInput("30"); enter();
          picker.handleInput("\x1b"); return;
        }
        if (choice === "older") { resolve(1); return; }
        picker.handleInput(choice === "pick" ? "\r" : "\x1b");
      }),
      select: async (_title: string, labels: string[]) => {
        beforeChoice?.();
        const choice = choices.shift();
        if (choice === "pick") return labels[0];
        assert.ok(choice === undefined || labels.includes(choice));
        return choice;
      },
    },
  };
  function load(sessionEntries = entries, session = ctx) {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const events = new Map<string, any>();
    pinote({
      registerCommand: (name: string, definition: any) => commands.set(name, definition),
      registerTool: (definition: any) => tools.set(definition.name, definition),
      on: (name: string, callback: any) => events.set(name, callback),
      appendEntry: (customType: string, data: { id: number | null }) =>
        sessionEntries.push({ type: "custom", customType, data }),
      async exec(command: string, args: string[], options: any) {
        assert.equal(command, "note");
        assert.equal(options.timeout, 5000);
        calls.push(args);
        if (args[0] === "--version") return { code: 0, stdout: cliVersion, stderr: "", killed: false };
        const item = tasks.find((value) => value.id === Number(args[2] ?? args[1]));
        if (args[0] === "list") return success(tasks.filter((value) => value.state !== "done"));
        if (args[1] === "get") {
          await delaySelected?.();
          return success(item ?? null);
        }
        if (args[0] === "--no-notify" && args[1] === "start" && !failSelection && item && item.state !== "done") {
          if (item.state === "active") item.state = "in_progress";
          return { code: 0, stdout: `Note ${item.id}: in progress.`, stderr: "", killed: false };
        }
        if (item && ["done", "update"].includes(args[1]) && args[args.indexOf("--expected-updated-at") + 1] === item.updated_at) {
          item.updated_at += "x";
          if (args[1] === "done") item.state = "done";
          else {
            Object.assign(item.agent_notes, JSON.parse(args[args.indexOf("--set-json") + 1]));
            args.forEach((arg) => { if (arg.startsWith("--remove=")) delete item.agent_notes[arg.slice(9)]; });
            item.markdown = `${item.text}\n\n# Agent\n` + Object.entries(item.agent_notes).map(([k, v]) => `${k}: ${v}`).join("\n");
          }
          return success(item);
        }
        return { code: 1, stdout: "", stderr: "Task changed elsewhere", killed: false };
      },
    } as any);
    return {
      command: () => commands.get("pi-note").handler("", session),
      event: (name: string) => events.get(name)({}, session),
      tool: (name: string, params: object, context = session, signal?: AbortSignal) =>
        tools.get(name).execute("call", params, signal, undefined, context),
    };
  }
  let extension = load();
  await extension.event("session_start");
  assert.match(status!, /unavailable/);
  const current = new CombinedAutocompleteProvider(
    ["pi-note", "pi-note-setup", "pi-note-upgrade"].map((name) => ({ name })), "/tmp");
  const menu = autocompleteWrappers.at(-1)!(current);
  const menuNames = async () => (await menu.getSuggestions(["/pi-note"], 0, 8,
    { signal: new AbortController().signal })).items.map((item: any) => item.value).sort();
  assert.deepEqual(await menuNames(), ["pi-note", "pi-note-upgrade"]);
  assert.ok(notices.some((message) => message.includes("Run /pi-note-upgrade")));
  await assert.rejects(extension.tool("pinote_get_current", {}), /requires pinote 0\.3\.0/);
  assert.ok(calls.some((args) => args[0] === "--version"), "unselected current-task reads still probe the CLI version");
  assert.ok(calls.every((args) => args[0] === "--version"), "old CLIs must never receive unknown commands");
  cliVersion = "pinote 0.3.0";
  await extension.event("session_start");
  assert.deepEqual(await menuNames(), ["pi-note", "pi-note-upgrade"]);
  assert.equal((await extension.tool("pinote_get_current", {})).details, null);
  cliVersion = "pinote 0.4.0";
  await extension.event("session_start");
  assert.equal(status, undefined);
  assert.deepEqual(await menuNames(), ["pi-note"]);
  cliVersion = "";
  await extension.event("session_start");
  assert.deepEqual(await menuNames(), ["pi-note", "pi-note-setup"]);
  cliVersion = "pinote 0.2.9";
  await extension.event("session_start");
  assert.deepEqual(await menuNames(), ["pi-note", "pi-note-upgrade"]);
  cliVersion = "pinote 1.0.0";
  const noticeCount = notices.length;
  await extension.event("session_start");
  assert.deepEqual(await menuNames(), ["pi-note"]);
  assert.equal(notices.length, noticeCount, "newer CLI must not trigger an upgrade notice");
  cliVersion = "pinote 0.4.0";
  await extension.event("session_start");
  assert.equal((await extension.tool("pinote_get_current", {})).details, null);
  choices.push(undefined);
  await extension.command();
  assert.equal(sessionTask(), null);
  assert.equal(draft, "Existing draft");
  failSelection = true;
  choices.push("pick");
  await extension.command();
  assert.equal(draft, "Existing draft");
  assert.equal(sessionTask(), null);
  failSelection = false;
  choices.push("pick");
  await extension.command();
  assert.equal(sessionTask(), 2, "newest task is first");
  assert.equal(tasks[1].state, "in_progress");
  assert.ok(!calls.some((args) => args.includes("select") || args.includes("selected")));
  assert.match(status!, /Unicode/);
  assert.ok(!status!.includes("#2"), "footer omits the task ID");
  assert.ok(!status!.includes("Hidden details"), "footer shows only the first line");
  assert.ok(!status!.includes("In progress"), "footer omits state text");
  assert.ok(!/[●○]/u.test(status!), "footer omits state indicators");
  const beforeSettings = JSON.stringify(tasks);
  const draftBeforeSettings = draft;
  choices.push("Settings", "save-fields");
  await extension.command();
  assert.equal(JSON.stringify(tasks), beforeSettings, "global settings do not write task values");
  assert.equal(draft, draftBeforeSettings);
  const configuredFields = (await extension.tool("pinote_fields", {})).details.fields;
  assert.deepEqual(configuredFields, [{ name: "Next", label: "", link: false, format: "<value>" }]);
  const originalText = tasks[1].text;
  tasks[1].text = "日本語 ".repeat(40) + "\nHidden details";
  await extension.event("agent_end");
  assert.ok(visibleWidth(status!) <= 60, "entire footer entry is capped in terminal columns");
  assert.match(stripVTControlCharacters(status!), /\.\.\.$/u);
  tasks[1].text = originalText;
  const prompt = "Read the current Pinote task. Summarize your understanding, but don’t start work yet.";
  assert.equal(draft, `Existing draft\n\n${prompt}`);
  const data = (await extension.tool("pinote_get_current", {})).details;
  const fields = { PR: "[Fix #42](https://example.org/pr/42)", Next: "Review" };
  const updated = await extension.tool("pinote_update_current", { expected_updated_at: data.updated_at, set: fields });
  assert.deepEqual(updated.details.agent_notes, fields);
  await assert.rejects(extension.tool("pinote_update_current", { expected_updated_at: data.updated_at, set: { Next: "stale" } }), /changed elsewhere/);
  await extension.event("session_shutdown");
  extension = load();
  draft = "";
  await extension.event("session_start");
  assert.match(status!, /Unicode/);
  assert.ok(!status!.includes("#2"), "restored footer omits the task ID");
  assert.equal(draft, "", "resumed sessions restore status, not editor contents");
  choices.push("Continue");
  await extension.command();
  assert.equal(draft, prompt, "Continue inserts only the read-and-summarize prompt, not saved fields");
  const resumed = (await extension.tool("pinote_get_current", {})).details;
  assert.equal(resumed.text, originalText);
  assert.deepEqual(resumed.agent_notes, fields);
  const previousDraft = draft;
  choices.push("Switch task", undefined);
  await extension.command();
  assert.equal(draft, previousDraft);
  assert.equal(sessionTask(), 2);
  beforeChoice = () => { tasks[1].updated_at += "external"; };
  choices.push("Done");
  await extension.command();
  assert.equal(tasks[1].state, "in_progress");
  assert.match(notices.at(-1)!, /changed elsewhere/);
  beforeChoice = undefined;

  const headless = { ...ctx, hasUI: false, mode: "print", ui: undefined };
  const read = (await extension.tool("pinote_get_current", {}, headless)).details;
  await extension.tool("pinote_update_current", { expected_updated_at: read.updated_at, remove: ["Next"] }, headless);
  assert.deepEqual(tasks[1].agent_notes, { PR: fields.PR });
  const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
  await assert.rejects(extension.tool("pinote_get_current", {}, headless, aborted.signal), /cancelled/);

  const otherEntries: Array<{ type: string; customType: string; data: { id: number | null } }> = [];
  let otherStatus: string | undefined;
  const other = {
    ...ctx,
    cwd: ctx.cwd,
    sessionManager: { getBranch: () => otherEntries },
    ui: { ...ctx.ui, setStatus: (key: string, value?: string) => { if (key === "pinote") otherStatus = value; } },
  };
  const second = load(otherEntries, other);
  await second.event("session_start");
  assert.equal(otherStatus, undefined, "another session in the same folder starts unselected");
  choices.push("older");
  await second.command();
  assert.equal(sessionTask(otherEntries), 1);
  assert.match(otherStatus!, /Older task/);
  assert.equal(sessionTask(), 2, "the other session keeps its own task");
  assert.equal(tasks[0].state, "in_progress");
  assert.equal(tasks[1].state, "in_progress");
  const firstAgain = load();
  await firstAgain.event("session_start");
  assert.match(status!, /Unicode/);
  assert.equal((await firstAgain.tool("pinote_get_current", {})).details.id, 2);
  assert.equal((await second.tool("pinote_get_current", {})).details.id, 1);
  await firstAgain.event("session_shutdown");
  entries.push({ type: "custom", customType: "pinote-selection", data: { id: 1 } });
  await extension.event("session_tree");
  assert.equal((await extension.tool("pinote_get_current", {})).details.id, 1, "tree navigation follows the active branch");
  entries.push({ type: "custom", customType: "pinote-selection", data: { id: 2 } });
  await extension.event("session_tree");
  assert.equal((await extension.tool("pinote_get_current", {})).details.id, 2);

  let releaseChoice!: () => void;
  let enteredChoice!: () => void;
  const choiceStarted = new Promise<void>((resolve) => { enteredChoice = resolve; });
  let getsDuringSwitch = 0;
  delaySelected = () => {
    if (++getsDuringSwitch !== 2) return Promise.resolve();
    return new Promise<void>((resolve) => { releaseChoice = resolve; enteredChoice(); });
  };
  const draftBeforeSwitch = draft;
  choices.push("Switch task", "older");
  const switching = extension.command();
  await choiceStarted;
  entries.push({ type: "custom", customType: "pinote-selection", data: { id: 2 } });
  await extension.event("session_tree");
  releaseChoice();
  await switching;
  assert.equal(sessionTask(), 2, "in-flight selection must not be written onto the new branch");
  assert.equal(draft, draftBeforeSwitch);
  assert.equal((await extension.tool("pinote_get_current", {})).details.id, 2);
  delaySelected = undefined;

  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  delaySelected = () => new Promise<void>((resolve) => { release = resolve; entered(); });
  const delayed = extension.event("before_agent_start");
  await started;
  await extension.event("session_shutdown");
  release();
  await delayed;
  assert.equal(status, undefined, "stale async status cannot repaint after shutdown");
  delaySelected = undefined;
  await extension.event("session_start");
  assert.match(status!, /Unicode/, "the same runtime restores this session's task");

  choices.push("Done");
  await extension.command();
  assert.equal(tasks[1].state, "done");
  assert.equal(status, undefined);
  assert.equal(sessionTask(), null);
  assert.equal(choices.length, 0);
  await extension.event("session_shutdown");
  await extension.event("session_start");
  assert.equal(status, undefined, "completion stays cleared for this session only");
  assert.equal(sessionTask(otherEntries), 1);
  await second.event("session_shutdown");
});

test("add and tag listing require pinote 0.4.0 and select only when asked", async () => {
  let cliVersion = "pinote 0.3.0";
  let current: any = null;
  const calls: string[][] = [];
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  let releaseAdd: (() => void) | undefined;
  let status: string | undefined;
  const ctx: any = {
    cwd: "/tmp/project", hasUI: true, mode: "tui", isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (key: string, value?: string) => { if (key === "pinote") status = value; },
      addAutocompleteProvider() {},
      notify() {},
    },
  };
  const success = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "", killed: false });
  pinote({
    appendEntry() {},
    registerCommand() {},
    registerTool: (definition: any) => tools.set(definition.name, definition),
    on(name: string, handler: unknown) { handlers.set(name, handler); },
    async exec(command: string, args: string[]) {
      assert.equal(command, "note");
      calls.push(args);
      if (args[0] === "--version") return { code: 0, stdout: cliVersion, stderr: "", killed: false };
      if (args[1] === "tags") return success(["pinote"]);
      if (args[1] === "add") {
        const text = args.find((arg) => arg.startsWith("--text="))!.slice("--text=".length);
        if (releaseAdd) await new Promise<void>((resolve) => { releaseAdd = resolve; });
        const tagArg = args.find((arg) => arg.startsWith("--tag="));
        current = {
          id: 9, text, state: "active",
          tag: tagArg ? tagArg.slice("--tag=".length) : null, updated_at: "r9",
          agent_notes: {}, markdown: text,
        };
        return success(current);
      }
      if (args[0] === "--no-notify" && args[1] === "start" && current) {
        current = { ...current, state: "in_progress" };
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      if (args[1] === "get" && current) return success(current);
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    },
  } as any);
  const guidelines = tools.get("pinote_add").promptGuidelines.join("\n");
  assert.match(guidelines, /propose one note as `\[tag\] text`/);
  assert.match(guidelines, /On no, continue without a note/);
  assert.match(guidelines, /select true/);
  await assert.rejects(
    tools.get("pinote_add").execute("id", { text: "Ship it", tag: "pinote", select: true }, undefined, undefined, ctx),
    /0\.4\.0/,
  );
  assert.ok(calls.every((args) => args[0] === "--version"));
  assert.ok(!calls.some((args) => args[1] === "add"), "old CLIs must not receive add");
  cliVersion = "pinote 0.4.0";
  calls.length = 0;
  const added = await tools.get("pinote_add").execute("id", { text: "Ship it", tag: "pinote" }, undefined, undefined, ctx);
  assert.equal(added.details.state, "active");
  const addCalls = () => calls.filter((args) => args[1] === "add");
  assert.equal(addCalls().length, 1);
  assert.ok(!addCalls()[0].includes("--cwd"));
  const chosen = await tools.get("pinote_add").execute(
    "id", { text: "Ship it", tag: "pinote", select: true }, undefined, undefined, ctx,
  );
  assert.equal(chosen.details.state, "in_progress");
  assert.ok(addCalls().every((args) => !args.includes("--cwd")));
  assert.ok(calls.some((args) => args[0] === "--no-notify" && args[1] === "start" && args[2] === "9"));
  assert.match(status!, /\[pinote\] Ship it/);
  assert.deepEqual((await tools.get("pinote_tags").execute("id", {}, undefined, undefined, ctx)).details, ["pinote"]);
  releaseAdd = () => {};
  const switched = tools.get("pinote_add").execute(
    "id", { text: "Later", select: true }, undefined, undefined, ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await handlers.get("session_start")({}, ctx);
  releaseAdd();
  await assert.rejects(switched, /session changed/);
  assert.equal((await tools.get("pinote_get_current").execute("id", {}, undefined, undefined, ctx)).details, null);
  assert.equal(status, undefined, "a replacement session must not inherit an in-flight add");
});
