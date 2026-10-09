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
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { renderSuggestion, renderSelectedTask } from "../task-suggestion.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { preview: click } = createRequire(import.meta.url)("../preview-click.cjs");

test("native suggestion and completion controls require consent and reject stale clicks without submitting", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pinote-suggestion-test-"));
  const overrides = {
    PATH: `${resolve(root, "../.venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    XDG_CONFIG_HOME: join(temp, "config"), PI_CODING_AGENT_DIR: join(temp, "pi"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-suggestion-bus",
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
  let session = SessionManager.create(cwd, join(temp, "sessions"));
  let extension: any;
  let status: string | undefined;
  let draft = "Keep my draft";
  let completion: Promise<void> | undefined;
  let replacements = 0;
  let reloads = 0;
  const notices: string[] = [];
  let settingsChoice = "Accept suggestion";
  let idle = false;
  const ctx: any = {
    cwd, hasUI: true, mode: "tui", isIdle: () => idle, sessionManager: session,
    newSession: async (options: any) => {
      replacements++;
      await options.withSession({ ui: { setEditorText: (value: string) => { draft = value; } },
        reload: async () => { reloads++; } });
      return { cancelled: false };
    },
    ui: { theme,
      setStatus: (key: string, value?: string) => { if (key === "pinote") status = value; },
      setWidget() { throw new Error("suggestions must use the pin footer, not a separate widget"); },
      notify: (value: string) => notices.push(value), addAutocompleteProvider() {},
      getEditorText: () => draft, setEditorText() { throw new Error("must preserve draft"); },
      custom: async (factory: any) => new Promise((resolve) => {
        const component = factory({ requestRender() {} }, theme,
          { matches: (data: string, action: string) => getKeybindings().matches(data, action as any) }, resolve);
        if (!stripVTControlCharacters(component.render(100).join("\n")).includes("Global Settings")) {
          component.handleInput("\t"); return;
        }
        const selected = () => stripVTControlCharacters(component.render(100).join("\n")).includes(`> ${settingsChoice}`);
        for (let i = 0; i < 80 && !selected(); i++) component.handleInput("\x1b[B");
        assert.ok(selected(), `settings offers ${settingsChoice}`);
        component.handleInput("\r");
      }) },
  };
  const event = async (name: string, data: object = {}) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(data, ctx);
  };
  const links = () => [...status!.matchAll(/\x1b\]8;;([^\x07]+)\x07/gu)].map((m: any) => m[1]);
  const list = () => JSON.parse(cli("list", "--json"));
  const load = async () => {
    const loaded = await loadExtensions([join(root, "index.ts")], cwd);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    loaded.runtime.appendEntry = (type: string, data: unknown) => session.appendCustomEntry(type, data);
    loaded.runtime.sendMessage = () => { throw new Error("must not start agent turns"); };
    loaded.runtime.sendUserMessage = (message: string, options: any) => {
      assert.equal(options.expandPromptTemplates, true);
      assert.match(message, /^\/pi-note [a-f0-9:]+$/u, "footer dispatches a private token through the sole command");
      completion = extension.commands.get("pi-note").handler(message.slice("/pi-note ".length), ctx);
    };
  };
  try {
    await load();
    await event("session_start");
    const propose = (text = "Add 日本語 suggested-task confirmation bar") => extension.tools.get("pinote_propose").definition.execute(
      "suggest", { text: `${text}\n\nPreserve details`, tag: "pinote" }, undefined, undefined, ctx);
    const get = () => extension.tools.get("pinote_get_current").definition.execute("get", {}, undefined, undefined, ctx);
    await propose();
    const proposedStatus = status;
    await event("before_agent_start");
    await event("agent_end");
    assert.equal(status, proposedStatus, "agent activity must retain the suggestion in the pin footer");
    assert.equal(list().length, 0, "proposing must not create a task");
    assert.match(stripVTControlCharacters(status!), /^📌 ✖\u00a0\u00a0✚ · \[pinote\] Add 日本語/u);
    for (const icon of ["📌", "✖", "✚"]) assert.ok(status!.includes(theme.bold(icon)), `${icon} is bold`);
    assert.ok(visibleWidth(status!) <= 60, "uses the configured footer title budget");
    for (const width of [0, 1, 3, 4, 5, 12, 18, 20, 30, 40, 72]) {
      const line = renderSuggestion({ text: "Add 日本語 suggested-task confirmation bar", tag: "pinote" }, width, theme, {});
      const plain = stripVTControlCharacters(line);
      assert.ok(visibleWidth(line) <= width, `fits ${width} columns`);
      if (plain.includes("✚")) assert.match(plain, /✖.*✚/u);
      if (width >= 30) assert.match(plain, /✖\u00a0\u00a0✚/u);
      const selectedLine = renderSelectedTask({ text: "Add 日本語 suggested-task confirmation bar", tag: "pinote" }, width, theme, {});
      assert.ok(visibleWidth(selectedLine) <= width);
      if (width >= 30) {
        const selectedPlain = stripVTControlCharacters(selectedLine);
        assert.equal(visibleWidth(plain.split("✖")[0]), visibleWidth(selectedPlain.split("✔")[0]));
        assert.match(selectedPlain, /^📌 ✔ · /u);
        // Match Pi's default-footer ASCII-space sanitization, not just raw status text.
        const sanitized = line.replace(/ +/gu, " ").trim();
        const selectedSanitized = selectedLine.replace(/ +/gu, " ").trim();
        assert.equal(visibleWidth(sanitized.split(" · ")[0]) - visibleWidth(selectedSanitized.split(" · ")[0]), 3);
      }
    }
    const longTag = renderSuggestion({ text: "Meaningful title", tag: "x".repeat(64) }, 60, theme, {});
    assert.match(stripVTControlCharacters(longTag), / · Meaningful title$/u);
    assert.doesNotMatch(stripVTControlCharacters(longTag), /xxx/u);
    const staleSuggestion = links();
    await event("session_shutdown");
    await load();
    await event("session_start");
    assert.equal(stripVTControlCharacters(status!), stripVTControlCharacters(proposedStatus!), "reload restores the pending suggestion and its controls");
    assert.equal(list().length, 0, "restoring a suggestion never creates a task");
    assert.deepEqual(session.getBranch().filter((entry: any) => entry.customType === "pinote-suggestion").at(-1).data,
      { suggestion: { text: "Add 日本語 suggested-task confirmation bar\n\nPreserve details", tag: "pinote" } });
    await assert.rejects(click(staleSuggestion[1]), "reload invalidates the old capability, not the proposal");
    const previous = links();
    await extension.tools.get("pinote_propose").definition.execute("replace", {
      text: "A better pending task\n\nReplacement details", tag: "pi",
    }, undefined, undefined, ctx);
    const replacement = links();
    assert.notDeepEqual(replacement, previous, "replacement rotates consent links");
    assert.match(stripVTControlCharacters(status!), /\[pi\] A better pending task/u);
    assert.equal(list().length, 0, "replacement requires consent before creation");
    await assert.rejects(click(previous[0]), "old dismissal cannot clear the replacement");
    await assert.rejects(click(previous[1]), "old acceptance cannot create either proposal");
    assert.deepEqual(links(), replacement);
    const replacementStatus = stripVTControlCharacters(status!);
    await event("session_shutdown");
    await load();
    await event("session_start");
    assert.equal(stripVTControlCharacters(status!), replacementStatus, "reload restores the replacement");
    assert.deepEqual(session.getBranch().filter((entry: any) => entry.customType === "pinote-suggestion").at(-1).data,
      { suggestion: { text: "A better pending task\n\nReplacement details", tag: "pi" } });
    await assert.rejects(click(replacement[1]), "reload invalidates replacement links");
    const [no, yes] = links();
    await assert.rejects(click(yes.replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`)));
    await event("session_tree");
    assert.equal(status, undefined);
    await assert.rejects(click(yes));
    await propose("Obsolete proposal");
    const obsolete = links();
    await propose();
    await assert.rejects(click(obsolete[1]), "replaced proposal cannot be accepted");
    const [dismiss, accept] = links();
    await click(accept);
    await assert.rejects(click(accept), "repeated yes cannot duplicate notes");
    await assert.rejects(click(dismiss), "cross from accepted suggestion is stale");
    assert.match(stripVTControlCharacters(status!), /^📌 ✔ · \[pinote\] Add 日本語/u);
    for (const icon of ["📌", "✔"]) assert.ok(status!.includes(theme.bold(icon)), `${icon} is bold`);
    assert.doesNotMatch(stripVTControlCharacters(status!), /✚|✖/u);
    assert.equal(list().length, 1);
    const chosen = (await get()).details;
    assert.equal(chosen.state, "in_progress");
    assert.equal(chosen.tag, "pinote");
    assert.equal(chosen.text, "Add 日本語 suggested-task confirmation bar\n\nPreserve details", "acceptance creates the latest proposal with full details");
    assert.match(notices.at(-1)!, /created and selected/);
    assert.equal(draft, "Keep my draft", "accepting a suggestion preserves the editor");
    await event("session_shutdown");
    await load();
    await event("session_start");
    assert.doesNotMatch(stripVTControlCharacters(status!), /✚/u, "reload never resurrects accepted consent");
    assert.equal(list().length, 1);
    await assert.rejects(propose(), /already selected/);
    session.appendCustomEntry("pinote-selection", { id: null });
    await event("session_tree");
    await propose("Decline this one");
    const rejected = links();
    await click(rejected[0]);
    assert.equal(status, undefined);
    await assert.rejects(click(rejected[1]));
    assert.equal(list().length, 1, "dismissal must not write a note");
    assert.equal((await get()).details, null);
    assert.match((await propose("A later task")).details.status, /pending; user can click \+/);
    const later = links();
    assert.match(stripVTControlCharacters(status!), /A later task/u);
    await assert.rejects(click(rejected[0]), "old dismissal cannot clear a later proposal");
    await assert.rejects(click(rejected[1]), "old acceptance cannot create the dismissed task");
    assert.deepEqual(links(), later);
    await click(later[0]);
    assert.equal(status, undefined);
    assert.equal(list().length, 1, "later proposals still need consent");
    // A saved dismissal from the old version must not keep this session blocked.
    session.appendCustomEntry("pinote-suggestion", { suggestion: null, declined: true });
    await event("session_shutdown");
    await load();
    await event("session_start");
    assert.equal(status, undefined, "reload never resurrects a dismissed proposal");
    assert.match((await propose("A task after reload")).details.status, /pending/);
    await click(links()[0]);
    assert.equal(status, undefined);
    session = SessionManager.create(cwd, join(temp, "sessions"));
    ctx.sessionManager = session;
    // Forking an ancestor proposal must not restore consent consumed in the parent.
    session.appendCustomEntry("pinote-suggestion", { suggestion: { text: "Already accepted in the parent" }, declined: false });
    await event("session_start", { reason: "fork" });
    assert.equal(status, undefined);
    await propose("Keyboard fallback");
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(list().length, 1, "Settings waits for the agent to be idle");
    idle = true;
    await extension.commands.get("pi-note").handler("", ctx);
    idle = false;
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
    await assert.rejects(click(chatLinks[0]), "chat consent invalidates ✔ before yielding");
    await accepting;
    process.env.PATH = fastPath;
    await assert.rejects(click(chatLinks[0]), "a start failure cannot leave consent reusable");
    assert.equal(status, undefined);
    assert.equal(list().length, 3, "chat acceptance plus repeated clicks creates only one note");
    assert.equal((await get()).details, null);
    await propose("Shutdown invalidates consent");
    const finalLinks = links();
    await event("session_shutdown");
    assert.equal(status, undefined);
    await assert.rejects(click(finalLinks[0]));
    assert.equal(list().length, 3);

    // Completion uses the displayed revision and a different click cell from Add.
    await event("session_start");
    session.appendCustomEntry("pinote-selection", { id: chosen.id });
    await event("session_tree");
    const staleDone = links()[0];
    await assert.rejects(click(staleDone), "cannot complete while the agent is active");
    idle = true;
    cli("agent", "update", String(chosen.id), "--expected-updated-at", chosen.updated_at,
      "--set-json", JSON.stringify({ Next: "Changed externally" }));
    await assert.rejects(click(staleDone), "cannot complete an externally revised task");
    assert.equal(JSON.parse(cli("agent", "get", String(chosen.id))).state, "in_progress");
    const branchDone = links()[0];
    await event("session_tree");
    await assert.rejects(click(branchDone), "branch changes invalidate completion links");
    const done = links()[0];
    await click(done);
    await completion;
    await assert.rejects(click(done), "repeated completion is rejected");
    assert.equal(JSON.parse(cli("agent", "get", String(chosen.id))).state, "done");
    assert.equal((await get()).details, null);
    assert.equal(status, undefined);
    session.appendCustomEntry("pinote-selection", { id: 2 });
    await event("session_tree");
    settingsChoice = "Complete task (new session)";
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(JSON.parse(cli("agent", "get", "2")).state, "done", "keyboard completion uses the guarded path");
    assert.equal(draft, "", "completion clears only the new session's editor");
    assert.equal(replacements, 2);
    assert.equal(reloads, 2);
    assert.deepEqual(session.buildSessionContext().messages, [], "no model-context message or prompt is added");
  } finally {
    if (extension) await event("session_shutdown");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
