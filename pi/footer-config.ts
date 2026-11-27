import { getAgentDir } from "./config-path.js";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFieldWatchers, watcherEntries, type FieldWatcherConfig } from "./field-watchers.ts";
import { fieldTypes, type FieldType } from "./field-values.ts";

export const defaultHandoffPrompt = "Read the current Pinote task. Summarize your understanding, but don’t start work yet.";
export const defaultNewSessionPrompt = defaultHandoffPrompt;
export const defaultAgentGuidance = `Never replace an existing selection. Use injected context instead of routine read calls.

Search tasks only when the user explicitly asks to search or find tasks; continuing work or suggesting a task is not such a request.

No task selected: propose one, with a saved tag where one fits, only for new multi-step work that changes things, not for questions, research, read-only inspection or trivial edits. To continue known work, read it with get_task and propose its task_id; without an ID, let the user select it. Keep working meanwhile where possible. Only user acceptance creates or selects a task.

For the selected task, maintain enabled handoff fields per their instructions: save verified values when their trigger occurs and check for missing or changed ones before finishing or handing off. Never invent values, fill disabled fields unasked or overwrite unrelated ones. Add to list fields with append. Session IDs are recorded by the integration.`;
export function parseAgentGuidance(value: unknown): string {
  if (typeof value !== "string" || value.length > 64_000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value)) {
    throw new Error("agentGuidance in pi-note.json must be a string of at most 64000 characters without control characters (except tabs/newlines).");
  }
  return value;
}
export function parseNewSessionPrompt(value: unknown): string {
  if (typeof value !== "string" || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value)) {
    throw new Error("newSessionPrompt in pi-note.json must be a string without control characters (except tabs/newlines).");
  }
  return value;
}
export function parseHandoffPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(value)) {
    throw new Error("handoffPrompt in pi-note.json must be a nonblank string without control characters (except tabs/newlines).");
  }
  return value;
}
/** Whether a Pi pane sharing its Kitty tab with another task's pane moves to a new tab when it selects a task. */
export function parseKittyOneTaskPerTab(root: Record<string, unknown>): boolean {
  const value = Object.hasOwn(root, "kittyOneTaskPerTab") ? root.kittyOneTaskPerTab : false;
  if (typeof value !== "boolean") throw new Error("kittyOneTaskPerTab in pi-note.json must be true or false.");
  return value;
}
/** What Pi does after you complete its selected task from Pinote: stay, exit, or exit and close its Kitty pane. */
export const taskCompletionActions = ["keep-open", "close-pi", "close-pane"] as const;
export type TaskCompletionAction = typeof taskCompletionActions[number];
export function parseTaskCompletion(root: Record<string, unknown>): TaskCompletionAction {
  const value = Object.hasOwn(root, "onTaskComplete") ? root.onTaskComplete : "close-pi";
  if (!taskCompletionActions.includes(value as TaskCompletionAction)) throw new Error(`onTaskComplete in pi-note.json must be one of ${taskCompletionActions.join(", ")}.`);
  return value as TaskCompletionAction;
}
export type PinoteSettings = { footer: FooterConfig; handoffPrompt: string; newSessionPrompt?: string };

export type FooterField = { name: string; label: string; link: boolean; format: string; width?: number; enabled?: boolean; instructions?: string; type?: FieldType };
export type FooterConfig = { titleWidth: number; fieldWidth: number; maxFields: number; fields: FooterField[] | null; bar?: string[] | null };
export const defaultFooterConfig: FooterConfig = { titleWidth: 60, fieldWidth: 60, maxFields: 4, fields: null, bar: null };
export const defaultFooterField = (name: string): FooterField => ({
  name, label: name, link: true, format: name === "PR" || name === "PRs" ? "#<number>" : "<value>",
});
export const defaultFieldInstructions = (name: string): string => name === "Worktrees"
  ? "Append each absolute worktree root right after choosing or creating it for this task. Never create one just to fill this field."
  : name === "PRs" || name === "PR"
    ? "Append each GitHub or Forgejo PR URL right after creating it."
    : "";
