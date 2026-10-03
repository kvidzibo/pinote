import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { footerChips, footerStatusKey, legacyFooterStatusKey, renderFooterLinks } from "./footer-links.ts";
import type { FooterConfig } from "./footer-config.ts";

export type FooterTask = {
  id: number;
  state: string;
  updated_at: string;
  agent_notes: Record<string, string>;
};
type PR = { url: string; number: string };

// Accept one bare URL or Markdown link, never arbitrary hosts or terminal escapes.
export function taskPR(task: FooterTask | null): PR | undefined {
  const field = task?.agent_notes.PR?.trim();
  if (!field) return;
  const url = /^\[[^\r\n]*\]\(([^\s]+)\)$/u.exec(field)?.[1] ?? field;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url);
  if (!match || [".", ".."].includes(match[2]) || !Number.isSafeInteger(Number(match[3]))) return;
  return { url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`, number: match[3] };
}

export function clearTaskFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  ctx.ui.setStatus(legacyFooterStatusKey, undefined);
  ctx.ui.setStatus(footerStatusKey, undefined);
}

export function updateTaskFooter(
  ctx: ExtensionContext, current: FooterTask | null, config?: FooterConfig,
): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  ctx.ui.setStatus(legacyFooterStatusKey, undefined);
  const active = current && ["active", "in_progress"].includes(current.state) ? current : null;
  const pr = active ? taskPR(active) : undefined;
  const value = renderFooterLinks(
    footerChips(active, pr, config), (text) => ctx.ui.theme.fg("mdLink", text),
  );
  ctx.ui.setStatus(footerStatusKey, value);
}
