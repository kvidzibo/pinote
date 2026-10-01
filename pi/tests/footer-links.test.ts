import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { customFooterChips, footerChips, renderFooterLinks, renderMarkdown } from "../footer-links.ts";

const color = (text: string) => `\x1b[34m${text}\x1b[39m`;
const shown = (notes: Record<string, string>) =>
  stripVTControlCharacters(renderFooterLinks(customFooterChips(notes), color) ?? "");
const controls = (value: string) => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
});

test("footer shows Markdown bar fields and links any safe scheme", () => {
  assert.equal(renderMarkdown("see https://example.com").at(-1)?.url, "https://example.com/");
  assert.equal(renderMarkdown("[click](javascript:alert(1))").some((part) => part.url), false);
  assert.match(renderMarkdown("[click](javascript:alert(1))").map((part) => part.text).join(""), /click/);
  assert.equal(renderMarkdown("[dash](https://user:pass@example.com)").some((part) => part.url), false);
  const injected = renderMarkdown("https://example.com/\x1b]8;;http://evil");
  assert.ok(injected.every((part) => !controls(`${part.text}${part.url ?? ""}`)));
  assert.equal(renderMarkdown(`[x](https://example.com/${"é".repeat(1000)})`).some((part) => part.url), false);
  assert.equal(renderMarkdown("[Metrics](http://127.0.0.1:3000/d)")[0]?.url, "http://127.0.0.1:3000/d");
  assert.equal(renderMarkdown("[box](file:///tmp/a)")[0]?.url, "file:///tmp/a");
  assert.equal(renderMarkdown("wait `here` **now**").map((part) => part.text).join(""), "wait here now");
  assert.equal(renderMarkdown("[manual](file:///tmp/a(b).md)")[0]?.url, "file:///tmp/a(b).md");
  assert.equal(renderMarkdown("**[manual](http://example.com)**").map((part) => part.text).join(""), "manual");
  assert.equal(renderMarkdown("**[manual](http://example.com)**").some((part) => part.url === "http://example.com/"), true);
  assert.equal(renderMarkdown("**https://example.com/path**").find((part) => part.url)?.url, "https://example.com/path");
  assert.equal(renderMarkdown("Review\ncomments").map((part) => part.text).join(""), "Review comments");
  assert.equal(renderMarkdown("[x](https://example.com/a\tb)").some((part) => part.url), false);
  assert.equal(renderMarkdown("[x](https://example.com/a\t)").some((part) => part.url), false);
  assert.equal(renderMarkdown("[x](https://example.com/a\x1b[31mb)").some((part) => part.url), false);
  assert.equal(renderMarkdown("https://en.wikipedia.org/wiki/Function_(mathematics)")[0]?.url, "https://en.wikipedia.org/wiki/Function_(mathematics)");
  assert.equal(renderMarkdown("\u009d52;c;SGVsbG8=\u009c").map((part) => part.text).join(""), "52;c;SGVsbG8=");
  assert.equal(shown({ Bar: "constructor\ntoString" }), "");

  const notes = {
    PR: "https://github.com/org/repo/pull/9",
    Dashboard: "[Metrics](http://127.0.0.1:3000/d)",
    Next: "Address review comments",
    Logs: "https://example.com/a https://example.com/b",
    Secret: "[hidden](https://user:pass@example.com/x)",
    One: "https://example.com/1",
    Bar: "Dashboard\nDashboard\nNext\nMissing\nPR\nBar\nLogs\nSecret\nOne",
  };
  const rendered = renderFooterLinks(footerChips({ state: "in_progress", agent_notes: notes }, {
    url: "https://github.com/org/repo/pull/9", number: "9",
  }), color)!;
  const text = stripVTControlCharacters(rendered);
  assert.match(text, /^PR #9 · Dashboard: Metrics · Next: Address review comments · Logs:/);
  assert.match(text, /Secret: hidden/);
  assert.match(rendered, /\x1b\]8;;http:\/\/127\.0\.0\.1:3000\/d\x1b\\Metrics/);
  assert.doesNotMatch(rendered, /user:pass|example\.com\/1|Missing/);
  assert.equal(footerChips({ state: "done", agent_notes: notes }, {
    url: "https://github.com/org/repo/pull/9", number: "9",
  }).length, 0);
  assert.equal(shown({ Bar: "Dashboard\nDashboard", Dashboard: "http://127.0.0.1:3000/d" }), "Dashboard: http://127.0.0.1:3000/d");

  const name = "D".repeat(40);
  const wide = shown({ Bar: name, [name]: "https://example.com/wide" });
  assert.ok(visibleWidth(wide) <= 60);
  assert.match(wide, /^D+\.\.\.: /u);
  assert.equal(shown({ Bar: "A\u001b[31m", "A\u001b[31m": "local note" }), "A: local note");
  assert.equal(renderFooterLinks([], color), undefined);
});