export const defaultFieldPresets = (): FooterField[] => ["Worktrees", "PRs"].map((name) => ({
  ...defaultFooterField(name), enabled: false, instructions: defaultFieldInstructions(name),
}));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const width = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 3 && Number(value) <= 1000;
const safeText = (value: unknown): value is string => typeof value === "string" && !/[\x00-\x1f\x7f-\x9f]/u.test(value);

export function parseFooterConfig(value: unknown): FooterConfig {
  if (!object(value)) throw new Error("expected an object");
  if (value.footer === undefined) return { ...defaultFooterConfig };
  if (!object(value.footer)) throw new Error("footer must be an object");
  const footer = value.footer;
  for (const key of ["titleWidth", "fieldWidth"] as const) {
    if (footer[key] !== undefined && !width(footer[key])) throw new Error(`${key} must be an integer from 3 to 1000`);
  }
  if (footer.maxFields !== undefined &&
      (!Number.isInteger(footer.maxFields) || Number(footer.maxFields) < 0 || Number(footer.maxFields) > 64)) {
    throw new Error("maxFields must be an integer from 0 to 64");
  }
  let fields: FooterField[] | null = null;
  if (footer.fields !== undefined && footer.fields !== null) {
    if (!Array.isArray(footer.fields) || footer.fields.length > 64) throw new Error("fields must be null or an array of at most 64 fields");
    const seen = new Set<string>();
    fields = footer.fields.map((entry): FooterField => {
      const field = typeof entry === "string" ? { name: entry } : entry;
      if (!object(field)) throw new Error("each field needs a name");
      // Accept the original {label: name, width} form as well as explicit names.
      const source = field.name === undefined ? field.label : field.name;
      if (!safeText(source)) throw new Error("invalid field name");
      const name = source.normalize("NFC").trim();
      if (!name || [...name].length > 64 || name === "Bar") throw new Error("invalid field name");
      if (seen.has(name)) throw new Error("duplicate field name");
      seen.add(name);
      const label = field.name === undefined ? name : field.label === undefined ? name : field.label;
      const format = field.format === undefined ? defaultFooterField(name).format : field.format;
      if (!safeText(label) || [...label].length > 64) throw new Error("invalid display label");
      if (!safeText(format) || format.length > 4096 || /<(?!value>|number>|url>)[^>]*>/u.test(format)) {
        throw new Error("format supports only <value>, <number>, and <url>");
      }
      if (field.enabled !== undefined && typeof field.enabled !== "boolean") throw new Error("enabled must be a boolean");
      if (field.instructions !== undefined && (typeof field.instructions !== "string" || field.instructions.length > 4096 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(field.instructions))) throw new Error("instructions must be at most 4096 characters without control characters (except tabs/newlines)");
      if (field.link !== undefined && typeof field.link !== "boolean") throw new Error("link must be a boolean");
      if (field.type !== undefined && !fieldTypes.includes(field.type as FieldType)) throw new Error("type must be text, list or unique-list");
      if (field.width !== undefined && !width(field.width)) throw new Error("field width must be an integer from 3 to 1000");
      return { name, label, ...(field.enabled === undefined ? {} : { enabled: field.enabled as boolean }),
        ...(field.instructions === undefined ? {} : { instructions: field.instructions as string }), link: field.link as boolean | undefined ?? true, format,
        ...(field.width === undefined ? {} : { width: field.width as number }),
        ...(field.type === undefined ? {} : { type: field.type as FieldType }) };
    });
  }
  let bar: string[] | null = null;
  if (footer.bar !== undefined && footer.bar !== null) {
    if (!Array.isArray(footer.bar) || footer.bar.length > 64) throw new Error("bar must be null or an array of at most 64 field names");
    const seen = new Set<string>();
    bar = footer.bar.map((entry) => {
      if (!safeText(entry)) throw new Error("invalid field name");
      const name = entry.normalize("NFC").trim();
      if (!name || [...name].length > 64 || name === "Bar") throw new Error("invalid field name");
      const normalized = name === "PR" ? "PRs" : name;
      if (seen.has(normalized)) throw new Error("duplicate field name");
      seen.add(normalized);
      return normalized;
    });
  }
  return {
    titleWidth: footer.titleWidth as number | undefined ?? defaultFooterConfig.titleWidth,
    fieldWidth: footer.fieldWidth as number | undefined ?? defaultFooterConfig.fieldWidth,
    maxFields: footer.maxFields as number | undefined ?? defaultFooterConfig.maxFields, fields, bar,
  };
}

