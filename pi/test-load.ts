import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider, getKeybindings } from "@earendil-works/pi-tui";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

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
        const picker = factory({ terminal: { rows: 24 }, requestRender() {} }, ctx.ui.theme, {
          matches: (data: string, action: string) => getKeybindings().matches(data, action as any),
        }, resolve);
        if (picker.render(100).join("\n").includes("Global Settings")) {
          for (let i = 0; i < 3; i++) picker.handleInput("\x1b[B");
          picker.handleInput("\r"); picker.handleInput("\x03");
          picker.handleInput("\x1b[200~Read the selected task.\nExplain Settings 日本語; wait.\x1b[201~");
          picker.handleInput("\r");
          assert.equal(JSON.parse(readFileSync(join(temp, "pi", "pi-note.json"), "utf8")).handoffPrompt,
            "Read the selected task.\nExplain Settings 日本語; wait.", "prompt autosaves before leaving settings");
          for (let i = 0; i < 3; i++) picker.handleInput("\x1b[A");
          picker.handleInput("\r"); picker.handleInput("\x0b"); picker.handleInput("42"); picker.handleInput("\r");
          assert.equal(JSON.parse(readFileSync(join(temp, "pi", "pi-note.json"), "utf8")).footer.titleWidth, 42,
            "consecutive autosaves use the revision just written");
          picker.handleInput("\x1b"); return;
        }
        if (picker.render(100).join("\n").includes("Continue")) {
          const index = ["Continue", "Done", "Switch task", "Settings"].indexOf(choice === "pick" ? "Continue" : choice);
          for (let i = 0; i < index; i++) picker.handleInput("\x1b[B");
        } else picker.handleInput("Resume");
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
    assert.deepEqual([...extension.commands.keys()].sort(), ["pi-note", "pi-note-no", "pi-note-preview", "pi-note-setup", "pi-note-upgrade", "pi-note-yes"]);
    await extension.commands.get("pi-note-setup").handler("", ctx);
    assert.match(notices.at(-1)!, /is ready/);
    await event(extension, "session_start");
    const base = new CombinedAutocompleteProvider(
      [...extension.commands.keys()].map((name: string) => ({ name })), cwd);
    const suggestions = await autocompleteWrappers.at(-1)!(base).getSuggestions(["/pi-note"], 0, 8,
      { signal: new AbortController().signal });
    assert.deepEqual(suggestions.items.map((item: any) => item.value), ["pi-note", "pi-note-preview", "pi-note-yes", "pi-note-no"]);
    assert.ok(!notices.some((message) => message.includes("Run /pi-note-upgrade")));
    assert.deepEqual([...extension.tools.keys()].sort(), [
      "pinote_add", "pinote_fields", "pinote_get_current", "pinote_propose", "pinote_tags", "pinote_update_current",
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
    const config = join(temp, "pi", "pi-note.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{"handoffPrompt":false}');
    await extension.commands.get("pi-note").handler("", ctx);
    assert.match(notices.at(-1)!, /handoffPrompt/);
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "active");
    assert.equal(entries.length, 0, "invalid configuration cannot select an initial task");
    assert.equal(draft, "Existing draft");
    rmSync(config);
    mkdirSync(config); // A directory is an unreadable configuration file, even when running as root.
    await extension.commands.get("pi-note").handler("", ctx);
    assert.match(notices.at(-1)!, /Cannot read .*pi-note\.json/);
    assert.equal(JSON.parse(cli("agent", "get", "1")).state, "active");
    assert.equal(entries.length, 0);
    assert.equal(draft, "Existing draft");
    rmSync(config, { recursive: true });
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(stripVTControlCharacters(statuses.at(-1)!), "📌 [Untagged] Resume the task");
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
    writeFileSync(config, JSON.stringify({ handoffPrompt: prompt, footer: {
      titleWidth: 24, fieldWidth: 10, fields: [{ name: "PR", label: "", format: "#<number>" }, "Next"],
    } }));
    extension = await load(); // Reload rereads footer config without changing task data.
    draft = "";
    await event(extension, "session_start");
    assert.equal(stripVTControlCharacters(statuses.at(-1)!), "📌 [Untagged] Resume ...");
    const linkedTitle = /^\x1b\]8;;[^\x07]+\x07([^\x07]*)\x1b\]8;;\x07$/u.exec(statuses.at(-1)!);
    assert.ok(linkedTitle, "the task link encloses the entire truncated status");
    assert.equal(stripVTControlCharacters(linkedTitle[1]), "📌 [Untagged] Resume ...",
      "overflow remains inside the task link, allowing truncation's ANSI style resets");
    assert.equal(stripVTControlCharacters(prStatuses.at(-1)!), "#42 · Next: R...");
    const configuredFields = (await extension.tools.get("pinote_fields").definition.execute(
      "fields", {}, undefined, undefined, ctx)).details;
    assert.equal(configuredFields.fields[0].name, "PR");
    assert.equal(configuredFields.fields[0].label, "");
    assert.equal(configuredFields.fields[0].format, "#<number>");
    assert.equal(draft, "", "startup never overwrites/submits the editor");
    choice = "Continue";
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(draft, prompt);
    const resumed = JSON.parse((await extension.tools.get("pinote_get_current").definition.execute(
      "resume", {}, undefined, undefined, ctx)).content[0].text);
    assert.equal(resumed.text, "Resume the task");
    assert.deepEqual(resumed.agent_notes, { PR: pr, Next: "Review" });
    await event(extension, "session_shutdown");
    writeFileSync(config, '{"footer":{"titleWidth":false}}');
    extension = await load();
    await event(extension, "session_start");
    assert.equal(stripVTControlCharacters(statuses.at(-1)!), "📌 [Untagged] Resume the task");
    assert.equal(stripVTControlCharacters(prStatuses.at(-1)!), "PR #42");
    assert.match(notices.at(-1)!, /using default Pinote footer settings/);
    // Exercise configuration through the real loader/CLI, including edits without reload.
    for (const action of ["Continue", "Switch task"]) {
      choice = action;
      const customPrompt = `Read the current Pinote task.\nExplain ${action} 日本語; wait for approval.`;
      writeFileSync(config, JSON.stringify({ handoffPrompt: customPrompt }));
      draft = "Keep this draft";
      await extension.commands.get("pi-note").handler("", ctx);
      assert.equal(draft, `Keep this draft\n\n${customPrompt}`);
    }
    choice = "Continue";
    writeFileSync(config, "{}");
    draft = "";
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(draft, prompt, "a missing key keeps the default");
    choice = "Settings";
    draft = "Preserve existing input";
    const beforeSettings = JSON.parse(cli("agent", "get", "1"));
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(draft, "Preserve existing input");
    assert.deepEqual(JSON.parse(cli("agent", "get", "1")), beforeSettings);
    assert.equal(JSON.parse(readFileSync(config, "utf8")).footer.titleWidth, 42);
    const savedPrompt = "Read the selected task.\nExplain Settings 日本語; wait.";
    assert.equal(JSON.parse(readFileSync(config, "utf8")).handoffPrompt, savedPrompt);
    choice = "Continue";
    await extension.commands.get("pi-note").handler("", ctx);
    assert.equal(draft, `Preserve existing input\n\n${savedPrompt}`, "Settings prompt applies without reload");
    const beforeInvalid = JSON.parse(cli("agent", "get", "1"));
    const selectionsBeforeInvalid = entries.filter((entry) => entry.customType === "pinote-selection").length;
    const configNotices = notices.length;
    choice = "Switch task";
    for (const invalid of ["{", "null", "[]", "false", ...[null, 1, false, "", " \n\t", "bad\u001bprompt"].map(
      (handoffPrompt) => JSON.stringify({ handoffPrompt }))]) {
      writeFileSync(config, invalid);
      draft = "Unchanged draft";
      await extension.commands.get("pi-note").handler("", ctx);
      assert.equal(draft, "Unchanged draft");
      assert.match(notices.at(-1)!, /pi-note\.json/);
      assert.deepEqual(JSON.parse(cli("agent", "get", "1")), beforeInvalid);
      assert.equal(entries.filter((entry) => entry.customType === "pinote-selection").length, selectionsBeforeInvalid);
    }
    assert.equal(notices.length - configNotices, 10, "every invalid configuration reports an error");
    choice = "Done"; // Invalid prompt configuration must not prevent completion.
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

