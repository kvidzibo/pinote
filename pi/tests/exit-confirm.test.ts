import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("opt-in exit companion preserves editor input, confirms only current tasks, and fails closed", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pinote-exit-"));
  const saved = { ...process.env };
  Object.assign(process.env, { PINOTE_NOTE_COMMAND: resolve(root, "../.venv/bin/note"),
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    PI_CODING_AGENT_DIR: join(temp, "pi"), DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-pinote-exit-bus" });
  const cli = (...args: string[]) => execFileSync(process.env.PINOTE_NOTE_COMMAND!, ["--no-notify", ...args], { encoding: "utf8" });
  const piDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const native = (path: string) => import(pathToFileURL(join(piDir, path)).href);
  const { loadExtensions } = await native("core/extensions/loader.js");
  const { createEventBus } = await native("core/event-bus.js");
  const bus = createEventBus();
  let selected: number | null = 1, owned = true, broken = false, wrongDatabase = false;
  let queryHook: (() => void) | undefined;
  bus.on("gateway:query-service-tool", (query: any) => {
    assert.equal(query.service, "pinote"); assert.equal(query.tool, "get_current");
    if (!owned) return query.respond({ handled: false });
    queryHook?.();
    if (broken) return query.respond({ handled: true, error: "Service disconnected" });
    const task = selected === null ? null : JSON.parse(cli("agent", "get", String(selected)));
    query.respond({ handled: true, result: Promise.resolve({ content: [{ type: "text", text: JSON.stringify(
      task && ["active", "in_progress"].includes(task.state) ? task : null) }],
      _meta: { "pinote/database": wrongDatabase ? temp : join(temp, "data/pinote/notes.db") } }) });
  });
  let factory: any, editor: any, draft = "", forwarded = 0, exits = 0, idle = true, dialogs = 0;
  let choice: string | undefined = "Cancel", onSelect: (() => void) | undefined;
  const notices: string[] = [];
  const previous = () => ({ getText: () => draft, handleInput: () => { forwarded++; }, setText: (text: string) => { draft = text; } });
  factory = previous;
  const ctx: any = { mode: "tui", hasUI: true, isIdle: () => idle, abort: () => { idle = true; }, shutdown: () => { exits++; },
    ui: { getEditorComponent: () => factory, getEditorText: () => draft,
      setEditorComponent: (value: any) => { factory = value; editor = (value || previous)({}, {}, { matches: (data: string, action: string) => action === "app.exit" && data === "\x04" }); },
      notify: (message: string) => { notices.push(message); },
      select: async (title: string, options: string[]) => {
        assert.match(title, /Pinote · Exit 日本語/);
        assert.deepEqual(options, ["Complete task and exit", "Exit without completing", "Cancel"]);
        dialogs++; onSelect?.(); return choice;
      } },
  };
  let extension: any;
  const event = async (name: string) => { for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx); };
  const press = async () => { editor.handleInput("\x04"); await tick(); };
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await delay(10);
    assert.ok(check(), "exit operation did not settle");
  };
  try {
    cli("agent", "add", "--text=Exit 日本語\n\nKeep task details");
    cli("agent", "add", "--text=Other task");
    cli("start", "1"); cli("start", "2");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./index.ts"], "companion is never enabled by package installation");
    assert.ok(manifest.files.includes("exit-confirm.ts"));
    const loaded = await loadExtensions([join(root, "exit-confirm.ts")], temp, bus);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    assert.equal(extension.tools.size, 0); assert.equal(extension.commands.size, 0);
    await event("session_start");
    assert.notEqual(factory, previous);
    draft = "text"; await press();
    editor.handleInput("x");
    assert.equal(forwarded, 2); assert.equal(dialogs, 0); assert.equal(exits, 0);
    draft = "";
    await press(); assert.equal(dialogs, 1); assert.equal(exits, 0);
    choice = undefined; await press(); assert.equal(dialogs, 2); assert.equal(exits, 0);
    choice = "Exit without completing"; await press(); assert.equal(exits, 1);
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "in_progress");
    selected = null; await press(); assert.equal(exits, 2); assert.equal(dialogs, 3);
    selected = 1;
    owned = false; await press(); assert.equal(exits, 2); assert.match(notices.at(-1)!, /unavailable/); owned = true;
    broken = true; await press(); assert.equal(exits, 2); assert.match(notices.at(-1)!, /disconnected/); broken = false;
    choice = "Complete task and exit";
    idle = false; await press(); assert.equal(exits, 2); assert.match(notices.at(-1)!, /idle/); idle = true;
    wrongDatabase = true; await press(); await wait(() => /database mismatch/.test(notices.at(-1)!)); wrongDatabase = false;
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "in_progress");
    onSelect = () => { selected = 2; };
    let before = notices.length; await press(); await wait(() => notices.length > before);
    assert.match(notices.at(-1)!, /task changed/); selected = 1;
    onSelect = () => {
      const task = JSON.parse(cli("agent", "get", "1"));
      cli("agent", "update", "1", "--expected-updated-at", task.updated_at, "--set-json", '{"Next":"Changed elsewhere"}');
    };
    before = notices.length; await press(); await wait(() => notices.length > before);
    assert.match(notices.at(-1)!, /task changed/);
    onSelect = undefined;
    let reads = 0;
    queryHook = () => { if (++reads === 2) idle = false; };
    before = notices.length; await press(); await wait(() => notices.length > before);
    assert.match(notices.at(-1)!, /became busy/); assert.equal(exits, 2);
    idle = true; queryHook = undefined;
    onSelect = () => { void event("session_before_tree"); };
    await press(); assert.equal(exits, 2); assert.equal(JSON.parse(cli("agent", "get", "1")).state, "in_progress");
    onSelect = undefined;
    queryHook = () => { draft = "New draft while reading"; };
    await press(); assert.equal(exits, 2); assert.equal(draft, "New draft while reading"); draft = ""; queryHook = undefined;
    onSelect = () => { process.env.PINOTE_NOTE_COMMAND = "/nonexistent-pinote-cli"; };
    before = notices.length; await press(); await wait(() => notices.length > before);
    assert.equal(exits, 2); assert.match(notices.at(-1)!, /stayed open/);
    process.env.PINOTE_NOTE_COMMAND = resolve(root, "../.venv/bin/note"); onSelect = undefined;
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "in_progress");
    await event("agent_start"); // Cancels an attempt, not future Ctrl+D interception.
    before = notices.length;
    await press(); await wait(() => exits > 2 || notices.length > before);
    assert.equal(exits, 3, notices.at(-1));
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "done");
    assert.equal(JSON.parse(cli("agent", "get", "2")).state, "in_progress");
    idle = false; await press(); assert.equal(exits, 4); assert.equal(idle, true, "no-task exit still aborts a busy run");
    await event("session_shutdown"); assert.equal(factory, previous);
    ctx.mode = "rpc"; await event("session_start"); assert.equal(factory, previous);
  } finally {
    if (extension) await event("session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(temp, { recursive: true, force: true });
  }
});
