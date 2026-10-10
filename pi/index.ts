import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, Text, truncateToWidth, type Keybinding } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { updateTaskFooter, clearTaskFooter } from "./footer-status.ts";
import { defaultFooterConfig, defaultHandoffPrompt, defaultNewSessionPrompt, effectiveFooterFields, loadFooterConfig, parseHandoffPrompt, parseNewSessionPrompt, readFooterDocument, saveFooterConfig, type FooterConfig, type PinoteSettings } from "./footer-config.ts";
import { FooterSettings, TaskMenu, withSettingsTab, type SettingsOption, type SettingsResult } from "./footer-settings.ts";
import { TaskPicker, taskState, taskTag } from "./task-picker.ts";
import { bundledCLIVersion, detectCLI, setupCLI, setupHint, versionAtLeast, type CLIAction } from "./setup.ts";
import { createPreviewBridge } from "./preview-bridge.ts";
import { renderSuggestion, renderSelectedTask } from "./task-suggestion.ts";

const handoffGuidance = "Keep agent notes to at most three short bullets total: outcome, blocker, next action, only when relevant. Replace stale notes; omit narration, repeated task text, and routine test logs. Keep a GitHub pull request in the PR field. Read pinote_fields to learn the user's globally configured footer field names and presentation. Populate those fields with meaningful task values when relevant using pinote_update_current; fields without values stay hidden. Footer fields and widths are chosen by the user's pi-note.json config. Set configured fields with Markdown values; links are clickable. When footer.fields is unset, Bar selects labels, one per line. Do not list PR in Bar. Remove a field to hide it. Do not modify config without user approval.";
const implementationOfferGuidance = "When no pinote task is selected, suggest one only when implementation is expected to span multiple turns. Skip suggestions for questions, investigation, recon, and small edits such as changing a few configuration lines. If investigation develops into substantial implementation, suggest then. No plan is required; use a short title describing the work. Explicit user requests to create one remain allowed.";
const offerGuidance = {
  always: `${implementationOfferGuidance} For eligible work, use pinote_propose to show one suggested \`[tag] task\` in the bottom bar instead of asking in chat. In noninteractive modes, ask before creating it.`,
  "github-remote": `${implementationOfferGuidance} For eligible work, first verify with Git that the current repository has a remote whose URL host is github.com (HTTPS or SSH). Only then use pinote_propose to show one suggested \`[tag] task\` in the bottom bar instead of asking in chat. In noninteractive modes, ask before creating it. Local paths, other hosts, and GitHub-looking URL paths do not qualify. If no GitHub remote is verified, do not offer a task.`,
  never: "Do not offer to create a pinote task. Create one only when the user explicitly requests it.",
};
const consentGuidance = "When a different task would fit better and no task is selected, call pinote_propose again to replace the unaccepted suggestion without waiting for dismissal. The suggestion bar's plus creates, starts and selects the note; its cross dismisses only that suggestion, not future suggestions. Continue the requested work while the suggestion is pending; do not ask again in chat or create a note yourself. On a chat no, continue without a note; on a chat yes, call pinote_add with select true. Never add or select without consent. If a task is already selected, do not replace it unless the user asks to switch.";
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
// /new replaces the extension runtime, even before the outgoing session is saved.
// Transfer only the ID, keyed by the exact destination session file, within this process.
const continuationKey = Symbol.for("pi-note.new-session-selections");
const processState = globalThis as typeof globalThis & {
  [continuationKey]?: Map<string, number>;
};
const continuations = processState[continuationKey] ??= new Map<string, number>();
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
  const runtimeToken = randomBytes(16).toString("hex");
  let completionDispatch: {
    token: string; selection: string; task: Task; started: () => void; finish: (accepted: boolean) => void;
  } | undefined;
  const cancelCompletionDispatch = () => completionDispatch?.finish(false);
  let previewBridge: ReturnType<typeof createPreviewBridge> | undefined;
  const suggestionType = "pinote-suggestion";
  let suggestion: { text: string; tag?: string } | undefined;
  const saveSuggestion = () => pi.appendEntry(suggestionType, { suggestion: suggestion ?? null });
  const clearSuggestion = (ctx: ExtensionContext, persist = true) => {
    const hadSuggestion = suggestion !== undefined;
    previewBridge?.clearSuggestion();
    if (hadSuggestion && ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus("pinote", undefined);
    suggestion = undefined;
    if (persist && hadSuggestion) saveSuggestion();
  };
  const restoreSuggestion = (ctx: ExtensionContext) => {
    suggestion = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== suggestionType) continue;
      const data = entry.data;
      if (!record(data)) continue;
      const value = data.suggestion;
      // Legacy dismissal entries clear their proposal, but never block a new one.
      suggestion = data.declined !== true && record(value) && text(value.text) && value.text.trim() &&
        (value.tag === undefined || (text(value.tag) && value.tag.trim() && value.tag.length <= 64))
        ? { text: value.text, ...(value.tag === undefined ? {} : { tag: value.tag as string }) } : undefined;
    }
    if (selectedId !== null) suggestion = undefined;
  };
  let alive = true;
  let epoch = 0;
  let refreshSerial = 0;
  let pending: symbol | undefined;
  let menuPending: symbol | undefined;
  let previewPending = false;
  let setupAbort: AbortController | undefined;
  let activeContext: ExtensionContext | undefined;
  let cliState: CLIAction | undefined;
  let footerConfig = { ...defaultFooterConfig };
  const suggestionStatus = (ctx: ExtensionContext) => suggestion ? renderSuggestion(
    suggestion, footerConfig.titleWidth, ctx.ui.theme, {
      yes: previewBridge?.suggestionUrl("yes"), no: previewBridge?.suggestionUrl("no"),
    },
  ) : undefined;
  const checkCLI = async (ctx: ExtensionContext, suggest = false) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || setupAbort) return;
    const generation = epoch;
    const action = await detectCLI(pi);
    if (!alive || generation !== epoch || setupAbort) return;
    cliState = action;
    if (suggest && action === "upgrade") {
      ctx.ui.notify(`Pinote CLI ${bundledCLIVersion} is bundled with this extension. Open /pi-note → Settings → Upgrade CLI to update your older CLI.`, "info");
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
    if (activeContext) clearSuggestion(activeContext);
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
      if (!pending && canUse() && selectedId === id) remember(null);
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
          selectedId === previewId ? preview(ctx, signal) : Promise.resolve(false), current ? {
            revision: current.updated_at,
            invoke: () => alive && generation === epoch && previewBranch === branchEpoch && selectedId === previewId
              ? dispatchCompletion(ctx, current, `${runtimeToken}:${generation}:${previewBranch}:${previewId}`) : Promise.resolve(false),
          } : undefined);
        ctx.ui.setStatus("pinote", current ? renderSelectedTask(current, footerConfig.titleWidth, ctx.ui.theme, {
          preview: previewBridge?.url(), done: previewBridge?.doneUrl(),
        }) : suggestionStatus(ctx));
        updateTaskFooter(ctx, current, footerConfig);
      }
    } catch {
      if (alive && generation === epoch && serial === refreshSerial) {
        previewBridge?.invalidate();
        clearTaskFooter(ctx);
        ctx.ui.setStatus("pinote", suggestionStatus(ctx) ?? `${ctx.ui.theme.bold(noteIcon)} Pinote unavailable · /pi-note → Settings`);
      }
    }
  };
  const preview = async (ctx: ExtensionContext, requestSignal?: AbortSignal): Promise<boolean> => {
    if (!ctx.hasUI || ctx.mode !== "tui" || pending || menuPending || previewPending || !validId(selectedId)) return false;
    const generation = epoch;
    const branch = branchEpoch;
    const id = selectedId;
    // Serialize clicks without blocking the agent's task updates.
    previewPending = true;
    // Complete before the bridge's 5s and helper's 6s deadlines; disconnection cancels reads too.
    const controller = new AbortController();
    const deadline = Date.now() + 4000;
    const timer = setTimeout(() => controller.abort(), 4000);
    const signal = requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal;
    const canUse = () => alive && generation === epoch && branch === branchEpoch && selectedId === id && !pending &&
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
      previewPending = false;
    }
  };
  const dispatchCompletion = (ctx: ExtensionContext, displayed: Task, selection: string): Promise<boolean> => {
    if (!ctx.isIdle() || pending || menuPending || completionDispatch) return Promise.resolve(false);
    const token = `${selection}:${randomBytes(8).toString("hex")}`;
    return new Promise((resolve) => {
      const finish = (accepted: boolean) => {
        clearTimeout(timer);
        if (completionDispatch?.token === token) completionDispatch = undefined;
        resolve(accepted);
      };
      const timer = setTimeout(() => {
        finish(false);
        if (alive && activeContext === ctx) ctx.ui.notify("Pinote completion could not start. Open /pi-note → Settings → Complete task.", "warning");
      }, 4000);
      completionDispatch = { token, selection, task: displayed, started: () => clearTimeout(timer), finish };
      try { pi.sendUserMessage(`/pi-note ${token}`, { expandPromptTemplates: true }); }
      catch { finish(false); }
    });
  };
  const completeSelected = async (args: string, ctx: ExtensionCommandContext, displayed?: Task) => {
    const token = args.trim();
    const request = token ? completionDispatch : undefined;
    if (token && (request?.token !== token || request.selection !== `${runtimeToken}:${epoch}:${branchEpoch}:${selectedId}`)) return;
    if (!alive || !ctx.hasUI || ctx.mode !== "tui" || !ctx.isIdle() || pending || menuPending || setupAbort || !validId(selectedId)) {
      request?.finish(false);
      if (ctx.hasUI) ctx.ui.notify("Select a task and wait until Pi is idle and the Pinote operation has finished.", "warning");
      return;
    }
    const generation = epoch;
    const branch = branchEpoch;
    const id = selectedId;
    const operation = Symbol();
    pending = operation;
    request?.started();
    refreshSerial++;
    const canAct = () => alive && generation === epoch && branch === branchEpoch && selectedId === id && ctx.isIdle();
    let wrote = false;
    try {
      const current = request?.task ?? displayed ?? await currentTask(undefined, canAct);
      if (!current || current.id !== id || !canAct()) return;
      const completed = requiredTask(await run([
        "agent", "done", String(id), "--expected-updated-at", current.updated_at,
      ], undefined, canAct), id);
      wrote = true;
      if (completed.state !== "done") throw new Error(compatible);
      if (!canAct()) throw new Error("The session or selection changed. Completion may have committed; read the task before retrying.");
      request?.finish(true);
      remember(null, branch);
      await refresh(ctx);
      if (!alive || generation !== epoch || branch !== branchEpoch || selectedId !== null || !ctx.isIdle()) {
        throw new Error("Task completed, but the session changed. Start a new session manually.");
      }
      // Only a fresh command context may clear the new editor and reload the runtime.
      const result = await ctx.newSession({ withSession: async (fresh) => {
        fresh.ui.setEditorText("");
        await fresh.reload();
      } });
      if (result.cancelled) ctx.ui.notify("Task completed; new session was cancelled.", "warning");
    } catch (error) {
      if (alive && generation === epoch) ctx.ui.notify(
        `Pinote completion: ${clean(String(error))}${wrote ? " Check the task before retrying." : ""}`, "error");
    } finally {
      request?.finish(false);
      if (pending === operation) pending = undefined;
      if (alive && generation === epoch) await refresh(ctx);
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    setupAbort?.abort();
    cancelCompletionDispatch();
    clearTaskFooter(activeContext ?? ctx);
    clearSuggestion(activeContext ?? ctx, false);
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
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const continuation = sessionFile ? continuations.get(sessionFile) : undefined;
    if (sessionFile) continuations.delete(sessionFile);
    const carrying = _event.reason === "new" && validId(continuation);
    if (carrying) remember(continuation);
    restoreSuggestion(ctx);
    if (_event.reason === "new" || _event.reason === "fork") {
      // A fork may include an ancestor proposal whose consent was consumed elsewhere.
      clearSuggestion(ctx, false);
      if (ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === suggestionType)) saveSuggestion();
    }
    footerConfig = loadFooterConfig((message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
    cliState = undefined;
    if (ctx.hasUI && ctx.mode === "tui") {
      if (offerConfigError) ctx.ui.notify(`Pinote task offers disabled: ${clean(offerConfigError)} Fix the configuration and /reload.`, "warning");
    }
    if (ctx.hasUI && ctx.mode === "tui") {
      const bridge = createPreviewBridge();
      previewBridge = bridge;
      try {
        await bridge.start();
      } catch {
        await bridge.stop();
        if (previewBridge === bridge) previewBridge = undefined;
        ctx.ui.notify("Pinote task link unavailable; open /pi-note → Settings → Preview task.", "warning");
      }
    }
    if (!alive || generation !== epoch) return;
    // Keep the setup lock until its aborted subprocess has actually settled.
    if (!setupAbort) pending = undefined;
    menuPending = undefined;
    await checkCLI(ctx, true);
    if (!alive || generation !== epoch) return;
    if (suggestion) previewBridge?.setSuggestion((choice) => respondToSuggestion(choice, ctx));
    await refresh(ctx);
    if (carrying && alive && generation === epoch) {
      try {
        const branch = branchEpoch;
        const current = await selected(ctx);
        if (!current || !alive || generation !== epoch || branch !== branchEpoch || selectedId !== current.id ||
            !ctx.hasUI || ctx.mode !== "tui") return;
        const config = readConfig();
        const prompt = "newSessionPrompt" in config ? parseNewSessionPrompt(config.newSessionPrompt) : defaultNewSessionPrompt;
        if (prompt.trim()) {
          const draft = ctx.ui.getEditorText();
          ctx.ui.setEditorText(draft ? `${draft}\n\n${prompt}` : prompt);
        }
      } catch (error) {
        if (alive && generation === epoch && ctx.hasUI) ctx.ui.notify(`Pinote new session: ${clean(String(error))}`, "warning");
      }
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (!alive) return;
    branchEpoch++;
    cancelCompletionDispatch();
    clearSuggestion(ctx, false);
    // Never resurrect an already consumed proposal by navigating behind its tombstone.
    saveSuggestion();
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
    // Shutdown means replacement was accepted; cancelled /new never leaves a transfer.
    if (_event.reason === "new" && _event.targetSessionFile && validId(selectedId)) {
      // Bound orphaned transfers if creating the replacement runtime fails.
      if (continuations.size >= 32) continuations.delete(continuations.keys().next().value!);
      continuations.set(_event.targetSessionFile, selectedId);
    }
    setupAbort?.abort();
    cancelCompletionDispatch();
    clearSuggestion(ctx, false);
    alive = false;
    activeContext = undefined;
    selectedId = null;
    epoch++;
    branchEpoch++;
    refreshSerial++;
    clearTaskFooter(ctx);
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus("pinote", undefined);
    const bridge = previewBridge;
    previewBridge = undefined;
    if (bridge) await bridge.stop();
  });

  const installCLI = async (upgrade: boolean, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (pending || menuPending || !ctx.isIdle()) {
      ctx.ui.notify("Wait until Pi is idle and the pinote operation has finished.", "warning");
      return;
    }
    const operation = Symbol();
    pending = operation;
    const generation = epoch;
    const controller = new AbortController();
    setupAbort = controller;
    clearTaskFooter(ctx);
    const currentSession = () => alive && generation === epoch;
    try {
      await setupCLI(pi, ctx, upgrade,
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
        await refresh(latestContext);
      }
    }
  };

  pi.registerCommand("pi-note", {
    description: "Continue, complete, switch tasks, or edit global settings (Tab)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      // Footer completion needs a command context, but no extra slash command.
      // Only the current one-use capability may dispatch; stale tokens remain inert.
      const token = args.trim();
      if (/^[a-f0-9]{32}:\d+:\d+:\d+:[a-f0-9]{16}$/u.test(token)) {
        await completeSelected(token, ctx);
        return;
      }
      if (token) { ctx.ui.notify("Usage: /pi-note", "warning"); return; }
      if (pending || menuPending) {
        ctx.ui.notify("Wait until the pinote operation has finished.", "warning");
        return;
      }
      const operation = Symbol();
      menuPending = operation;
      const generation = epoch;
      const branch = branchEpoch;
      const currentSession = () => alive && generation === epoch;
      // Menus, task selection and preference edits do not interrupt the agent.
      // Completion and CLI setup retain their own idle-only guards.
      const canAct = () => currentSession() && branch === branchEpoch && menuPending === operation;
      try {
        await checkCLI(ctx);
        if (!canAct()) return;
        const current = cliState === "ready" ? await selected(ctx) : null;
        if (!canAct()) return;
        let settings = cliState !== "ready";
        while (canAct()) {
          if (!settings && cliState !== "ready") {
            ctx.ui.notify(setupHint, "warning");
            return;
          }
          if (settings) {
            let config: PinoteSettings = { footer: { ...defaultFooterConfig, fields: [] }, handoffPrompt: defaultHandoffPrompt, newSessionPrompt: defaultNewSessionPrompt };
            let expectedRaw: string | null = null;
            let configurationError: string | undefined;
            try {
              const document = readFooterDocument();
              const root = document.raw === null ? {} : JSON.parse(document.raw);
              config = {
                footer: { ...document.config, fields: effectiveFooterFields(document.config, current?.agent_notes) },
                handoffPrompt: "handoffPrompt" in root ? parseHandoffPrompt(root.handoffPrompt) : defaultHandoffPrompt,
                newSessionPrompt: "newSessionPrompt" in root ? parseNewSessionPrompt(root.newSessionPrompt) : defaultNewSessionPrompt,
              };
              expectedRaw = document.raw;
            } catch (error) {
              // Broken preferences must not strand task actions or CLI recovery.
              // Offer actions only; never save defaults over invalid user data.
              configurationError = clean(error instanceof Error ? error.message : String(error));
            }
            const options: SettingsOption[] = [
              ...(current ? [
                { label: "Preview task", result: "preview" as const },
                { label: "Complete task (new session)", result: "done" as const },
              ] : []),
              ...(suggestion ? [
                { label: "Accept suggestion", result: "yes" as const },
                { label: "Dismiss suggestion", result: "no" as const },
              ] : []),
              ...(cliState === "setup" ? [{ label: "Install CLI", result: "setup" as const }]
                : cliState === "upgrade" ? [{ label: "Upgrade CLI", result: "upgrade" as const }] : []),
            ];
            const edited = await ctx.ui.custom<SettingsResult>((tui, theme, kb, done) =>
              new FooterSettings(config, Object.keys(current?.agent_notes ?? {}).filter((name) => name !== "Bar"),
                theme, (data, action) => kb.matches(data, action as Keybinding), done, () => tui.requestRender(),
                () => new Editor(tui, {
                  borderColor: (line) => theme.fg("accent", line),
                  selectList: { selectedPrefix: (line) => theme.fg("accent", line), selectedText: (line) => theme.fg("accent", line),
                    description: (line) => theme.fg("muted", line), scrollInfo: (line) => theme.fg("dim", line),
                    noMatch: (line) => theme.fg("warning", line) },
                }), (updated) => {
                  if (!canAct()) throw new Error("This session changed. Reopen settings before editing.");
                  if (configurationError) throw new Error(configurationError);
                  const saved = saveFooterConfig(updated.footer, expectedRaw, updated.handoffPrompt, updated.newSessionPrompt);
                  expectedRaw = saved.raw;
                  footerConfig = saved.config;
                  void refresh(ctx);
                }, options, configurationError));
            if (!canAct() || edited === undefined) return;
            if (edited === "tasks") { settings = false; continue; }
            if (!options.some((option) => option.result === edited)) return;
            if (menuPending === operation) menuPending = undefined;
            if (edited === "preview") {
              if (!await preview(ctx)) ctx.ui.notify("The task is no longer available for preview.", "warning");
            } else if (edited === "done") await completeSelected("", ctx, current ?? undefined);
            else if (edited === "yes" || edited === "no") await respondToSuggestion(edited, ctx);
            else await installCLI(edited === "upgrade", ctx);
            return;
          }
          const action = current
            ? await ctx.ui.custom<string | undefined>((tui, theme, kb, done) =>
              new TaskMenu(`Pinote — ${taskState(current)} ${taskTag(current)} ${title(current)}`,
                theme, (data, action) => kb.matches(data, action as Keybinding), done, () => tui.requestRender()))
            : "Switch task";
          if (!action || !canAct()) return;
          if (action === "Settings") { settings = true; continue; }
          if (action === "Done" && current) {
            if (menuPending === operation) menuPending = undefined;
            await completeSelected("", ctx, current);
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
          if (pending) {
            ctx.ui.notify("Wait until the pinote operation has finished.", "warning");
            return;
          }
          pending = operation;
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
        if (menuPending === operation) menuPending = undefined;
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
    description: "Patch arbitrary agent handoff fields on this session's current pinote task. No ID argument. Read first with pinote_get_current; pass its updated_at as expected_updated_at. Fails when no task is selected or the selection changes during the operation. set merges label/value pairs without replacing other fields or task text; values are Markdown, e.g. PR: [Fix #42](https://github.com/org/repo/pull/42). Set PR to one GitHub pull-request URL or Markdown link to show PR #N in the footer. Pinote does not poll GitHub or prompt on PR merges. Read pinote_fields for the user's global field names, labels, link switches, formats, and widths; set those field names when their values are relevant. Fields without values stay hidden. When footer.fields is unset, set Bar to newline-separated field labels to show those Markdown fields in the footer; links in the text are clickable. remove deletes named fields. A stale revision fails; read again before retrying. Does not complete the task or change its tag.",
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
  const respondToSuggestion = async (choice: "yes" | "no", ctx: ExtensionContext): Promise<boolean> => {
    const proposed = suggestion;
    if (!alive || !proposed || selectedId !== null) return false;
    if (choice === "no") {
      clearSuggestion(ctx);
      return true;
    }
    if (pending || menuPending || setupAbort) return false;
    const generation = epoch;
    const branch = branchEpoch;
    const operation = Symbol();
    pending = operation;
    refreshSerial++;
    const canAct = () => alive && generation === epoch && branch === branchEpoch && selectedId === null && pending === operation;
    // Consume consent before yielding: repeat clicks cannot create duplicate notes.
    clearSuggestion(ctx);
    let created: Task | undefined;
    try {
      const argv = ["agent", "add", `--text=${proposed.text}`];
      if (proposed.tag !== undefined) argv.push(`--tag=${proposed.tag}`);
      // Accepted mutations drain even if the click helper disconnects.
      created = requiredTask(await run(argv, undefined, canAct, "0.4.0"));
      if (!canAct()) throw new Error("The session or selection changed; the note was created but not selected.");
      const chosen = await startTask(created.id, canAct);
      if (!chosen || !alive || generation !== epoch || branch !== branchEpoch || selectedId !== chosen.id) {
        throw new Error("The session or selection changed; the note may have started but was not selected here.");
      }
      ctx.ui.notify(`Pinote #${chosen.id} created and selected.`, "info");
      return true;
    } catch (error) {
      if (alive && generation === epoch) ctx.ui.notify(
        `Pinote suggestion: ${clean(String(error))}${created ? ` Note #${created.id} was created; use /pi-note to select it. Do not add it again.` : " A write may have committed; check /pi-note before retrying."}`, "error");
      return false;
    } finally {
      if (pending === operation) pending = undefined;
      if (alive && generation === epoch) await refresh(ctx);
    }
  };
  pi.registerTool({
    name: "pinote_propose",
    label: "Pinote suggest task",
    promptGuidelines: createGuidance,
    description: "Show a suggested task beside the pin icon in the footer, without creating it or asking in chat. + creates, starts and selects it; ✕ dismisses it. Continue the requested work while awaiting consent. Requires an interactive TUI with no selected task. A new proposal replaces the unaccepted suggestion and invalidates its old links; no dismissal is needed. Dismissal clears only the current suggestion and allows later proposals. In noninteractive modes ask in chat, then use pinote_add only after consent.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, description: "Short action-oriented title, then optional details after a blank line." }),
      tag: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!text(params.text) || !params.text.trim()) throw new Error("text must be a non-empty note.");
      if (params.tag !== undefined && (!text(params.tag) || !params.tag.trim() || params.tag.trim().length > 64)) throw new Error("tag must be a non-empty name of at most 64 characters.");
      if (!alive || !ctx.hasUI || ctx.mode !== "tui") throw new Error("Task suggestions need an interactive TUI. Ask in chat before using pinote_add.");
      const generation = epoch;
      const branch = branchEpoch;
      const current = await selected(ctx, signal);
      if (!alive || generation !== epoch || branch !== branchEpoch) throw new Error("Pinote operation cancelled: the session changed.");
      if (current || selectedId !== null) throw new Error("A task is already selected; keep it unless the user asks to switch.");
      if (pending || menuPending || setupAbort) throw new Error("A pinote operation is already open. Retry after it finishes.");
      const result = (status: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ status }) }], details: { status } });
      suggestion = { text: params.text, ...(params.tag === undefined ? {} : { tag: params.tag.trim() }) };
      saveSuggestion();
      previewBridge?.setSuggestion((choice) => respondToSuggestion(choice, ctx));
      ctx.ui.setStatus("pinote", suggestionStatus(ctx));
      return result("pending; user can click + to add and select or ✕ to dismiss, continue work without asking again");
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
      if (params.select !== true) return toolResult(await writeTask(ctx, signal, argv, undefined, "0.4.0"));
      if (pending || menuPending) throw new Error("A pinote operation is already open. Retry after it finishes.");
      const operation = Symbol();
      const previousSelection = selectedId;
      pending = operation;
      refreshSerial++;
      const canAct = () => alive && generation === epoch && branch === branchEpoch && pending === operation && selectedId === previousSelection;
      // Chat consent consumes the same suggestion as clicking +, even if start fails.
      clearSuggestion(ctx);
      try {
        const created = requiredTask(await run(argv, signal, canAct, "0.4.0"));
        if (!canAct()) throw new Error("Pinote operation cancelled: the session changed. The note was created; check /pi-note before retrying.");
        const chosen = await startTask(created.id, canAct, signal);
        if (!chosen || !alive || generation !== epoch || branch !== branchEpoch || selectedId !== chosen.id) {
          throw new Error("Pinote operation cancelled: the session changed. The note may have started; check /pi-note before retrying.");
        }
        return toolResult(chosen);
      } finally {
        if (pending === operation) pending = undefined;
        if (alive && generation === epoch) await refresh(ctx);
      }
    },
  });
}
