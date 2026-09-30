import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { createPRWatcher } from "./pr-watch.ts";
import { TaskPicker, taskState, taskTag } from "./task-picker.ts";
import { compatibleVersion, setupCLI, setupHint } from "./setup.ts";

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
const idSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const compatible = "Incompatible note CLI response. Install pinote 0.3.0+ and check note on PATH.";
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value);
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "�");
const firstLine = (task: Summary) => clean(task.text.split("\n", 1)[0]).replace(/\s+/gu, " ").trim();
const title = (task: Summary) => truncateToWidth(`#${task.id} ${firstLine(task)}`, 60);

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

function toolResult(value: Task) {
  // Keep the model payload under 50 KiB at the CLI's limits; don't send the same fields twice.
  const { markdown: _markdown, ...data } = value;
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: value };
}

export default function (pi: ExtensionAPI) {
  let alive = true;
  let epoch = 0;
  let refreshSerial = 0;
  let pending: symbol | undefined;
  let setupAbort: AbortController | undefined;
  let activeContext: ExtensionContext | undefined;

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
  const run = async (argv: string[], signal?: AbortSignal, canRun = () => true) => {
    if (setupAbort) throw new Error("Pinote CLI setup is still running. Retry after it finishes.");
    // Old pinote treats unknown commands as note text. Probe safely before every call,
    // including tools in headless sessions, and do not cache across CLI upgrades/downgrades.
    const version = (await invoke(["--version"], signal)).trim();
    if (!compatibleVersion(version)) {
      throw new Error(`pi-note requires pinote 0.3.0+; found ${clean(version) || "an unknown CLI"}. ${setupHint}`);
    }
    if (!canRun()) throw new Error("Pinote operation cancelled: the session changed.");
    return invoke(argv, signal);
  };
  const selected = async (ctx: ExtensionContext, signal?: AbortSignal) =>
    task(await run(["agent", "selected", "--cwd", ctx.cwd], signal));

  const refresh = async (ctx: ExtensionContext) => {
    if (!alive || setupAbort || !ctx.hasUI || ctx.mode !== "tui") return;
    const generation = epoch;
    const serial = ++refreshSerial;
    try {
      const current = await selected(ctx);
      if (alive && generation === epoch && serial === refreshSerial) {
        ctx.ui.setStatus("pinote", current ? truncateToWidth(`${noteIcon} ${taskTag(current)} ${firstLine(current)}`, 60) : undefined);
        watcher.update(ctx, current);
      }
    } catch {
      if (alive && generation === epoch && serial === refreshSerial) {
        ctx.ui.setStatus("pinote", `${noteIcon} Pinote unavailable · /pi-note-setup`);
      }
    }
  };
  const watcher = createPRWatcher(pi, {
    selected,
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
  pi.on("session_start", async (_event, ctx) => {
    setupAbort?.abort();
    alive = true;
    activeContext = ctx;
    epoch++;
    // Keep the setup lock until its aborted subprocess has actually settled.
    if (!setupAbort) pending = undefined;
    if (!setupAbort) watcher.start(ctx);
    await refresh(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => { await refresh(ctx); });
  pi.on("agent_end", async (_event, ctx) => { await refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    setupAbort?.abort();
    alive = false;
    activeContext = undefined;
    epoch++;
    refreshSerial++;
    watcher.stop();
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus("pinote", undefined);
  });

  pi.registerCommand("pi-note-setup", {
    description: "Install the Python CLI with uv (optional --upgrade reinstalls the bundled version)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      if (args.trim() && args.trim() !== "--upgrade") {
        ctx.ui.notify("Usage: /pi-note-setup [--upgrade]", "warning");
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
        await setupCLI(pi, ctx, args.trim() === "--upgrade",
          () => currentSession() && ctx.isIdle(), controller.signal);
      } catch (error) {
        if (currentSession()) ctx.ui.notify(`Pinote setup: ${clean(String(error))}`, "error");
      } finally {
        if (pending === operation) pending = undefined;
        if (setupAbort === controller) setupAbort = undefined;
        const latestContext = activeContext ?? (currentSession() ? ctx : undefined);
        if (alive && latestContext) {
          watcher.start(latestContext);
          await refresh(latestContext);
        }
      }
    },
  });

  pi.registerCommand("pi-note", {
    description: "Continue, complete, or switch the selected pinote task",
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
      const currentSession = () => alive && generation === epoch;
      const canAct = () => currentSession() && ctx.isIdle();
      try {
        const current = await selected(ctx);
        if (!canAct()) return;
        const action = current
          ? await ctx.ui.select(`Pinote — ${taskState(current)} ${taskTag(current)} ${title(current)}`, ["Continue", "Done", "Switch task"])
          : "Switch task";
        if (!action || !canAct()) return;
        if (action === "Done" && current) {
          refreshSerial++;
          const completed = requiredTask(await run([
            "agent", "done", String(current.id), "--expected-updated-at", current.updated_at,
          ], undefined, canAct), current.id);
          if (completed.state !== "done") throw new Error(compatible);
          if (currentSession()) ctx.ui.notify(`Pinote #${current.id} completed.`, "info");
          return;
        }
        let id: number;
        if (action === "Continue" && current) {
          id = current.id;
        } else if (action === "Switch task") {
          const tasks = taskList(await run(["list", "--json"]));
          if (!canAct()) return;
          if (!tasks.length) { ctx.ui.notify("No active pinote tasks.", "info"); return; }
          const choice = await ctx.ui.custom<number | undefined>((tui, theme, kb, done) =>
            new TaskPicker(tasks, theme, (data, action) => kb.matches(data, action), done, () => tui.requestRender()));
          if (choice === undefined || !canAct()) return;
          id = choice;
        } else return;
        // Validate/start the explicit task and return its latest handoff in one transaction.
        refreshSerial++;
        const chosen = requiredTask(await run(["agent", "select", String(id), "--cwd", ctx.cwd], undefined, canAct), id);
        if (!canAct()) return;
        const draft = ctx.ui.getEditorText();
        const handoff = `Pinote task #${chosen.id} (revision ${chosen.updated_at}).\n` +
          "Use pinote_get to read current task data and pinote_update to save agent handoff fields.\n\n" + chosen.markdown;
        ctx.ui.setEditorText(draft ? `${draft}\n\n${handoff}` : handoff);
        ctx.ui.notify(`Pinote #${chosen.id} is in progress. Task added to input.`, "info");
      } catch (error) {
        if (currentSession()) ctx.ui.notify(`Pinote: ${clean(error instanceof Error ? error.message : String(error))}`, "error");
      } finally {
        if (pending === operation) pending = undefined;
        if (currentSession()) await refresh(ctx);
      }
    },
  });

  pi.registerTool({
    name: "pinote_get",
    label: "Pinote get",
    description: "Read a pinote task and its Markdown agent fields/revision. Omit id to read this project's selected task; supply id to read another task. Use the returned updated_at for pinote_update.",
    parameters: Type.Object({ id: Type.Optional(idSchema) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.id !== undefined && !validId(params.id)) throw new Error("id must be a positive safe integer.");
      const argv = params.id === undefined
        ? ["agent", "selected", "--cwd", ctx.cwd]
        : ["agent", "get", String(params.id)];
      const result = requiredTask(await run(argv, signal), params.id);
      return toolResult(result);
    },
  });
  pi.registerTool({
    name: "pinote_update",
    label: "Pinote update",
    description: "Patch arbitrary agent handoff fields on an explicit pinote task. Read first with pinote_get; pass its updated_at as expected_updated_at. set merges label/value pairs without replacing other fields or task text; values are Markdown, e.g. PR: [Fix #42](https://github.com/org/repo/pull/42). Set PR to one GitHub pull-request URL or Markdown link to show it in the footer and watch for merge confirmation in interactive Pi. remove deletes named fields. A stale revision fails; read again before retrying. Does not complete the task.",
    parameters: Type.Object({
      id: idSchema,
      expected_updated_at: Type.String({ minLength: 1 }),
      set: Type.Optional(Type.Record(Type.String(), Type.String())),
      remove: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!validId(params.id) || !text(params.expected_updated_at) || !params.expected_updated_at.trim()) {
        throw new Error("id and expected_updated_at are required; read the task first.");
      }
      if (pending) throw new Error("A pinote operation is already open. Retry after it finishes.");
      const operation = Symbol();
      pending = operation;
      const generation = epoch;
      refreshSerial++;
      try {
        const argv = ["agent", "update", String(params.id), "--expected-updated-at", params.expected_updated_at,
          "--set-json", JSON.stringify(params.set ?? {})];
        for (const label of params.remove ?? []) argv.push(`--remove=${label}`);
        const result = requiredTask(await run(argv, signal, () => alive && generation === epoch), params.id);
        return toolResult(result);
      } finally {
        if (pending === operation) pending = undefined;
        if (alive && generation === epoch) await refresh(ctx);
      }
    },
  });
}