function readRaw(): string | null {
  try { return readFileSync(join(getAgentDir(), "pi-note.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function readConfigDocument() {
  const raw = readRaw();
  let value: unknown = {};
  if (raw !== null) {
    try { value = JSON.parse(raw); } catch { throw new Error("Invalid JSON in pi-note.json."); }
  }
  if (!object(value)) throw new Error("expected an object");
  return { raw, value };
}
export function readFooterDocument() {
  const { raw, value } = readConfigDocument();
  return { raw, config: parseFooterConfig(value) };
}
export function loadFooterConfig(warn: (message: string) => void): FooterConfig {
  try { return readFooterDocument().config; }
  catch {
    warn("Cannot load pi-note.json; using default Pinote footer settings. Check the footer configuration in pi-note's README.");
    return { ...defaultFooterConfig };
  }
}

// Synchronous compare-and-replace: reject edits made while the settings dialog was open,
// preserve unrelated keys, and never leave partial JSON behind.
function replaceConfigDocument(expectedRaw: string | null, change: (root: Record<string, unknown>) => Record<string, unknown>): string {
  const directory = getAgentDir();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "pi-note.json");
  const lock = join(directory, "pi-note.json.lock");
  let descriptor: number;
  try { descriptor = openSync(lock, "wx", 0o600); }
  catch { throw new Error("Pinote settings are locked. Retry after another save finishes; remove a stale pi-note.json.lock only when no save is running."); }
  const temp = join(directory, `.pi-note-${randomUUID()}.tmp`);
  let raw: string;
  try {
    if (readRaw() !== expectedRaw) throw new Error("Pi-note configuration changed while settings were open. Reopen settings before saving.");
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("pi-note.json is a symlink. Edit its target manually rather than replacing the link.");
    const root = expectedRaw === null ? {} : JSON.parse(expectedRaw);
    if (!object(root)) throw new Error("Invalid pi-note configuration; expected an object.");
    raw = `${JSON.stringify(change(root), null, 2)}\n`;
    writeFileSync(temp, raw, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); closeSync(descriptor); rmSync(lock, { force: true }); }
  return raw;
}
export function saveFooterConfig(config: FooterConfig, expectedRaw: string | null, handoffPrompt?: string, newSessionPrompt?: string, taskOfferPolicy?: string, agentGuidance?: string | null, fieldWatchers?: FieldWatcherConfig[], kittyOneTaskPerTab?: boolean) {
  if (taskOfferPolicy !== undefined && !["always", "github-remote", "never"].includes(taskOfferPolicy)) throw new Error("Invalid taskOfferPolicy");
  if (kittyOneTaskPerTab !== undefined) parseKittyOneTaskPerTab({ kittyOneTaskPerTab });
  const checked = parseFooterConfig({ footer: config });
  if (checked.bar == null) delete checked.bar;
  const prompts = {
    ...(handoffPrompt === undefined ? {} : { handoffPrompt: parseHandoffPrompt(handoffPrompt) }),
    ...(newSessionPrompt === undefined ? {} : { newSessionPrompt: parseNewSessionPrompt(newSessionPrompt) }),
    ...(agentGuidance == null ? {} : { agentGuidance: parseAgentGuidance(agentGuidance) }),
  };
  const raw = replaceConfigDocument(expectedRaw, (root) => {
    if (agentGuidance === null) delete root.agentGuidance;
    if (fieldWatchers !== undefined) {
      root.fieldWatchers = parseFieldWatchers({ fieldWatchers });
      delete root.fieldHandler;
    }
    return { ...root, ...prompts, ...(taskOfferPolicy === undefined ? {} : { taskOfferPolicy }),
      ...(kittyOneTaskPerTab === undefined ? {} : { kittyOneTaskPerTab }), footer: checked };
  });
  return { config: checked, raw };
}
/** The desktop's Kitty settings shared with Pi: replaces only these keys. */
export function saveKittySettings(enabled: unknown, completion: unknown, expectedRaw: string | null): string {
  const kittyOneTaskPerTab = parseKittyOneTaskPerTab({ kittyOneTaskPerTab: enabled });
  const onTaskComplete = parseTaskCompletion({ onTaskComplete: completion });
  return replaceConfigDocument(expectedRaw, (root) => ({ ...root, kittyOneTaskPerTab, onTaskComplete }));
}
/** The desktop's Fields settings: replaces only the footer definitions and layout. */
export function saveFooterSettings(footer: unknown, expectedRaw: string | null): string {
  if (footer === undefined) throw new Error("footer must be an object");
  const checked = parseFooterConfig({ footer });
  if (checked.bar == null) delete checked.bar;
  return replaceConfigDocument(expectedRaw, (root) => ({ ...root, footer: checked }));
}
/** The desktop's Watchers settings: replaces the watcher list and the shared keys its scripts declare. */
export function saveFieldWatchers(input: unknown, expectedRaw: string | null): string {
  const { entries, shared } = watcherEntries(input);
  return replaceConfigDocument(expectedRaw, (root) => {
    delete root.fieldHandler;
    for (const [key, value] of Object.entries(shared)) if (Array.isArray(value) && !value.length) delete root[key]; else root[key] = value;
    return { ...root, fieldWatchers: entries };
  });
}

export function effectiveFooterFields(config: FooterConfig, notes: Record<string, string> = {}): FooterField[] {
  if (config.fields !== null) return config.fields;
  const seen = new Set(["Bar"]);
  return ["PR", ...(notes.Bar ?? "").split("\n")].flatMap((raw) => {
    const name = raw.normalize("NFC").trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [defaultFooterField(name)];
  });
}

/** Configured definitions plus unsaved presets. PR is presented as PRs without rewriting settings. */
export function footerCatalog(config: FooterConfig, notes: Record<string, string> = {}): FooterField[] {
  const seen = new Set<string>();
  const configured = config.fields === null
    ? effectiveFooterFields(config, notes).filter((entry) => entry.name !== "PR" || Boolean(notes.PR))
    : config.fields;
  const checked = configured.flatMap((entry) => {
    const field = entry.name === "PR"
      ? { ...entry, name: "PRs", label: entry.label === "PR" ? "PRs" : entry.label } : entry;
    if (seen.has(field.name)) return [];
    try {
      const parsed = parseFooterConfig({ footer: { fields: [field] } }).fields!;
      seen.add(field.name);
      return parsed;
    } catch { return []; }
  }).slice(0, 64);
  return [...checked, ...defaultFieldPresets().filter((preset) => !checked.some((field) => field.name === preset.name))];
}

/** Bottom-bar names in display order. An unset bar keeps enabled fields in definition order. */
export function footerBarNames(config: FooterConfig, catalog: FooterField[]): string[] {
  const known = new Set(catalog.map((field) => field.name));
  const source = config.bar ?? catalog.filter((field) => field.enabled !== false).map((field) => field.name);
  const seen = new Set<string>();
  return source.flatMap((raw) => {
    const name = raw === "PR" ? "PRs" : raw;
    if (!known.has(name) || seen.has(name)) return [];
    seen.add(name);
    return [name];
  });
}

/** Fields to render. An explicit bar can include disabled fields and omit enabled ones. */
export function footerDisplayFields(config: FooterConfig, catalog: FooterField[]): FooterField[] {
  const byName = new Map(catalog.map((field) => [field.name, field]));
  return footerBarNames(config, catalog).flatMap((name) => byName.has(name) ? [byName.get(name)!] : []);
}
