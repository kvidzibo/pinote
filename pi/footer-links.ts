import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { defaultFooterConfig, defaultFooterField, type FooterConfig, type FooterField } from "./footer-config.ts";

export const footerStatusKey = "pinote-links";
export const legacyFooterStatusKey = "pinote-pr";
const maxLabelWidth = 24;
const maxUrlLength = 2048;
const blockedProtocols = new Set(["javascript:", "data:", "vbscript:"]);
const control = /[\u0000-\u001f\u007f-\u009f]/u;

export type FooterSegment = { text: string; url?: string };
export type FooterChip = { segments: FooterSegment[] };

function display(value: string): string {
  // Keep whitespace so newlines stay word boundaries. Drop other C0/C1 controls;
  // U+009D survives stripVTControlCharacters and can start OSC.
  return stripVTControlCharacters(value)
    .replace(new RegExp(control, "gu"), (char) => /\s/u.test(char) ? " " : "")
    .replace(/\s+/gu, " ");
}

function plain(value: string): string {
  return display(value).trim();
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
  // Do not trim or strip first: that can turn a dirty destination into a different URL.
  if (!value || value.length > maxUrlLength || /[\s\\<>"`]/u.test(value) || control.test(value)) return;
  const candidate = value;
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
  const cleaned = display(text).replace(/\*\*|__/gu, "");
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
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(source.slice(index));
  if (!scheme) return;
  let end = index + scheme[0].length;
  let depth = 0;
  for (; end < source.length; end++) {
    const char = source[end];
    if (/[\s<>\]*]/u.test(char) || control.test(char)) break;
    if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  const raw = source.slice(index, end).replace(/[.,;:!?]+$/u, "").replace(/__$/u, "");
  if (!raw || depth !== 0) return;
  return { text: raw, dest: raw, end: index + raw.length };
}

function emitLink(segments: FooterSegment[], label: string, dest: string) {
  const text = plain(label).replace(/\*\*|__/gu, "") || plain(dest);
  if (!text) return;
  const url = linkTarget(dest);
  segments.push(url ? { text, url } : { text });
}

export function renderMarkdown(value: string | undefined): FooterSegment[] {
  const source = value ?? "";
  if (!plain(source)) return [];
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
  if (segments[0] && !segments[0].url) segments[0].text = segments[0].text.trimStart();
  const last = segments.at(-1);
  if (last && !last.url) last.text = last.text.trimEnd();
  return segments.filter((segment) => segment.text);
}

function truncateSegments(segments: readonly FooterSegment[], width: number): FooterSegment[] {
  if (segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0) <= width) return [...segments];
  const kept: FooterSegment[] = [];
  let room = width - 3;
  for (const segment of segments) {
    if (room <= 0) break;
    const text = stripVTControlCharacters(truncateToWidth(segment.text, room, ""));
    if (text) kept.push(segment.url ? { text, url: segment.url } : { text });
    room -= visibleWidth(text);
    if (text !== segment.text) break;
  }
  // Keep the ellipsis outside hyperlinks, including cuts at segment boundaries.
  kept.push({ text: "..." });
  return kept;
}

function fieldSegments(field: FooterField, value: string | undefined): FooterSegment[] {
  if (!value?.trim()) return [];
  const original = renderMarkdown(value);
  const urls = [...new Set(original.flatMap((part) => part.url ? [part.url] : []))];
  const url = urls.length === 1 ? urls[0] : undefined;
  const number = url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)\/?$/u.exec(url)?.[1]
    || (/^[0-9]+$/u.test(value.trim()) ? value.trim() : undefined);
  if (field.format.includes("<number>") && !number || field.format.includes("<url>") && !url) return [];
  let body: FooterSegment[];
  if (field.format === "<value>") body = original;
  else {
    const shown = plain(field.format.replace(/<(value|number|url)>/gu, (_match, key: string) =>
      ({ value: original.map((part) => part.text).join(""), number: number ?? "", url: url ?? "" })[key as "value" | "number" | "url"]));
    body = shown ? [url ? { text: shown, url } : { text: shown }] : [];
  }
  if (!field.link) body = body.map((part) => ({ text: part.text }));
  if (!body.length) return [];
  const label = clip(field.label, maxLabelWidth);
  return [...(label ? [{ text: `${label}: ` }] : []), ...body];
}

export function customFooterChips(
  notes: Record<string, string> | undefined, config: FooterConfig = defaultFooterConfig,
): FooterChip[] {
  if (!notes) return [];
  const chips: FooterChip[] = [];
  const seen = new Set(config.fields === null ? ["PR", "Bar"] : ["Bar"]);
  const fields: FooterField[] = config.fields ?? (notes.Bar ?? "").split("\n").map(defaultFooterField);
  for (const field of fields) {
    if (chips.length >= config.maxFields) break;
    const name = field.name.normalize("NFC").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const segments = fieldSegments(field, ownText(notes, name));
    if (!segments.length) continue;
    chips.push({ segments: truncateSegments(segments, field.width ?? config.fieldWidth) });
  }
  return chips;
}

export function footerChips(
  task: { state: string; agent_notes: Record<string, string> } | null,
  pr: { url: string; number: string } | undefined,
  config: FooterConfig = defaultFooterConfig,
): FooterChip[] {
  if (!task || !["active", "in_progress"].includes(task.state)) return [];
  return [
    ...(config.fields === null && pr ? [{ segments: [{ text: `PR #${pr.number}`, url: pr.url }] }] : []),
    ...customFooterChips(task.agent_notes, config),
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
