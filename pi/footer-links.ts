import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

export const footerStatusKey = "pinote-links";
export const legacyFooterStatusKey = "pinote-pr";
const maxCustomChips = 4;
const maxLabelWidth = 24;
const maxChipWidth = 60;
const maxUrlLength = 2048;
const blockedProtocols = new Set(["javascript:", "data:", "vbscript:"]);
// Code and strong markers only. Single underscores are identifiers, not emphasis.
const markdown = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|!?\[([^\]\n]*)\]\(([^)\s]+)\)|<([a-z][a-z0-9+.-]*:[^>\s]+)>|([a-z][a-z0-9+.-]*:\/\/[^\s<>\]]+)/giu;

export type FooterSegment = { text: string; url?: string };
export type FooterChip = { segments: FooterSegment[] };

function plain(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  return stripVTControlCharacters(truncateToWidth(plain(value), width));
}

// Any scheme except scriptable or credentialed targets. Reject terminal escapes and oversized serialization.
function linkTarget(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.length > maxUrlLength || /[\s\u0000-\u001f\u007f\\<>"`]/u.test(candidate)) return;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return;
  }
  if (blockedProtocols.has(parsed.protocol) || parsed.username || parsed.password || !parsed.protocol) return;
  if (parsed.href.length > maxUrlLength || /[\u0000-\u001f\u007f\\<>"`]/u.test(parsed.href)) return;
  return parsed.href;
}

function pushText(segments: FooterSegment[], text: string) {
  if (!text) return;
  const last = segments.at(-1);
  if (last && !last.url) last.text += text;
  else segments.push({ text });
}

export function renderMarkdown(value: string | undefined): FooterSegment[] {
  const source = plain(value ?? "");
  if (!source) return [];
  const segments: FooterSegment[] = [];
  let cursor = 0;
  for (const match of source.matchAll(markdown)) {
    pushText(segments, source.slice(cursor, match.index));
    const inline = match[1] ?? match[2] ?? match[3];
    if (inline !== undefined) pushText(segments, plain(inline));
    else if (match[5] !== undefined) {
      const text = plain(match[4] || match[5]);
      const url = linkTarget(match[5]);
      if (text) segments.push(url ? { text, url } : { text });
    } else {
      const raw = (match[6] ?? match[7] ?? "").replace(/[.,;:!?)]+$/u, "");
      const url = linkTarget(raw);
      const text = plain(raw);
      if (text) segments.push(url ? { text, url } : { text });
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  pushText(segments, source.slice(cursor));
  return segments.filter((segment) => segment.text);
}

function truncateSegments(segments: readonly FooterSegment[], width: number): FooterSegment[] {
  const kept: FooterSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    const room = width - used;
    const text = visibleWidth(segment.text) <= room ? segment.text : clip(segment.text, room);
    if (!text) break;
    kept.push(segment.url ? { text, url: segment.url } : { text });
    used += visibleWidth(text);
  }
  return kept;
}

export function customFooterChips(notes: Record<string, string> | undefined): FooterChip[] {
  if (!notes) return [];
  const chips: FooterChip[] = [];
  const seen = new Set(["PR", "Bar"]);
  for (const raw of (notes.Bar ?? "").split("\n")) {
    if (chips.length >= maxCustomChips) break;
    const name = raw.normalize("NFC").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const label = clip(name, maxLabelWidth);
    const body = renderMarkdown(notes[name]);
    if (!label || !body.length) continue;
    chips.push({ segments: truncateSegments([{ text: `${label}: ` }, ...body], maxChipWidth) });
  }
  return chips;
}

export function footerChips(
  task: { state: string; agent_notes: Record<string, string> } | null,
  pr: { url: string; number: string } | undefined,
): FooterChip[] {
  if (!task || !["active", "in_progress"].includes(task.state)) return [];
  return [
    ...(pr ? [{ segments: [{ text: `PR #${pr.number}`, url: pr.url }] }] : []),
    ...customFooterChips(task.agent_notes),
  ];
}

export function renderFooterLinks(
  chips: readonly FooterChip[],
  colorLink: (text: string) => string,
): string | undefined {
  const rendered = chips.flatMap((chip) => {
    const text = chip.segments.map((segment) => segment.url
      ? colorLink(`\x1b]8;;${segment.url}\x1b\\${segment.text}\x1b]8;;\x1b\\`)
      : segment.text).join("");
    return text.trim() ? [text] : [];
  });
  return rendered.length ? rendered.join(" · ") : undefined;
}
