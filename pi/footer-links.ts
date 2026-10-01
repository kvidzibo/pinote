import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

export const footerStatusKey = "pinote-links";
export const legacyFooterStatusKey = "pinote-pr";
const maxCustomLinks = 4;
const maxLabelWidth = 24;
const maxUrlLength = 2048;
const markdownLink = /^\[[^\r\n\]]*\]\(([^)\s]+)\)$/u;

export type FooterLink = { url: string; label: string };

// One https URL or Markdown link. Reject credentials, other schemes, and terminal escapes.
export function httpsTarget(value: string | undefined): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed)) return;
  const wrapped = markdownLink.exec(trimmed)?.[1];
  const candidate = wrapped ?? (/^https:\/\//u.test(trimmed) ? trimmed : undefined);
  if (!candidate || candidate.length > maxUrlLength || /[\s\u0000-\u001f\u007f\\<>"`]/u.test(candidate)) return;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return;
  if (/[\u0000-\u001f\u007f\\<>"`]/u.test(parsed.href)) return;
  return parsed.href;
}

function chipLabel(label: string): string {
  const plain = stripVTControlCharacters(label).replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim();
  // Drop the truncator's reset codes so they cannot close the footer link color.
  return stripVTControlCharacters(truncateToWidth(plain, maxLabelWidth));
}

export function customFooterLinks(notes: Record<string, string> | undefined): FooterLink[] {
  if (!notes) return [];
  const links: FooterLink[] = [];
  const seen = new Set(["PR", "Bar"]);
  for (const raw of (notes.Bar ?? "").split("\n")) {
    if (links.length >= maxCustomLinks) break;
    const name = raw.normalize("NFC").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const url = httpsTarget(notes[name]);
    if (!url) continue;
    const label = chipLabel(name);
    if (!label) continue;
    links.push({ url, label });
  }
  return links;
}

export function footerChips(
  task: { state: string; agent_notes: Record<string, string> } | null,
  pr: { url: string; number: string } | undefined,
): FooterLink[] {
  if (!task || !["active", "in_progress"].includes(task.state)) return [];
  return [
    ...(pr ? [{ url: pr.url, label: `PR #${pr.number}` }] : []),
    ...customFooterLinks(task.agent_notes),
  ];
}

export function renderFooterLinks(
  links: readonly FooterLink[],
  color: (text: string) => string,
): string | undefined {
  const chips = links.flatMap((link) => {
    const label = chipLabel(link.label);
    return label ? [color(`\x1b]8;;${link.url}\x1b\\${label}\x1b]8;;\x1b\\`)] : [];
  });
  return chips.length ? chips.join(" · ") : undefined;
}
