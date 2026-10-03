import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, Text, truncateToWidth, type Keybinding } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { createPRWatcher } from "./pr-watch.ts";
import { defaultFooterConfig, defaultHandoffPrompt, effectiveFooterFields, loadFooterConfig, parseHandoffPrompt, readFooterDocument, saveFooterConfig, type FooterConfig, type PinoteSettings } from "./footer-config.ts";
import { FooterSettings, TaskMenu, withSettingsTab } from "./footer-settings.ts";
import { TaskPicker, taskState, taskTag } from "./task-picker.ts";
import { bundledCLIVersion, cliMenu, detectCLI, setupCLI, setupHint, versionAtLeast, type CLIAction } from "./setup.ts";
import { createPreviewBridge } from "./preview-bridge.ts";

const handoffGuidance = "Keep agent notes to at most three short bullets total: outcome, blocker, next action, only when relevant. Replace stale notes; omit narration, repeated task text, and routine test logs. Keep a GitHub pull request in the PR field. Read pinote_fields to learn the user's globally configured footer field names and presentation. Populate those fields with meaningful task values when relevant using pinote_update_current; fields without values stay hidden. Footer fields and widths are chosen by the user's pi-note.json config. Set configured fields with Markdown values; links are clickable. When footer.fields is unset, Bar selects labels, one per line. Do not list PR in Bar. Remove a field to hide it. Do not modify config without user approval.";
const offerGuidance = {
  always: "When the user gives work and no pinote task is selected, propose one note as `[tag] text` and ask before creating it.",
  "github-remote": "When the user gives work and no pinote task is selected, first verify with Git that the current repository has a remote whose URL host is github.com (HTTPS or SSH). Only then propose one note as `[tag] text` and ask before creating it. Local paths, other hosts, and GitHub-looking URL paths do not qualify. If no GitHub remote is verified, do not offer a task; explicit user requests to create one remain allowed.",
  never: "Do not offer to create a pinote task. Create one only when the user explicitly requests it.",
};
const consentGuidance = "On no, continue without a note. On yes, call pinote_add with select true so it becomes this session's active task. Never add or select without a yes. If a task is already selected, do not replace it unless the user asks to switch.";
const titleGuidance = "Start task text with a short, action-oriented summary (aim for at most 60 characters). Put context, URLs, commands, and acceptance criteria after a blank line. Never put implementation details in the title.";
const tagGuidance = "Reuse a pinote_tags name when it fits. One tag; case-sensitive, trimmed, at most 64 characters. Tags are set when creating tasks with pinote_add; agent tools cannot retag existing tasks. Do not use pinote_update_current for tags or task text.";
type Task = {
  id: number;
  text: string;
  state: "active" | "in_progress" | "done" | "removed" | "scheduled";
  tag: string | null;
  updated_at: string;
  agent_notes: Record<string, string>;
  markdown: string;
};
type Summary = Pick<Task, "id" | "text" | "state" | "tag">;
// The standard Pi footer accepts text, so ship a portable terminal glyph, not a theme icon.
const noteIcon = readFileSync(new URL("./icons/note.txt", import.meta.url), "utf8").trim();
const previewType = "pinote-preview";
const compatible = "Incompatible note CLI response. Install pinote 0.3.0+ and check note on PATH.";
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value);
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "�");
const firstLine = (task: Summary) => clean(task.text.split("\n", 1)[0]).replace(/\s+/gu, " ").trim();
const title = (task: Summary) => truncateToWidth(`#${task.id} ${firstLine(task)}`, 60);

