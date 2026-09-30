import assert from "node:assert/strict";
import { test } from "node:test";
import pinote from "../index.ts";
import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

test("task selection, handoff, guarded Done and tools survive new sessions without submission", async () => {
  const tasks = [
    { id: 1, text: "Older task", state: "active", tag: null, updated_at: "r1", agent_notes: {} as Record<string, string>, markdown: "Older task" },
    { id: 2, text: "Unicode 日本語 task\nHidden details", state: "active", tag: null, updated_at: "r2", agent_notes: {} as Record<string, string>, markdown: "Unicode 日本語 task" },
  ];
  let selectedId: number | undefined;
  let cliVersion = "pinote 0.2.0";
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
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (key: string, value?: string) => { if (key === "pinote") status = value; },
      notify: (value: string) => { notices.push(value); },
      addAutocompleteProvider: (wrapper: any) => autocompleteWrappers.push(wrapper),
      getEditorText: () => draft,
      setEditorText: (value: string) => { draft = value; },
      custom: async (factory: any) => new Promise((resolve) => {
        const picker = factory({ requestRender() {} }, ctx.ui.theme, {
          matches: (data: string, action: string) => (data === "\r" && action === "tui.select.confirm") ||
            (data === "\x1b" && action === "tui.select.cancel"),
        }, resolve);
        beforeChoice?.();
        picker.handleInput(choices.shift() === "pick" ? "\r" : "\x1b");
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
  function load() {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const events = new Map<string, any>();
    pinote({
      registerCommand: (name: string, definition: any) => commands.set(name, definition),
      registerTool: (definition: any) => tools.set(definition.name, definition),
      on: (name: string, callback: any) => events.set(name, callback),
      async exec(command: string, args: string[], options: any) {
        assert.equal(command, "note");
        assert.equal(options.timeout, 5000);
        calls.push(args);
        if (args[0] === "--version") return { code: 0, stdout: cliVersion, stderr: "", killed: false };
        const item = tasks.find((value) => value.id === Number(args[2]));
        const selected = tasks.find((value) => value.id === selectedId && value.state !== "done");
        if (args[0] === "list") return success(tasks.filter((value) => value.state !== "done"));
        if (args[1] === "selected") {
          const result = success(selected ?? null);
          await delaySelected?.();
          return result;
        }
        if (args[1] === "get") return success(item ?? null);
        if (args[1] === "select" && !failSelection && item && item.state !== "done") {
          selectedId = item.id;
          item.state = "in_progress";
          return success(item);
        }
        if (item && ["done", "update"].includes(args[1]) && args[args.indexOf("--expected-updated-at") + 1] === item.updated_at) {
          item.updated_at += "x";
          if (args[1] === "done") { item.state = "done"; selectedId = undefined; }
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
      command: () => commands.get("pi-note").handler("", ctx),
      event: (name: string) => events.get(name)({}, ctx),
      tool: (name: string, params: object, context = ctx, signal?: AbortSignal) =>
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
  await assert.rejects(extension.tool("pinote_get", { id: 2 }), /requires pinote 0\.3\.0/);
  assert.ok(calls.every((args) => args[0] === "--version"), "old CLIs must never receive unknown commands");
  cliVersion = "pinote 0.3.0";
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
  cliVersion = "pinote 0.3.0";
  await extension.event("session_start");
  await assert.rejects(extension.tool("pinote_get", {}), /No selected/);
  choices.push(undefined);
  await extension.command();
  assert.equal(selectedId, undefined);
  assert.equal(draft, "Existing draft");
  failSelection = true;
  choices.push("pick");
  await extension.command();
  assert.equal(draft, "Existing draft");
  assert.equal(selectedId, undefined);
  failSelection = false;
  choices.push("pick");
  await extension.command();
  assert.equal(selectedId, 2, "newest task is first");
  assert.match(status!, /Unicode/);
  assert.ok(!status!.includes("#2"), "footer omits the task ID");
  assert.ok(!status!.includes("Hidden details"), "footer shows only the first line");
  assert.ok(!status!.includes("In progress"), "footer omits state text");
  assert.ok(!/[●○]/u.test(status!), "footer omits state indicators");
  const originalText = tasks[1].text;
  tasks[1].text = "日本語 ".repeat(40) + "\nHidden details";
  await extension.event("agent_end");
  assert.ok(visibleWidth(status!) <= 60, "entire footer entry is capped in terminal columns");
  assert.match(stripVTControlCharacters(status!), /\.\.\.$/u);
  tasks[1].text = originalText;
  assert.match(draft, /^Existing draft\n\nPinote task #2/);
  const data = (await extension.tool("pinote_get", {})).details;
  const fields = { PR: "[Fix #42](https://example.org/pr/42)", Next: "Review" };
  const updated = await extension.tool("pinote_update", { id: 2, expected_updated_at: data.updated_at, set: fields });
  assert.deepEqual(updated.details.agent_notes, fields);
  await assert.rejects(extension.tool("pinote_update", { id: 2, expected_updated_at: data.updated_at, set: { Next: "stale" } }), /changed elsewhere/);
  await extension.event("session_shutdown");
  extension = load();
  draft = "";
  await extension.event("session_start");
  assert.match(status!, /Unicode/);
  assert.ok(!status!.includes("#2"), "restored footer omits the task ID");
  assert.equal(draft, "", "new sessions restore status, not editor contents");
  choices.push("Continue");
  await extension.command();
  assert.ok(draft.includes(fields.PR));
  const previousDraft = draft;
  choices.push("Switch task", undefined);
  await extension.command();
  assert.equal(draft, previousDraft);
  assert.equal(selectedId, 2);
  beforeChoice = () => { tasks[1].updated_at += "external"; };
  choices.push("Done");
  await extension.command();
  assert.equal(tasks[1].state, "in_progress");
  assert.match(notices.at(-1)!, /changed elsewhere/);
  beforeChoice = undefined;

  const headless = { ...ctx, hasUI: false, mode: "print", ui: undefined };
  const read = (await extension.tool("pinote_get", { id: 2 }, headless)).details;
  await extension.tool("pinote_update", { id: 2, expected_updated_at: read.updated_at, remove: ["Next"] }, headless);
  assert.deepEqual(tasks[1].agent_notes, { PR: fields.PR });
  const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
  await assert.rejects(extension.tool("pinote_get", { id: 2 }, headless, aborted.signal), /cancelled/);
  choices.push("Done");
  await extension.command();
  assert.equal(tasks[1].state, "done");
  assert.equal(status, undefined);
  assert.equal(choices.length, 0);

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
  assert.equal(status, undefined, "the same runtime can handle a new session");
  await extension.event("session_shutdown");
});
