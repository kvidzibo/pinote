import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type FooterField = { name: string; label: string; link: boolean; format: string; width?: number };
export type FooterConfig = { titleWidth: number; fieldWidth: number; maxFields: number; fields: FooterField[] | null };
export const defaultFooterConfig: FooterConfig = { titleWidth: 60, fieldWidth: 60, maxFields: 4, fields: null };
export const defaultFooterField = (name: string): FooterField => ({
  name, label: name, link: true, format: name === "PR" ? "#<number>" : "<value>",
});
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
      if (field.link !== undefined && typeof field.link !== "boolean") throw new Error("link must be a boolean");
      if (field.width !== undefined && !width(field.width)) throw new Error("field width must be an integer from 3 to 1000");
      return { name, label, link: field.link as boolean | undefined ?? true, format,
        ...(field.width === undefined ? {} : { width: field.width as number }) };
    });
  }
  return {
    titleWidth: footer.titleWidth as number | undefined ?? defaultFooterConfig.titleWidth,
    fieldWidth: footer.fieldWidth as number | undefined ?? defaultFooterConfig.fieldWidth,
    maxFields: footer.maxFields as number | undefined ?? defaultFooterConfig.maxFields, fields,
  };
}

function readRaw(): string | null {
  try { return readFileSync(join(getAgentDir(), "pi-note.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function readFooterDocument() {
  const raw = readRaw();
  let value: unknown = {};
  if (raw !== null) {
    try { value = JSON.parse(raw); } catch { throw new Error("Invalid JSON in pi-note.json."); }
  }
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
// preserve unrelated keys (including handoffPrompt), and never leave partial JSON behind.
export function saveFooterConfig(config: FooterConfig, expectedRaw: string | null): FooterConfig {
  const checked = parseFooterConfig({ footer: config });
  const directory = getAgentDir();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "pi-note.json");
  const lock = join(directory, "pi-note.json.lock");
  let descriptor: number;
  try { descriptor = openSync(lock, "wx", 0o600); }
  catch { throw new Error("Pinote settings are locked. Retry after another save finishes; remove a stale pi-note.json.lock only when no save is running."); }
  const temp = join(directory, `.pi-note-${randomUUID()}.tmp`);
  try {
    if (readRaw() !== expectedRaw) throw new Error("Pi-note configuration changed while settings were open. Reopen settings before saving.");
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("pi-note.json is a symlink. Edit its target manually rather than replacing the link.");
    const root = expectedRaw === null ? {} : JSON.parse(expectedRaw);
    if (!object(root)) throw new Error("Invalid pi-note configuration; expected an object.");
    writeFileSync(temp, `${JSON.stringify({ ...root, footer: checked }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); closeSync(descriptor); rmSync(lock, { force: true }); }
  return checked;
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
