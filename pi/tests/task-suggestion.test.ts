import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { preview: click } = createRequire(import.meta.url)("../preview-click.cjs");

test("native suggestion bar requires consent, selects once, and rejects stale clicks without submitting", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pinote-suggestion-test-"));
  const overrides = {
    PATH: `${resolve(root, "../.venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    XDG_CONFIG_HOME: join(temp, "config"), PI_CODING_AGENT_DIR: join(temp, "pi"),
    PINOTE_PR_POLL_SECONDS: "0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-suggestion-bus",
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const cwd = join(temp, "project");
  mkdirSync(cwd);
  const cli = (...args: string[]) => execFileSync("note", args, { encoding: "utf8", timeout: 5000 });
  const piDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const native = async (path: string) => import(pathToFileURL(join(piDir, path)).href);
  const { loadExtensions } = await native("core/extensions/loader.js");
  const { SessionManager } = await native("core/session-manager.js");
  initTheme("dark", false);
  const { theme } = await native("modes/interactive/theme/theme.js");
  const session = SessionManager.create(cwd, join(temp, "sessions"));
  let extension: any;
  let widget: any;
  let placement: string | undefined;
  const draft = "Keep my draft";
  const notices: string[] = [];
  const ctx: any = {
    cwd, hasUI: true, mode: "tui", isIdle: () => false, sessionManager: session,
    ui: { theme, setStatus() {},
      setWidget: (_key: string, factory: any, options: any) => {
        widget = factory?.({}, theme); placement = options?.placement;
      },
      notify: (value: string) => notices.push(value), addAutocompleteProvider() {},
      getEditorText: () => draft, setEditorText() { throw new Error("must preserve draft"); } },
  };
  const event = async (name: string) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  const links = () => [...widget.render(60)[0].matchAll(/\x1b\]8;;([^\x07]+)\x07/gu)].map((m: any) => m[1]);
  const list = () => JSON.parse(cli("list", "--json"));
  try {
    const loaded = await loadExtensions([join(root, "index.ts")], cwd);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    loaded.runtime.appendEntry = (type: string, data: unknown) => session.appendCustomEntry(type, data);
    loaded.runtime.sendMessage = loaded.runtime.sendUserMessage = () => { throw new Error("must not start agent turns"); };
    await event("session_start");
    const propose = (text = "Add 日本語 suggested-task confirmation bar") => extension.tools.get("pinote_propose").definition.execute(
      "suggest", { text: `${text}\n\nPreserve details`, tag: "pinote" }, undefined, undefined, ctx);
    const get = () => extension.tools.get("pinote_get_current").definition.execute("get", {}, undefined, undefined, ctx);
    await propose();
    assert.equal(placement, "belowEditor");
    assert.equal(list().length, 0, "proposing must not create a task");
    assert.match(stripVTControlCharacters(widget.render(60)[0]), /^\[pinote\] .*✓  ✕$/u);
    for (const width of [0, 1, 3, 4, 5, 12, 40, 72]) {
      const line = widget.render(width)[0];
      assert.ok(visibleWidth(line) <= width, `fits ${width} columns`);
      if (width >= 4) assert.match(stripVTControlCharacters(line), /✓  ✕$/u);
    }
    const [yes, no] = links();
    await propose("Do not replace an existing proposal");
    assert.deepEqual(links(), [yes, no]);
    await assert.rejects(click(yes.replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`)));
    await event("session_tree");
    assert.equal(widget, undefined);
    await assert.rejects(click(yes));
    await propose();
    const [accept, dismiss] = links();
    await click(accept);
    await assert.rejects(click(accept), "repeated yes cannot duplicate notes");
    await assert.rejects(click(dismiss), "cross from accepted suggestion is stale");
    assert.equal(widget, undefined);
    assert.equal(list().length, 1);
    const chosen = (await get()).details;
    assert.equal(chosen.state, "in_progress");
    assert.equal(chosen.tag, "pinote");
    assert.match(chosen.text, /\n\nPreserve details$/);
    assert.match(notices.at(-1)!, /created and selected/);
    await assert.rejects(propose(), /already selected/);
    session.appendCustomEntry("pinote-selection", { id: null });
    await event("session_tree");
    await propose("Decline this one");
    const rejected = links();
    await click(rejected[1]);
    assert.equal(widget, undefined);
    await assert.rejects(click(rejected[0]));
    assert.equal(list().length, 1, "dismissal must not write a note");
    assert.equal((await get()).details, null);
    assert.match((await propose()).details.status, /dismissed/);
    assert.equal(widget, undefined, "do not nag after cross");
    await event("session_start");
    await propose("Keyboard fallback");
    await extension.commands.get("pi-note-yes").handler("", ctx);
    assert.equal(list().length, 2);
    assert.equal((await get()).details.state, "in_progress");
    session.appendCustomEntry("pinote-selection", { id: null });
    await event("session_tree");
    await propose("Chat acceptance consumes the same consent");
    const chatLinks = links();
    const shimDir = join(temp, "failing-start-cli");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "note"), `#!${process.execPath}\nconst {execFileSync}=require("node:child_process");
const args=process.argv.slice(2);
if(args[0]==="--no-notify"&&args[1]==="start"){process.stderr.write("forced start failure");process.exit(1);}
process.stdout.write(execFileSync(${JSON.stringify(resolve(root, "../.venv/bin/note"))},args));\n`, { mode: 0o755 });
    const fastPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${fastPath}`;
    const accepting = assert.rejects(extension.tools.get("pinote_add").definition.execute(
      "chat-yes", { text: "Chat acceptance consumes the same consent", tag: "pinote", select: true }, undefined, undefined, ctx), /forced start failure/);
    await assert.rejects(click(chatLinks[0]), "chat consent invalidates ✓ before yielding");
    await accepting;
    process.env.PATH = fastPath;
    await assert.rejects(click(chatLinks[0]), "a start failure cannot leave consent reusable");
    assert.equal(widget, undefined);
    assert.equal(list().length, 3, "chat acceptance plus repeated clicks creates only one note");
    assert.equal((await get()).details, null);
    await propose("Shutdown invalidates consent");
    const finalLinks = links();
    await event("session_shutdown");
    assert.equal(widget, undefined);
    await assert.rejects(click(finalLinks[0]));
    assert.equal(list().length, 3);
    assert.equal(draft, "Keep my draft");
    assert.deepEqual(session.buildSessionContext().messages, [], "no model-context message or prompt is added");
  } finally {
    if (extension) await event("session_shutdown");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
