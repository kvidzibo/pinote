import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { preview: click, socketPathFor } = createRequire(import.meta.url)("../preview-click.cjs");

test("native eye preview renders complete local data but never reaches requests or summaries", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pinote-preview-test-"));
  const overrides = {
    PATH: `${resolve(root, "../.venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    XDG_CONFIG_HOME: join(temp, "config"), PI_CODING_AGENT_DIR: join(temp, "pi"),
    PINOTE_PR_POLL_SECONDS: "0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-preview-bus",
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
  const { prepareCompaction } = await native("core/compaction/compaction.js");
  const { prepareBranchEntries } = await native("core/compaction/branch-summarization.js");
  initTheme("dark", false);
  const { theme } = await native("modes/interactive/theme/theme.js");
  const session = SessionManager.create(cwd, join(temp, "sessions"));
  let extension: any;
  let status: string | undefined;
  let idle = true;
  let draft = "Keep my draft";
  const ctx: any = {
    cwd, hasUI: true, mode: "tui", isIdle: () => idle, sessionManager: session,
    ui: { theme, setStatus: (key: string, value: string) => { if (key === "pinote") status = value; },
      notify() {}, addAutocompleteProvider() {}, getEditorText: () => draft,
      setEditorText: (value: string) => { draft = value; } },
  };
  const event = async (name: string) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  const link = () => /\x1b\]8;;([^\x07]+)\x07/u.exec(status!)![1];
  const previews = () => session.getBranch().filter((entry: any) => entry.customType === "pinote-preview");
  try {
    cli("agent", "add", "--text=Preview 日本語\nlocal-preview-body-marker", "--tag=pinote");
    const original = JSON.parse(cli("agent", "get", "1"));
    cli("agent", "update", "1", "--expected-updated-at", original.updated_at,
      "--set-json", JSON.stringify({ Next: "local-preview-field-marker\nsecond line" }));
    const before = JSON.parse(cli("agent", "get", "1"));
    session.appendMessage({ role: "user", content: "A normal prompt", timestamp: Date.now() });
    session.appendCustomEntry("pinote-selection", { id: 1 });
    const loaded = await loadExtensions([join(root, "index.ts")], cwd);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    loaded.runtime.appendEntry = (type: string, data: unknown) => session.appendCustomEntry(type, data);
    loaded.runtime.sendMessage = loaded.runtime.sendUserMessage = () => { throw new Error("preview must not send messages"); };
    await event("session_start");
    assert.match(stripVTControlCharacters(status!), /^👁 📌 \[pinote\] Preview 日本語$/u);
    assert.ok(visibleWidth(status!) <= 60);
    const url = link();
    const beforeContext = session.buildSessionContext().messages;
    await click(url);
    assert.equal(previews().length, 1);
    const entry = previews()[0];
    assert.equal(entry.type, "custom");
    const rendered = extension.entryRenderers.get("pinote-preview")(entry, { expanded: true }, theme);
    const output = stripVTControlCharacters(rendered.render(72).join("\n"));
    assert.match(output, /not sent to model/);
    assert.match(output, /local-preview-body-marker/);
    assert.match(output, /local-preview-field-marker/);
    assert.match(output, /second line/);
    for (const width of [12, 40, 72]) {
      assert.ok(rendered.render(width).every((line: string) => visibleWidth(line) <= width));
    }
    assert.deepEqual(session.buildSessionContext().messages, beforeContext);
    session.appendMessage({ role: "user", content: "The next prompt", timestamp: Date.now() });
    assert.doesNotMatch(JSON.stringify(session.buildSessionContext().messages), /local-preview-/);
    const preparation = prepareCompaction(session.getBranch(), { enabled: true, reserveTokens: 1, keepRecentTokens: 1 });
    assert.ok(preparation);
    assert.doesNotMatch(JSON.stringify([preparation.messagesToSummarize, preparation.turnPrefixMessages]), /local-preview-/);
    assert.doesNotMatch(JSON.stringify(prepareBranchEntries(session.getBranch()).messages), /local-preview-/);
    const reopened = SessionManager.open(session.getSessionFile());
    assert.equal(reopened.getBranch().filter((entry: any) => entry.customType === "pinote-preview").length, 1);
    assert.doesNotMatch(JSON.stringify(reopened.buildSessionContext().messages), /local-preview-/);
    idle = false;
    await assert.rejects(click(url));
    assert.equal(previews().length, 1);
    idle = true;
    await extension.commands.get("pi-note-preview").handler("", ctx);
    assert.equal(previews().length, 2, "keyboard fallback uses the same display-only path");
    await event("session_tree");
    await assert.rejects(click(url), "a stale branch link must not preview a new branch");
    await click(link());
    assert.equal(previews().length, 3);
    await assert.rejects(click(link().replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`)));
    assert.throws(() => socketPathFor(`${link()}\n`));
    // Reproduce a 1s version probe + 4.5s successful task read, exceeding the socket's 5s deadline.
    const shimDir = join(temp, "slow-cli");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "note"), `#!${process.execPath}\nconst {execFile}=require('node:child_process');
const argv=process.argv.slice(2);
setTimeout(()=>execFile(${JSON.stringify(resolve(root, "../.venv/bin/note"))},argv,{encoding:'utf8'},(err,out,stderr)=>{
  process.stdout.write(out);process.stderr.write(stderr);process.exitCode=err?1:0;
}),argv[0]==='--version'?1000:4500);\n`, { mode: 0o755 });
    const fastPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${fastPath}`;
    const beforeSlow = previews().length;
    const started = Date.now();
    await assert.rejects(click(link()), "slow reads must be rejected before the transport expires");
    assert.ok(Date.now() - started < 5500);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(previews().length, beforeSlow, "a timed-out read must never append later");
    const match = /^pi-note-preview:\/\/[^/]+\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(link())!;
    const disconnected = createConnection(socketPathFor(link()));
    await new Promise<void>((resolve, reject) => {
      disconnected.once("error", reject);
      disconnected.once("connect", () => {
        disconnected.write(`preview ${match[1]} ${match[2]} ${match[3]}\n`);
        setTimeout(() => { disconnected.destroy(); resolve(); }, 250);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.env.PATH = fastPath;
    await click(link());
    assert.equal(previews().length, beforeSlow + 1, "disconnect must promptly cancel and release the preview operation");
    assert.equal(draft, "Keep my draft");
    assert.deepEqual(JSON.parse(cli("agent", "get", "1")), before, "preview never mutates task data");
    const lastUrl = link();
    await event("session_shutdown");
    await assert.rejects(click(lastUrl));
  } finally {
    if (extension) await event("session_shutdown");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
