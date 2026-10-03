import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const pin = readFileSync(new URL("./icons/note.txt", import.meta.url), "utf8").trim();
const check = readFileSync(new URL("./icons/check.txt", import.meta.url), "utf8").trim();
const cross = readFileSync(new URL("./icons/cross.txt", import.meta.url), "utf8").trim();
const link = (label: string, url?: string) => url ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label;

export function renderSuggestion(
  task: { text: string; tag?: string }, width: number, theme: Pick<Theme, "fg">,
  urls: { yes?: string; no?: string },
): string {
  const cue = `${pin} ${theme.fg("accent", "Suggested:")}`;
  const actions = (compact: boolean) => `${theme.fg("success", link(compact ? check : `${check} Add`, urls.yes))}  ${theme.fg("muted", link(compact ? cross : `${cross} Dismiss`, urls.no))}`;
  let prefix = `${cue} ${actions(false)}`;
  if (visibleWidth(prefix) > width) prefix = `${cue} ${actions(true)}`;
  // Never show unexplained action icons when even the suggestion cue cannot fit.
  if (visibleWidth(prefix) > width) return truncateToWidth(cue, width, "");
  const remaining = width - visibleWidth(prefix) - 3; // separator: " · "
  if (remaining < 4) return prefix;
  const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  const tag = `[${clean(task.tag ?? "Untagged")}]`;
  const title = clean(task.text.split("\n", 1)[0]);
  // Drop the tag before sacrificing the title to a long tag or a small budget.
  const tagWidth = visibleWidth(tag) + 1;
  const label = remaining >= tagWidth + Math.min(12, visibleWidth(title))
    ? `${theme.fg("muted", tag)} ${theme.fg("text", truncateToWidth(title, remaining - tagWidth, "..."))}`
    : theme.fg("text", truncateToWidth(title, remaining, "..."));
  return `${prefix}${theme.fg("muted", " · ")}${label}`;
}
