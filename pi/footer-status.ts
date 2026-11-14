import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { footerChips, footerStatusKey, legacyFooterStatusKey, renderFooterLinks } from "./footer-links.ts";
import type { FooterConfig } from "./footer-config.ts";
import { parsePR } from "./pr-url.ts";

export type FooterTask = {
  id: number;
  state: string;
  updated_at: string;
  agent_notes: Record<string, string>;
};
type PR = { url: string; number: string };

// Accept one bare PR URL or Markdown link for display, not network trust.
export function taskPR(task: FooterTask | null): PR | undefined {
  const field = task?.agent_notes.PR;
  return field ? parsePR(field) : undefined;
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
