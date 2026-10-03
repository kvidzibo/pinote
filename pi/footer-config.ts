import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FooterField = { label: string; width?: number };
export type FooterConfig = {
  titleWidth: number;
  fieldWidth: number;
  maxFields: number;
  fields: FooterField[] | null;
};
export const defaultFooterConfig: FooterConfig = {
  titleWidth: 60, fieldWidth: 60, maxFields: 4, fields: null,
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const width = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 3 && Number(value) <= 1000;

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
    fields = footer.fields.map((entry): FooterField => {
      const field = typeof entry === "string" ? { label: entry } : entry;
      if (!object(field) || typeof field.label !== "string") throw new Error("each field needs a label");
      const label = field.label.normalize("NFC").trim();
      if (!label || [...label].length > 64 || /[\x00-\x1f\x7f-\x9f]/u.test(label)) throw new Error("invalid field label");
      if (field.width !== undefined && !width(field.width)) throw new Error("field width must be an integer from 3 to 1000");
      return { label, ...(field.width === undefined ? {} : { width: field.width as number }) };
    });
  }
  return {
    titleWidth: footer.titleWidth as number | undefined ?? defaultFooterConfig.titleWidth,
    fieldWidth: footer.fieldWidth as number | undefined ?? defaultFooterConfig.fieldWidth,
    maxFields: footer.maxFields as number | undefined ?? defaultFooterConfig.maxFields,
    fields,
  };
}

export function loadFooterConfig(warn: (message: string) => void): FooterConfig {
  const path = join(getAgentDir(), "pi-note.json");
  try {
    return parseFooterConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Do not echo configuration contents, which may contain private field labels.
      warn(`Cannot load ${path}; using default Pinote footer settings. Check the footer configuration in pi-note's README.`);
    }
    return { ...defaultFooterConfig };
  }
}
