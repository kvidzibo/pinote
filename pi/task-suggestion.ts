import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const check = readFileSync(new URL("./icons/check.txt", import.meta.url), "utf8").trim();
const cross = readFileSync(new URL("./icons/cross.txt", import.meta.url), "utf8").trim();
const link = (label: string, url?: string) => url ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;

export function renderSuggestion(
  task: { text: string; tag?: string }, width: number, theme: Pick<Theme, "fg">,
  urls: { yes?: string; no?: string },
): string {
  const actions = `${theme.fg("success", link(check, urls.yes))}  ${theme.fg("error", link(cross, urls.no))}`;
  const actionsWidth = visibleWidth(actions);
  if (width <= actionsWidth + 2) return truncateToWidth(actions, width, "");
  const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  const label = `[${clean(task.tag ?? "Untagged")}] ${clean(task.text.split("\n", 1)[0])}`;
  return `${theme.fg("muted", truncateToWidth(label, Math.max(0, width - actionsWidth - 2), "..."))}  ${actions}`;
}
