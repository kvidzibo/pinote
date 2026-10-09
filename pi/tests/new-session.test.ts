import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { defaultNewSessionPrompt } from "../footer-config.ts";

test("real /new runtime replacement retains an unsaved selection and rereads its prompt without submitting", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pinote-new-session-"));
  const saved = { ...process.env };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cwd = join(temp, "project");
  const agentDir = join(temp, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir, PATH: `${resolve(root, ".venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-pinote-test-bus",
  });
  const cli = (...args: string[]) => execFileSync("note", args, { encoding: "utf8" });
  const config = join(agentDir, "pi-note.json");
  let draft = "";
  let cancel = false;
  const notices: string[] = [];
  const ui: any = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setStatus() {}, getEditorText: () => draft, setEditorText: (value: string) => { draft = value; },
    notify: (message: string) => notices.push(message),
    custom: async (factory: any) => new Promise((done) => {
      const menu = factory({ requestRender() {} }, ui.theme, getKeybindings(), done);
      menu.handleInput("\x1b[B"); menu.handleInput("\r"); // Done, not Continue.
    }),
  };
  let runtime: AgentSessionRuntime;
  const createRuntime = async ({ sessionManager, sessionStartEvent }: any) => {
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never" });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(root, "pi/index.ts")],
      extensionFactories: [(pi) => { pi.on("session_before_switch", () => cancel ? { cancel: true } : undefined); }],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({ cwd, agentDir, sessionManager, sessionStartEvent, settingsManager, resourceLoader });
    await result.session.bindExtensions({ mode: "tui", uiContext: ui,
      commandContextActions: {
        waitForIdle: async () => {}, newSession: (options) => runtime.newSession(options),
        reload: async () => {}, switchSession: (path, options) => runtime.switchSession(path, options),
        fork: (id, options) => runtime.fork(id, options), navigateTree: async () => ({ cancelled: true }),
      },
    });
    return { ...result, services: { cwd, agentDir } as any, diagnostics: [] };
  };
  try {
    cli("--no-notify", "add", "Continue this note"); cli("--no-notify", "start", "1");
    const manager = SessionManager.create(cwd, join(temp, "sessions"));
    manager.appendCustomEntry("pinote-selection", { id: 1 });
    const initial = await createRuntime({ sessionManager: manager, sessionStartEvent: { type: "session_start", reason: "startup" } });
    runtime = new AgentSessionRuntime(initial.session, initial.services, createRuntime);
    const selection = () => runtime.session.sessionManager.getBranch().filter((entry: any) =>
      entry.type === "custom" && entry.customType === "pinote-selection").at(-1) as any;
    const reset = async () => { draft = ""; return runtime.newSession(); };
    await reset();
    assert.equal(selection().data.id, 1);
    assert.equal(draft, defaultNewSessionPrompt);
    assert.deepEqual(runtime.session.messages, [], "prepopulation is not a model message");
    writeFileSync(config, JSON.stringify({ newSessionPrompt: "Read the current note.\nPropose the next step." }));
    await reset();
    assert.equal(selection().data.id, 1);
    assert.equal(draft, "Read the current note.\nPropose the next step.");
    writeFileSync(config, JSON.stringify({ newSessionPrompt: "" }));
    await reset();
    assert.equal(selection().data.id, 1); assert.equal(draft, "");
    writeFileSync(config, JSON.stringify({ newSessionPrompt: false }));
    await reset();
    assert.equal(selection().data.id, 1); assert.equal(draft, "");
    assert.ok(notices.some((message) => /newSessionPrompt/.test(message)));
    const beforeCancel = runtime.session;
    cancel = true;
    assert.equal((await reset()).cancelled, true);
    assert.equal(runtime.session, beforeCancel); assert.equal(selection().data.id, 1);
    cancel = false;
    writeFileSync(config, "{}");
    await reset();
    assert.equal(selection().data.id, 1);
    // A fresh launch is unrelated to an accepted reset and starts unselected.
    const unrelated = await createRuntime({ sessionManager: SessionManager.create(cwd, join(temp, "sessions")),
      sessionStartEvent: { type: "session_start", reason: "startup" } });
    assert.ok(!unrelated.session.sessionManager.getBranch().some((entry: any) => entry.customType === "pinote-selection"));
    await new AgentSessionRuntime(unrelated.session, unrelated.services, createRuntime).dispose();
    await runtime.session.prompt("/pi-note");
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "done");
    assert.equal(selection(), undefined, "Done's new session remains unselected");
    assert.equal(draft, "");
    assert.deepEqual(runtime.session.messages, []);
  } finally {
    await runtime!?.dispose();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(temp, { recursive: true, force: true });
  }
});