test("personal task-offer policies reach the native prompt without disabling explicit tools", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-note-offers-"));
  const overrides = {
    PI_CODING_AGENT_DIR: join(temp, "pi"),
    PATH: `${resolve(root, "../.venv/bin")}:${process.env.PATH}`,
    XDG_DATA_HOME: join(temp, "data"), XDG_STATE_HOME: join(temp, "state"),
    PINOTE_PR_POLL_SECONDS: "0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-pi-note-test-bus",
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const cwd = join(temp, "project");
  const config = join(overrides.PI_CODING_AGENT_DIR, "pi-note.json");
  mkdirSync(cwd);
  mkdirSync(dirname(config));
  const notices: string[] = [];
  const ctx: any = {
    cwd, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: { setStatus() {}, addAutocompleteProvider() {}, notify: (message: string) => notices.push(message) },
  };
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { loadExtensions } = await import(pathToFileURL(join(dirname(piEntry), "core/extensions/loader.js")).href);
  const { buildSystemPrompt } = await import(pathToFileURL(join(dirname(piEntry), "core/system-prompt.js")).href);
  let extension: any;
  try {
    const cases = [
      { raw: undefined, policy: "always" },
      { raw: "{}", policy: "always" },
      { raw: '{"handoffPrompt":"Custom handoff"}', policy: "always" },
      ...["always", "github-remote", "never"].map((policy) => ({ raw: JSON.stringify({ taskOfferPolicy: policy }), policy })),
      ...["sometimes", null, false, 1, {}, []].map((taskOfferPolicy) => ({ raw: JSON.stringify({ taskOfferPolicy }), policy: "never", invalid: true })),
      ...["{", "null", "[]"].map((raw) => ({ raw, policy: "never", invalid: true })),
      { raw: "directory", policy: "never", invalid: true },
    ];
    for (const scenario of cases) {
      rmSync(config, { recursive: true, force: true });
      if (scenario.raw === "directory") mkdirSync(config);
      else if (scenario.raw !== undefined) writeFileSync(config, scenario.raw);
      const result = await loadExtensions([join(root, "index.ts")], cwd);
      assert.deepEqual(result.errors, []);
      extension = result.extensions[0];
      const definitions: any[] = [...extension.tools.values()].map((tool: any) => tool.definition);
      assert.deepEqual(definitions.map((tool) => tool.name).sort(), [
        "pinote_add", "pinote_fields", "pinote_get_current", "pinote_propose", "pinote_tags", "pinote_update_current",
      ]);
      const add = extension.tools.get("pinote_add").definition;
      assert.deepEqual(add.promptGuidelines, extension.tools.get("pinote_get_current").definition.promptGuidelines);
      const prompt = buildSystemPrompt({ cwd,
        selectedTools: definitions.map((tool) => tool.name),
        toolGuidelines: Object.fromEntries(definitions.map((tool) => [tool.name, tool.promptGuidelines ?? []])),
      });
      assert.match(prompt, /Never add or select without consent/);
      assert.match(prompt, /existing.*selection|task is already selected/);
      if (scenario.policy === "never") {
        assert.match(prompt, /Do not offer to create a pinote task/);
        assert.doesNotMatch(prompt, /propose one note/);
      } else {
        assert.match(prompt, /use pinote_propose.*bottom bar instead of asking in chat/);
        if (scenario.policy === "github-remote") {
          assert.match(prompt, /first verify with Git.*URL host is github\.com \(HTTPS or SSH\)/);
          assert.match(prompt, /Local paths, other hosts, and GitHub-looking URL paths do not qualify/);
          assert.match(prompt, /explicit user requests to create one remain allowed/);
        } else assert.doesNotMatch(prompt, /first verify with Git/);
      }
      const before = notices.length;
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
      assert.equal(notices.slice(before).some((message) => message.includes("task offers disabled")), "invalid" in scenario);
      if (scenario.raw === '{"taskOfferPolicy":"never"}') {
        const added = await add.execute("explicit", { text: "Explicit request" }, undefined, undefined, ctx);
        assert.equal(added.details.text, "Explicit request");
        assert.equal(added.details.state, "active");
      }
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      extension = undefined;
    }
  } finally {
    if (extension) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