function readConfig(): Record<string, unknown> {
  const path = join(getAgentDir(), "pi-note.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}. Check the pi-note configuration.`);
  }
  let config: unknown;
  try { config = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${path}.`); }
  if (!record(config)) throw new Error(`Expected a JSON object in ${path}.`);
  return config;
}

function creationGuidance(): { guidelines: string[]; error?: string } {
  let policy: keyof typeof offerGuidance = "always";
  let error: string | undefined;
  try {
    const config = readConfig();
    if ("taskOfferPolicy" in config) {
      const value = config.taskOfferPolicy;
      if (value !== "always" && value !== "github-remote" && value !== "never") {
        throw new Error(`taskOfferPolicy in ${join(getAgentDir(), "pi-note.json")} must be always, github-remote, or never.`);
      }
      policy = value;
    }
  } catch (cause) {
    policy = "never";
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { guidelines: [`${offerGuidance[policy]} ${consentGuidance}`, titleGuidance, tagGuidance], error };
}

function handoffPrompt(): string {
  const config = readConfig();
  return "handoffPrompt" in config ? parseHandoffPrompt(config.handoffPrompt) : defaultHandoffPrompt;
}

function parse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new Error(compatible); }
}
function task(raw: string): Task | null {
  const value = parse(raw);
  if (value === null) return null;
  if (!record(value) || !validId(value.id) || !text(value.text) || !value.text.trim() ||
      typeof value.state !== "string" || !["active", "in_progress", "done", "removed", "scheduled"].includes(value.state) ||
      !(value.tag === null || text(value.tag)) || !text(value.updated_at) || !value.updated_at.trim() ||
      !record(value.agent_notes) || !Object.entries(value.agent_notes).every(([key, v]) => text(key) && text(v)) ||
      !text(value.markdown)) throw new Error(compatible);
  return value as Task;
}
function requiredTask(raw: string, id?: number): Task {
  const value = task(raw);
  if (!value) throw new Error("No selected pinote task. Select one with /pi-note first.");
  if (id !== undefined && value.id !== id) throw new Error(compatible);
  return value;
}
function taskList(raw: string): Summary[] {
  const value = parse(raw);
  if (!Array.isArray(value) || !value.every((v) => record(v) && validId(v.id) && text(v.text) &&
      v.text.trim() && (v.tag === null || text(v.tag)) &&
      typeof v.state === "string" && ["active", "in_progress"].includes(v.state))) throw new Error(compatible);
  return value.sort((a, b) => b.id - a.id);
}

function toolResult(value: Task | null) {
  if (!value) return { content: [{ type: "text" as const, text: "null" }], details: null };
  // Keep the model payload under 50 KiB at the CLI's limits; don't send the same fields twice.
  const { markdown: _markdown, ...data } = value;
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: value };
}

export default function (pi: ExtensionAPI) {
  const { guidelines: createGuidance, error: offerConfigError } = creationGuidance();
  pi.registerEntryRenderer<{ id: number; markdown: string }>(previewType, (entry, _options, theme) => {
    if (!record(entry.data) || !validId(entry.data.id) || typeof entry.data.markdown !== "string") return;
    const view = new Container();
    view.addChild(new Text(theme.fg("muted", `Pinote #${entry.data.id} · display only · not sent to model`), 0, 0));
    view.addChild(new Markdown(clean(entry.data.markdown), 0, 0, getMarkdownTheme()));
    return view;
  });
  let previewBridge: ReturnType<typeof createPreviewBridge> | undefined;
  let alive = true;
  let epoch = 0;
  let refreshSerial = 0;
  let pending: symbol | undefined;
  let setupAbort: AbortController | undefined;
  let activeContext: ExtensionContext | undefined;
  let cliState: CLIAction | undefined;
  let footerConfig = { ...defaultFooterConfig };
  const checkCLI = async (ctx: ExtensionContext, suggest = false) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || setupAbort) return;
    const generation = epoch;
    const action = await detectCLI(pi);
    if (!alive || generation !== epoch || setupAbort) return;
    cliState = action;
    if (suggest && action === "upgrade") {
      ctx.ui.notify(`Pinote CLI ${bundledCLIVersion} is bundled with this extension. Run /pi-note-upgrade to update your older CLI.`, "info");
    }
  };

  const invoke = async (argv: string[], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    let result;
    try {
      result = await pi.exec("note", argv, { timeout: 5000, signal });
    } catch (error) {
      throw new Error(`Pinote CLI unavailable: ${clean(String(error))}. ${setupHint}`);
    }
    if (result.killed || result.code !== 0) {
      const detail = clean((result.stderr || result.stdout || "note failed or timed out").trim());
      throw new Error(`${detail}${argv[0] === "--version" ? ` ${setupHint}` : result.killed ? " Read the task before retrying; a write may have committed." : ""}`);
    }
    return result.stdout;
  };
  const ensureCLI = async (signal?: AbortSignal, canRun = () => true, minimum = "0.3.0") => {
    if (setupAbort) throw new Error("Pinote CLI setup is still running. Retry after it finishes.");
    // Old pinote treats unknown commands as note text. Probe safely before every call,
    // including tools in headless sessions, and do not cache across CLI upgrades/downgrades.
    const version = (await invoke(["--version"], signal)).trim();
    if (!versionAtLeast(version, minimum)) {
      throw new Error(`pi-note requires pinote ${minimum}+; found ${clean(version) || "an unknown CLI"}. ${setupHint}`);
    }
    if (!canRun()) throw new Error("Pinote operation cancelled: the session changed.");
  };
  const run = async (argv: string[], signal?: AbortSignal, canRun = () => true, minimum = "0.3.0") => {
    await ensureCLI(signal, canRun, minimum);
    return invoke(argv, signal);
  };
  const writeTask = async (
    ctx: ExtensionContext, signal: AbortSignal | undefined, argv: string[], id?: number, minimum = "0.3.0",
    canRun = () => true,
  ) => {
    if (pending) throw new Error("A pinote operation is already open. Retry after it finishes.");
    const operation = Symbol();
    pending = operation;
    const generation = epoch;
    refreshSerial++;
    try {
      return requiredTask(await run(argv, signal, () => alive && generation === epoch && canRun(), minimum), id);
    } finally {
      if (pending === operation) pending = undefined;
      if (alive && generation === epoch) await refresh(ctx);
    }
  };
  // One folder can host several sessions. Remember the task in the Pi session, not by cwd.
  const selectionType = "pinote-selection";
  let selectedId: number | null = null;
  let branchEpoch = 0;
  const remember = (id: number | null, branch = branchEpoch) => {
    if (!alive || branch !== branchEpoch || selectedId === id) return;
    previewBridge?.invalidate();
    selectedId = id;
    pi.appendEntry(selectionType, { id });
  };
  const readSelection = (ctx: ExtensionContext) => {
    let id: number | null = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== selectionType) continue;
      const data = entry.data as { id?: unknown } | null;
      id = data && validId(data.id) ? data.id : null;
    }
    return id;
  };
  const currentTask = async (signal?: AbortSignal, canUse = () => alive) => {
    const id = selectedId;
    if (!validId(id) || !canUse()) return null;
    const current = task(await run(["agent", "get", String(id)], signal, canUse));
    if (!canUse() || selectedId !== id) return null;
    if (!current || current.id !== id || !["active", "in_progress"].includes(current.state)) {
      if (canUse() && selectedId === id) remember(null);
      return null;
    }
    return current;
  };
  const selected = async (_ctx: ExtensionContext, signal?: AbortSignal) => {
    const generation = epoch;
    const branch = branchEpoch;
    const canUse = () => alive && generation === epoch && branch === branchEpoch;
    await ensureCLI(signal, canUse);
    return currentTask(signal, canUse);
  };
  const startTask = async (id: number, canAct: () => boolean, signal?: AbortSignal) => {
    const branch = branchEpoch;
    const still = () => canAct() && branch === branchEpoch;
    const before = requiredTask(await run(["agent", "get", String(id)], signal, still), id);
    if (!still()) return;
    if (!["active", "in_progress"].includes(before.state)) {
      throw new Error(`Note ${id} is ${before.state}; restore it first.`);
    }
    // Start without the shared cwd selection so another session can keep a different task.
    if (before.state === "active") await run(["--no-notify", "start", String(id)], signal, still);
    const chosen = requiredTask(await run(["agent", "get", String(id)], signal, still), id);
    if (chosen.state !== "in_progress") throw new Error(compatible);
    if (!still()) return;
    remember(chosen.id, branch);
    return chosen;
  };

  const refresh = async (ctx: ExtensionContext) => {
    if (!alive || setupAbort || !ctx.hasUI || ctx.mode !== "tui") return;
    const generation = epoch;
    const serial = ++refreshSerial;
    try {
      const current = await selected(ctx);
      if (alive && generation === epoch && serial === refreshSerial) {
        const previewId = current?.id ?? null;
        const previewBranch = branchEpoch;
        previewBridge?.setTask(previewId, (signal) => alive && generation === epoch && previewBranch === branchEpoch &&
          selectedId === previewId ? preview(ctx, signal) : Promise.resolve(false));
        const url = previewBridge?.url();
        // Truncate before linking so the full visible task, including overflow, is clickable.
        const label = current ? truncateToWidth(`${noteIcon} ${taskTag(current)} ${firstLine(current)}`, footerConfig.titleWidth, "...") : undefined;
        ctx.ui.setStatus("pinote", label && url ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label);
        watcher.update(ctx, current);
      }
    } catch {
      if (alive && generation === epoch && serial === refreshSerial) {
        previewBridge?.invalidate();
        ctx.ui.setStatus("pinote", `${noteIcon} Pinote unavailable · ${cliState === "upgrade" ? "/pi-note-upgrade" : cliState === "setup" ? "/pi-note-setup" : "/pi-note"}`);
      }
    }
  };
  const watcher = createPRWatcher(pi, {
    selected,
    footerConfig: () => footerConfig,
    get: async (id) => requiredTask(await run(["agent", "get", String(id)]), id),
    done: async (current, canAct) => {
      const result = requiredTask(await run([
        "agent", "done", String(current.id), "--expected-updated-at", current.updated_at,
      ], undefined, canAct), current.id);
      if (result.state !== "done") throw new Error(compatible);
    },
    claim: () => {
      if (pending) return;
      const operation = Symbol();
      pending = operation;
      return () => { if (pending === operation) pending = undefined; };
    },
    refresh,
  });
  const preview = async (ctx: ExtensionContext, requestSignal?: AbortSignal): Promise<boolean> => {
    if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.isIdle() || pending || !validId(selectedId)) return false;
    const generation = epoch;
    const branch = branchEpoch;
    const id = selectedId;
    const operation = Symbol();
    pending = operation;
    // Complete before the bridge's 5s and helper's 6s deadlines; disconnection cancels reads too.
    const controller = new AbortController();
    const deadline = Date.now() + 4000;
    const timer = setTimeout(() => controller.abort(), 4000);
    const signal = requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal;
    const canUse = () => alive && generation === epoch && branch === branchEpoch && selectedId === id && ctx.isIdle() &&
      !signal.aborted && Date.now() < deadline;
    try {
      const current = await currentTask(signal, canUse);
      if (!current || !canUse()) return false;
      // Custom entries are rendered locally, never conversation messages or compaction input.
      pi.appendEntry(previewType, { id: current.id, markdown: current.markdown });
      return true;
    } catch (error) {
      if (canUse()) ctx.ui.notify(`Pinote preview: ${clean(String(error))}`, "error");
      return false;
    } finally {
      clearTimeout(timer);
      if (pending === operation) pending = undefined;
    }
  };
  pi.registerCommand("pi-note-preview", {
    description: "Display the selected task locally without sending it to the model",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      if (args.trim()) { ctx.ui.notify("Usage: /pi-note-preview", "warning"); return; }
      if (!await preview(ctx)) ctx.ui.notify("Select a task with /pi-note and wait until Pi is idle before previewing.", "warning");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    setupAbort?.abort();
    // Retire old polling before bridge teardown/startup yields to its scheduled callbacks.
    watcher.stop();
    alive = false;
    epoch++;
    branchEpoch++;
    const generation = epoch;
    const previousBridge = previewBridge;
    previewBridge = undefined;
    if (previousBridge) await previousBridge.stop();
    if (generation !== epoch) return;
    alive = true;
    activeContext = ctx;
    selectedId = readSelection(ctx);
    footerConfig = loadFooterConfig((message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
    cliState = undefined;
    if (ctx.hasUI && ctx.mode === "tui") {
      if (offerConfigError) ctx.ui.notify(`Pinote task offers disabled: ${clean(offerConfigError)} Fix the configuration and /reload.`, "warning");
      ctx.ui.addAutocompleteProvider((current) => cliMenu(current, () => setupAbort ? undefined : cliState));
    }
    if (ctx.hasUI && ctx.mode === "tui") {
      const bridge = createPreviewBridge();
      previewBridge = bridge;
      try {
        await bridge.start();
      } catch {
        await bridge.stop();
        if (previewBridge === bridge) previewBridge = undefined;
        ctx.ui.notify("Pinote task link unavailable; use /pi-note-preview.", "warning");
      }
    }
    if (!alive || generation !== epoch) return;
    // Keep the setup lock until its aborted subprocess has actually settled.
    if (!setupAbort) pending = undefined;
    await checkCLI(ctx, true);
    if (!alive || generation !== epoch) return;
    if (!setupAbort) watcher.start(ctx);
    await refresh(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (!alive) return;
    branchEpoch++;
    previewBridge?.invalidate();
    const generation = branchEpoch;
    const id = readSelection(ctx);
    if (!alive || generation !== branchEpoch) return;
    selectedId = id;
    if (setupAbort) return;
    await refresh(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => { await refresh(ctx); });
  pi.on("agent_end", async (_event, ctx) => { await refresh(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => {
    setupAbort?.abort();
    alive = false;
    activeContext = undefined;
    selectedId = null;
    epoch++;
    branchEpoch++;
    refreshSerial++;
    watcher.stop();
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus("pinote", undefined);
    const bridge = previewBridge;
    previewBridge = undefined;
    if (bridge) await bridge.stop();
  });

  const registerInstallCommand = (name: "pi-note-setup" | "pi-note-upgrade") => pi.registerCommand(name, {
    description: name === "pi-note-setup" ? "Install the missing Python CLI with uv" : "Upgrade an older Python CLI to the bundled version",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      if (args.trim()) {
        ctx.ui.notify(`Usage: /${name}`, "warning");
        return;
      }
      if (pending || !ctx.isIdle()) {
        ctx.ui.notify("Wait until Pi is idle and the pinote operation has finished.", "warning");
        return;
      }
      const operation = Symbol();
      pending = operation;
      const generation = epoch;
      const controller = new AbortController();
      setupAbort = controller;
      watcher.stop();
      const currentSession = () => alive && generation === epoch;
      try {
        await setupCLI(pi, ctx, name === "pi-note-upgrade",
          () => currentSession() && ctx.isIdle(), controller.signal);
      } catch (error) {
        if (currentSession()) ctx.ui.notify(`Pinote setup: ${clean(String(error))}`, "error");
      } finally {
        if (pending === operation) pending = undefined;
        if (setupAbort === controller) setupAbort = undefined;
        const latestContext = activeContext ?? (currentSession() ? ctx : undefined);
        if (alive && latestContext) {
          const generation = epoch;
          await checkCLI(latestContext, !currentSession());
          if (!alive || generation !== epoch || setupAbort) return;
          watcher.start(latestContext);
          await refresh(latestContext);
        }
      }
    },
  });
  registerInstallCommand("pi-note-setup");
  registerInstallCommand("pi-note-upgrade");

  pi.registerCommand("pi-note", {
    description: "Continue, complete, switch tasks, or edit global settings (Tab)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      if (args.trim()) { ctx.ui.notify("Usage: /pi-note", "warning"); return; }
      if (pending || !ctx.isIdle()) {
        ctx.ui.notify("Wait until Pi is idle and the pinote operation has finished.", "warning");
        return;
      }
      const operation = Symbol();
      pending = operation;
      const generation = epoch;
      const branch = branchEpoch;
      const currentSession = () => alive && generation === epoch;
      const canAct = () => currentSession() && ctx.isIdle() && branch === branchEpoch;
      try {
        const current = await selected(ctx);
        if (!canAct()) return;
        let settings = false;
        while (canAct()) {
          if (settings) {
            const document = readFooterDocument();
            const root = document.raw === null ? {} : JSON.parse(document.raw);
            const config: PinoteSettings = {
              footer: { ...document.config, fields: effectiveFooterFields(document.config, current?.agent_notes) },
              handoffPrompt: "handoffPrompt" in root ? parseHandoffPrompt(root.handoffPrompt) : defaultHandoffPrompt,
            };
            let expectedRaw = document.raw;
            const edited = await ctx.ui.custom<"tasks" | undefined>((tui, theme, kb, done) =>
              new FooterSettings(config, Object.keys(current?.agent_notes ?? {}).filter((name) => name !== "Bar"),
                theme, (data, action) => kb.matches(data, action as Keybinding), done, () => tui.requestRender(),
                () => new Editor(tui, {
                  borderColor: (line) => theme.fg("accent", line),
                  selectList: { selectedPrefix: (line) => theme.fg("accent", line), selectedText: (line) => theme.fg("accent", line),
                    description: (line) => theme.fg("muted", line), scrollInfo: (line) => theme.fg("dim", line),
                    noMatch: (line) => theme.fg("warning", line) },
                }), (updated) => {
                  if (!canAct()) throw new Error("This session changed. Reopen settings before editing.");
                  const saved = saveFooterConfig(updated.footer, expectedRaw, updated.handoffPrompt);
                  expectedRaw = saved.raw;
                  footerConfig = saved.config;
                  void refresh(ctx);
                }));
            if (!canAct() || edited === undefined) return;
            settings = false;
            continue;
          }
          const action = current
            ? await ctx.ui.custom<string | undefined>((tui, theme, kb, done) =>
              new TaskMenu(`Pinote — ${taskState(current)} ${taskTag(current)} ${title(current)}`,
                theme, (data, action) => kb.matches(data, action as Keybinding), done, () => tui.requestRender()))
            : "Switch task";
          if (!action || !canAct()) return;
          if (action === "Settings") { settings = true; continue; }
          if (action === "Done" && current) {
            refreshSerial++;
            const completed = requiredTask(await run([
              "agent", "done", String(current.id), "--expected-updated-at", current.updated_at,
            ], undefined, canAct), current.id);
            if (completed.state !== "done") throw new Error(compatible);
            if (currentSession() && branch === branchEpoch) remember(null, branch);
            if (currentSession()) ctx.ui.notify(`Pinote #${current.id} completed.`, "info");
            return;
          }
          let id: number;
          if (action === "Continue" && current) {
            id = current.id;
          } else if (action === "Switch task") {
            const tasks = taskList(await run(["list", "--json"]));
            if (!canAct()) return;
            const choice = await ctx.ui.custom<number | "Settings" | undefined>((tui, theme, kb, done) =>
              withSettingsTab(new TaskPicker(tasks, theme, (data, action) => kb.matches(data, action),
                done, () => tui.requestRender()), () => done("Settings"), theme, () => tui.requestRender()));
            if (choice === undefined || !canAct()) return;
            if (choice === "Settings") { settings = true; continue; }
            id = choice;
          } else return;
          const handoff = handoffPrompt();
          refreshSerial++;
          const chosen = await startTask(id, canAct);
          if (!chosen || !canAct()) return;
          const draft = ctx.ui.getEditorText();
          ctx.ui.setEditorText(draft ? `${draft}\n\n${handoff}` : handoff);
          ctx.ui.notify(`Pinote #${chosen.id} is in progress. Task added to input.`, "info");
          return;
        }
      } catch (error) {
        if (currentSession()) ctx.ui.notify(`Pinote: ${clean(error instanceof Error ? error.message : String(error))}`, "error");
      } finally {
        if (pending === operation) pending = undefined;
        if (currentSession()) await refresh(ctx);
      }
    },
  });

  pi.registerTool({
    name: "pinote_get_current",
    label: "Pinote get current",
    promptGuidelines: createGuidance,
    description: "Read this session's current pinote task and its Markdown agent fields/revision. Returns null when none is selected. No ID argument. Use the returned updated_at for pinote_update_current.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      return toolResult(await selected(ctx, signal));
    },
  });
  pi.registerTool({
    name: "pinote_update_current",
    label: "Pinote update current",
    promptGuidelines: [handoffGuidance],
    description: "Patch arbitrary agent handoff fields on this session's current pinote task. No ID argument. Read first with pinote_get_current; pass its updated_at as expected_updated_at. Fails when no task is selected or the selection changes during the operation. set merges label/value pairs without replacing other fields or task text; values are Markdown, e.g. PR: [Fix #42](https://github.com/org/repo/pull/42). Set PR to one GitHub pull-request URL or Markdown link to show PR #N in the footer and watch for merge confirmation in interactive Pi. Read pinote_fields for the user's global field names, labels, link switches, formats, and widths; set those field names when their values are relevant. Fields without values stay hidden. When footer.fields is unset, set Bar to newline-separated field labels to show those Markdown fields in the footer; links in the text are clickable. remove deletes named fields. A stale revision fails; read again before retrying. Does not complete the task or change its tag.",
    parameters: Type.Object({
      expected_updated_at: Type.String({ minLength: 1 }),
      set: Type.Optional(Type.Record(Type.String(), Type.String())),
      remove: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!text(params.expected_updated_at) || !params.expected_updated_at.trim()) {
        throw new Error("expected_updated_at is required; read the current task first.");
      }
      const generation = epoch;
      const branch = branchEpoch;
      const id = selectedId;
      const canRun = () => alive && generation === epoch && branch === branchEpoch && selectedId === id;
      const current = await selected(ctx, signal);
      if (!canRun()) throw new Error("Pinote operation cancelled: the session or selected task changed.");
      if (!current) throw new Error("No selected pinote task. Select one with /pi-note first.");
      const argv = ["agent", "update", String(current.id), "--expected-updated-at", params.expected_updated_at,
        "--set-json", JSON.stringify(params.set ?? {})];
      for (const label of params.remove ?? []) argv.push(`--remove=${label}`);
      const updated = await writeTask(ctx, signal, argv, current.id, "0.3.0", canRun);
      if (!canRun()) {
        throw new Error("Pinote operation cancelled: the session or selected task changed. The write may have committed; read the current task before retrying.");
      }
      return toolResult(updated);
    },
  });
  pi.registerTool({
    name: "pinote_fields",
    label: "Pinote footer fields",
    promptGuidelines: ["Read pinote_fields before updating handoff fields to learn which global fields the user wants populated. Use pinote_update_current for meaningful values; omit empty or irrelevant fields. Do not edit global configuration without user approval."],
    description: "Read the user's global Pinote footer field definitions, including source names, display labels, link switches, formats, and widths. Use these names in pinote_update_current set to populate relevant task values. Fields without values are not displayed. Works without a selected task; does not modify configuration or task data.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadFooterConfig((message) => { if (ctx.hasUI) ctx.ui.notify(message, "warning"); });
      const value = { ...config, fields: effectiveFooterFields(config), legacy_bar: config.fields === null };
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
    },
  });
  pi.registerTool({
    name: "pinote_tags",
    label: "Pinote tags",
    description: "List saved pinote tag names so a new or retagged task can reuse one.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const value = parse(await run(["agent", "tags"], signal, () => true, "0.4.0"));
      if (!Array.isArray(value) || !value.every((item) => text(item))) throw new Error(compatible);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
    },
  });
  pi.registerTool({
    name: "pinote_add",
    label: "Pinote add",
    promptGuidelines: createGuidance,
    description: "Create an active pinote task. Start text with a short task title; put details after a blank line. Optional tag is registered if new. Set select true only after the user agrees to make it this session's active task; that starts it and remembers it for this session only. Omitting select leaves the current selection unchanged. Does not refresh the desktop notification or bind the project directory.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, description: "Short action-oriented title (aim for at most 60 characters), then optional blank line and details." }),
      tag: Type.Optional(Type.String({ minLength: 1 })),
      select: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!text(params.text) || !params.text.trim()) throw new Error("text must be a non-empty note.");
      if (params.tag !== undefined && (!text(params.tag) || !params.tag.trim())) {
        throw new Error("tag must be a non-empty name, or omit it.");
      }
      if (params.select !== undefined && typeof params.select !== "boolean") throw new Error("select must be a boolean.");
      const argv = ["agent", "add", `--text=${params.text}`];
      if (params.tag !== undefined) argv.push(`--tag=${params.tag}`);
      const generation = epoch;
      const branch = branchEpoch;
      const created = await writeTask(ctx, signal, argv, undefined, "0.4.0");
      if (params.select !== true) return toolResult(created);
      if (!alive || generation !== epoch || branch !== branchEpoch) throw new Error("Pinote operation cancelled: the session changed.");
      if (pending) throw new Error("A pinote operation is already open. Retry after it finishes.");
      const operation = Symbol();
      pending = operation;
      try {
        const chosen = await startTask(
          created.id, () => alive && generation === epoch && branch === branchEpoch && pending === operation, signal,
        );
        if (!chosen) throw new Error("Pinote operation cancelled: the session changed.");
        return toolResult(chosen);
      } finally {
        if (pending === operation) pending = undefined;
        if (alive && generation === epoch) await refresh(ctx);
      }
    },
  });
}
