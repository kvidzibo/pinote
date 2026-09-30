import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

test("Pi loader and real CLI preserve handoff fields across new sessions", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-note-load-"));
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${resolve(root, "../.venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    XDG_CONFIG_HOME: join(temp, "config"), PI_CODING_AGENT_DIR: join(temp, "pi"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-pi-note-test-bus",
  });
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  const cwd = join(temp, "project");
  mkdirSync(cwd);
  const cli = (...args: string[]) => execFileSync("note", args, { encoding: "utf8", timeout: 5000 });
  const statuses: Array<string | undefined> = [];
  let draft = "Existing draft";
  let choice = "pick";
  const ctx = {
    cwd, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "load-test" },
    ui: {
      setStatus: (_key: string, value?: string) => statuses.push(value),
      getEditorText: () => draft,
      setEditorText: (value: string) => { draft = value; },
      notify: () => {},
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
    return result.extensions[0];
  };
  const event = async (extension: any, name: string) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  let extension: any;
  try {
    cli("add", "Resume the task", "--no-notify");
    extension = await load();
    assert.deepEqual([...extension.commands.keys()], ["pinote"]);
    assert.deepEqual([...extension.tools.keys()].sort(), ["pinote_get", "pinote_update"]);
    await event(extension, "session_start");
    await extension.commands.get("pinote").handler("", ctx);
    assert.equal(statuses.at(-1), "📌 #1 Resume the task");
    assert.match(draft, /^Existing draft\n\n/);
    assert.match(draft, /Resume the task/);
    const get = extension.tools.get("pinote_get").definition;
    const update = extension.tools.get("pinote_update").definition;
    const task = JSON.parse((await get.execute("get", {}, undefined, undefined, ctx)).content[0].text);
    const pr = "[Task selection #42](https://github.com/org/repo/pull/42)";
    const params = { id: task.id, expected_updated_at: task.updated_at, set: { PR: pr, Next: "Review", "--Flag": "arbitrary label" } };
    const updated = JSON.parse((await update.execute("update", params, undefined, undefined, ctx)).content[0].text);
    assert.equal(updated.agent_notes.PR, pr);
    assert.match(JSON.parse(cli("agent", "get", "1")).markdown, /# Agent/);
    assert.equal(updated.markdown, undefined, "model context must not duplicate structured fields as a Markdown body");
    await assert.rejects(update.execute("stale", params, undefined, undefined, ctx), /changed elsewhere/);
    const removed = await update.execute("remove", { id: task.id, expected_updated_at: updated.updated_at,
      remove: ["--Flag"] }, undefined, undefined, ctx);
    assert.equal(JSON.parse(removed.content[0].text).agent_notes["--Flag"], undefined);
    await event(extension, "session_shutdown");
    extension = await load(); // New process-like extension state, same durable database.
    draft = "";
    await event(extension, "session_start");
    assert.match(statuses.at(-1)!, /#1.*Resume the task/);
    assert.equal(draft, "", "startup never overwrites/submits the editor");
    choice = "Continue";
    await extension.commands.get("pinote").handler("", ctx);
    assert.ok(draft.includes(pr));
    assert.match(draft, /Next: Review/);
    choice = "Done";
    await extension.commands.get("pinote").handler("", ctx);
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "done");
    assert.equal(JSON.parse(cli("agent", "selected", "--cwd", cwd)), null);
  } finally {
    if (extension) await event(extension, "session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(temp, { recursive: true, force: true });
  }
});
