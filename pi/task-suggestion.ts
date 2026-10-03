import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const pin = readFileSync(new URL("./icons/note.txt", import.meta.url), "utf8").trim();
const check = readFileSync(new URL("./icons/check.txt", import.meta.url), "utf8").trim();
const cross = readFileSync(new URL("./icons/cross.txt", import.meta.url), "utf8").trim();
const add = readFileSync(new URL("./icons/add.txt", import.meta.url), "utf8").trim();
// Pi's default footer collapses ASCII spaces; NBSP preserves the control cells.
const gap = "\u00a0";
const link = (label: string, url?: string) => url ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;
type Task = { text: string; tag?: string | null };
type Colors = Pick<Theme, "fg" | "bold">;

function renderTask(task: Task, width: number, theme: Colors, prefix: string, previewUrl?: string): string {
  // All controls or none: never let a narrow budget reveal only one pending choice.
  if (visibleWidth(prefix) > width) return truncateToWidth(theme.bold(pin), width, "");
  const remaining = width - visibleWidth(prefix) - 3; // separator: " · "
  if (remaining < 4) return prefix.trimEnd();
  const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  const tag = `[${clean(task.tag ?? "Untagged")}]`;
  const title = clean(task.text.split("\n", 1)[0]);
  const tagWidth = visibleWidth(tag) + 1;
  const label = remaining >= tagWidth + Math.min(12, visibleWidth(title))
    ? `${theme.fg("muted", tag)} ${theme.fg("text", truncateToWidth(title, remaining - tagWidth, "..."))}`
    : theme.fg("text", truncateToWidth(title, remaining, "..."));
  return `${prefix}${theme.fg("muted", " · ")}${link(label, previewUrl)}`;
}

export function renderSuggestion(task: Task, width: number, theme: Colors, urls: { yes?: string; no?: string }): string {
  return renderTask(task, width, theme,
    `${theme.bold(pin)} ${theme.fg("muted", link(theme.bold(cross), urls.no))}${gap.repeat(2)}${theme.fg("accent", link(theme.bold(add), urls.yes))}`);
}

export function renderSelectedTask(task: Task, width: number, theme: Colors, urls: { preview?: string; done?: string }): string {
  // Done stays in the former '✕' cell, never the Add cell.
  return renderTask(task, width, theme,
    `${theme.bold(pin)} ${theme.fg("success", link(theme.bold(check), urls.done))}`,
    urls.preview);
}
