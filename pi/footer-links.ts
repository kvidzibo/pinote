import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

export const footerStatusKey = "pinote-links";
export const legacyFooterStatusKey = "pinote-pr";
const maxCustomChips = 4;
const maxLabelWidth = 24;
const maxChipWidth = 60;
const maxUrlLength = 2048;
const blockedProtocols = new Set(["javascript:", "data:", "vbscript:"]);
const control = /[\u0000-\u001f\u007f-\u009f]/u;

export type FooterSegment = { text: string; url?: string };
export type FooterChip = { segments: FooterSegment[] };

function plain(value: string): string {
  // C1 introducers such as U+009D survive stripVTControlCharacters and can start OSC.
  return stripVTControlCharacters(value).replace(new RegExp(control, "gu"), "").replace(/\s+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  return stripVTControlCharacters(truncateToWidth(plain(value), width));
}

function ownText(notes: Record<string, string>, name: string): string | undefined {
  if (!Object.hasOwn(notes, name)) return;
  const value = notes[name];
  return typeof value === "string" ? value : undefined;
}

// Any scheme except scriptable or credentialed targets. Reject terminal escapes and oversized serialization.
function linkTarget(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.length > maxUrlLength || /[\s\\<>"`]/u.test(candidate) || control.test(candidate)) return;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return;
  }
  if (blockedProtocols.has(parsed.protocol) || parsed.username || parsed.password || !parsed.protocol) return;
  if (parsed.href.length > maxUrlLength || /[\\<>"`]/u.test(parsed.href) || control.test(parsed.href)) return;
  return parsed.href;
}

function pushText(segments: FooterSegment[], text: string) {
  const cleaned = text.replace(/\*\*|__/gu, "");
  if (!cleaned) return;
  const last = segments.at(-1);
  if (last && !last.url) last.text += cleaned;
  else segments.push({ text: cleaned });
}

function readCode(source: string, index: number): { text: string; end: number } | undefined {
  if (source[index] !== "`") return;
  const end = source.indexOf("`", index + 1);
  if (end < 0) return;
  return { text: source.slice(index + 1, end), end: end + 1 };
}

function readDestination(source: string, start: number): { dest: string; end: number } | undefined {
  if (source[start] === "<") {
    const close = source.indexOf(">", start + 1);
    if (close < 0) return;
    return { dest: source.slice(start + 1, close), end: close + 1 };
  }
  let depth = 0;
  let end = start;
  for (; end < source.length; end++) {
    const char = source[end];
    if (/\s/u.test(char)) break;
    if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (end === start || depth !== 0) return;
  return { dest: source.slice(start, end), end };
}

function readLink(source: string, index: number): { text: string; dest: string; end: number } | undefined {
  let start = index;
  if (source[start] === "!") start++;
  if (source[start] !== "[") return;
  const labelEnd = source.indexOf("]", start + 1);
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return;
  const dest = readDestination(source, labelEnd + 2);
  if (!dest || source[dest.end] !== ")") return;
  return { text: source.slice(start + 1, labelEnd), dest: dest.dest, end: dest.end + 1 };
}

function readAuto(source: string, index: number): { text: string; dest: string; end: number } | undefined {
  if (source[index] !== "<") return;
  const close = source.indexOf(">", index + 1);
  if (close < 0) return;
  const dest = source.slice(index + 1, close);
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(dest)) return;
  return { text: dest, dest, end: close + 1 };
}

function readBare(source: string, index: number): { text: string; dest: string; end: number } | undefined {
  if (index > 0 && /[A-Za-z0-9]/u.test(source[index - 1])) return;
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^\s<>\]]+/iu.exec(source.slice(index));
  if (!match) return;
  const raw = match[0].replace(/[.,;:!?)]+$/u, "");
  if (!raw) return;
  return { text: raw, dest: raw, end: index + raw.length };
}

function emitLink(segments: FooterSegment[], label: string, dest: string) {
  const text = plain(label).replace(/\*\*|__/gu, "") || plain(dest);
  if (!text) return;
  const url = linkTarget(dest);
  segments.push(url ? { text, url } : { text });
}

export function renderMarkdown(value: string | undefined): FooterSegment[] {
  const source = plain(value ?? "");
  if (!source) return [];
  const segments: FooterSegment[] = [];
  let text = "";
  for (let index = 0; index < source.length;) {
    const code = readCode(source, index);
    const link = code ? undefined : readLink(source, index);
    const auto = code || link ? undefined : readAuto(source, index);
    const bare = code || link || auto ? undefined : readBare(source, index);
    const token = link ?? auto ?? bare;
    if (code) {
      pushText(segments, text);
      text = "";
      pushText(segments, code.text);
      index = code.end;
    } else if (token) {
      pushText(segments, text);
      text = "";
      emitLink(segments, token.text, token.dest);
      index = token.end;
    } else {
      text += source[index];
      index++;
    }
  }
  pushText(segments, text);
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
    const body = renderMarkdown(ownText(notes, name));
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
