import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

test("Pi loader and real CLI preserve handoff fields across new sessions", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-note-load-"));
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${resolve(root, "../.venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    XDG_CONFIG_HOME: join(temp, "config"), PI_CODING_AGENT_DIR: join(temp, "pi"),
    PINOTE_PR_POLL_SECONDS: "0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-pi-note-test-bus",
  });
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  const cwd = join(temp, "project");
  mkdirSync(cwd);
  const cli = (...args: string[]) => execFileSync("note", args, { encoding: "utf8", timeout: 5000 });
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const prStatuses: Array<string | undefined> = [];
  const autocompleteWrappers: Array<(current: any) => any> = [];
  const entries: any[] = [];
  let draft = "Existing draft";
  let choice = "pick";
  const ctx = {
    cwd, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "load-test", getBranch: () => entries },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (key: string, value?: string) => {
        (key === "pinote" ? statuses : prStatuses).push(value);
      },
      getEditorText: () => draft,
      setEditorText: (value: string) => { draft = value; },
      notify: (message: string) => { notices.push(message); },
      addAutocompleteProvider: (wrapper: any) => autocompleteWrappers.push(wrapper),
      confirm: async () => { throw new Error("compatible setup must not ask for confirmation"); },
      custom: async (factory: any) => new Promise((resolve) => {
        const picker = factory({ requestRender() {} }, ctx.ui.theme, {
          matches: (data: string, action: string) => data === "\r" && action === "tui.select.confirm",
        }, resolve);
        picker.handleInput("Resume");
        picker.handleInput("\r");
      }),
      select: async (_title: string, options: string[]) =>
        choice === "pick" ? options[0] : options.find((value) => value === choice),
    },
  };
  const load = async () => {
    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { loadExtensions } = await import(pathToFileURL(join(dirname(piEntry), "core/extensions/loader.js")).href);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const result = await loadExtensions(manifest.pi.extensions.map((p: string) => join(root, p)), cwd);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    // Bind the session-storage action supplied by Pi's runtime in interactive sessions.
    result.runtime.appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
    return result.extensions[0];
  };
  const event = async (extension: any, name: string) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  let extension: any;
  try {
    cli("add", "Resume the task", "--no-notify");
    extension = await load();
    assert.deepEqual([...extension.commands.keys()].sort(), ["pi-note", "pi-note-setup", "pi-note-upgrade"]);
    await extension.commands.get("pi-note-setup").handler("", ctx);
    assert.match(notices.at(-1)!, /is ready/);
    await event(extension, "session_start");
    const base = new CombinedAutocompleteProvider(
      [...extension.commands.keys()].map((name: string) => ({ name })), cwd);
    const suggestions = await autocompleteWrappers.at(-1)!(base).getSuggestions(["/pi-note"], 0, 8,
      { signal: new AbortController().signal });
    assert.deepEqual(suggestions.items.map((item: any) => item.value), ["pi-note"]);
    assert.ok(!notices.some((message) => message.includes("Run /pi-note-upgrade")));
    assert.deepEqual([...extension.tools.keys()].sort(), [
      "pinote_add", "pinote_get_current", "pinote_tags", "pinote_update_current",
    ]);
    const get = extension.tools.get("pinote_get_current").definition;
    const update = extension.tools.get("pinote_update_current").definition;
    assert.deepEqual(get.parameters.properties, {});
    assert.equal(get.parameters.additionalProperties, false);
    assert.ok(!("id" in update.parameters.properties));
    assert.equal(update.parameters.additionalProperties, false);
    assert.equal((await get.execute("unselected", {}, undefined, undefined, ctx)).details, null);
    await assert.rejects(update.execute("unselected", { expected_updated_at: "unused", set: { Next: "No task" } },
      undefined, undefined, ctx), /No selected pinote task/);
    assert.deepEqual(JSON.parse(cli("agent", "get", "1")).agent_notes, {});
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(statuses.at(-1), "📌 [Untagged] Resume the task");
    assert.equal(JSON.parse(cli("agent", "selected", "--cwd", cwd)), null, "session selection must not bind the folder");
    const prompt = "Read the current Pinote task. Summarize your understanding, but don’t start work yet.";
    assert.equal(draft, `Existing draft\n\n${prompt}`);
    const task = JSON.parse((await get.execute("get", {}, undefined, undefined, ctx)).content[0].text);
    const pr = "[Task selection #42](https://github.com/org/repo/pull/42)";
    const params = { expected_updated_at: task.updated_at, set: { PR: pr, Next: "Review", "--Flag": "arbitrary label" } };
    const updated = JSON.parse((await update.execute("update", params, undefined, undefined, ctx)).content[0].text);
    assert.equal(updated.agent_notes.PR, pr);
    assert.match(prStatuses.at(-1)!, /PR #42/);
    assert.equal(entries.at(-1).customType, "pinote-pr-watched");
    assert.match(JSON.parse(cli("agent", "get", "1")).markdown, /# Agent/);
    assert.equal(updated.markdown, undefined, "model context must not duplicate structured fields as a Markdown body");
    await assert.rejects(update.execute("stale", params, undefined, undefined, ctx), /changed elsewhere/);
    const removed = await update.execute("remove", { expected_updated_at: updated.updated_at,
      remove: ["--Flag"] }, undefined, undefined, ctx);
    assert.equal(JSON.parse(removed.content[0].text).agent_notes["--Flag"], undefined);
    const created = JSON.parse((await extension.tools.get("pinote_add").definition.execute(
      "add", { text: "Agent added", tag: "pinote" }, undefined, undefined, ctx)).content[0].text);
    assert.equal(created.state, "active");
    assert.equal(created.tag, "pinote");
    assert.deepEqual(JSON.parse((await extension.tools.get("pinote_tags").definition.execute(
      "tags", {}, undefined, undefined, ctx)).content[0].text), ["pinote"]);
    assert.equal(JSON.parse((await get.execute("still-current", {}, undefined, undefined, ctx)).content[0].text).id, task.id,
      "adding without select must preserve the current task");
    assert.equal(JSON.parse(cli("agent", "selected", "--cwd", cwd)), null, "added tasks must not bind the folder");
    await event(extension, "session_shutdown");
    extension = await load(); // New process-like extension state, same durable database.
    draft = "";
    await event(extension, "session_start");
    assert.equal(statuses.at(-1), "📌 [Untagged] Resume the task");
    assert.equal(draft, "", "startup never overwrites/submits the editor");
    choice = "Continue";
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(draft, prompt);
    const resumed = JSON.parse((await extension.tools.get("pinote_get_current").definition.execute(
      "resume", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(resumed.text, "Resume the task");
    assert.deepEqual(resumed.agent_notes, { PR: pr, Next: "Review" });
    choice = "Done";
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "done");
    assert.equal(JSON.parse(cli("agent", "selected", "--cwd", cwd)), null);
  } finally {
    if (extension) await event(extension, "session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(temp, { recursive: true, force: true });
  }
});
