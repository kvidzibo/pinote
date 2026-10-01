import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { customFooterLinks, footerChips, httpsTarget, renderFooterLinks } from "../footer-links.ts";

test("footer keeps a structured PR chip and up to four named https links", () => {
  assert.equal(httpsTarget("see https://example.com"), undefined);
  assert.equal(httpsTarget("https://user:pass@example.com/dash"), undefined);
  assert.equal(httpsTarget("https://example.com/\x1b]8;;http://evil"), undefined);
  assert.equal(httpsTarget("http://example.com"), undefined);
  assert.equal(httpsTarget("[Metrics](http://example.com)"), undefined);
  assert.equal(httpsTarget(`https://example.com/${"a".repeat(2048)}`), undefined);
  assert.equal(httpsTarget("[Metrics](https://example.com/d/app)"), "https://example.com/d/app");
  assert.equal(httpsTarget("https://example.com/d/app"), "https://example.com/d/app");

  const notes = {
    PR: "https://github.com/org/repo/pull/9",
    Dashboard: "[Metrics](https://example.com/d/app)",
    Next: "Review",
    Logs: "https://evil.example/a https://evil.example/b",
    Secret: "https://user:pass@example.com/x",
    One: "https://example.com/1",
    Two: "https://example.com/2",
    Three: "https://example.com/3",
    Four: "https://example.com/4",
    Bar: "Dashboard\nDashboard\nNext\nMissing\nPR\nBar\nLogs\nSecret\nOne\nTwo\nThree\nFour",
  };
  const links = footerChips({ state: "in_progress", agent_notes: notes }, {
    url: "https://github.com/org/repo/pull/9", number: "9",
  });
  assert.deepEqual(links.map((link) => link.label), ["PR #9", "Dashboard", "One", "Two", "Three"]);
  assert.equal(footerChips({ state: "done", agent_notes: notes }, {
    url: "https://github.com/org/repo/pull/9", number: "9",
  }).length, 0);
  assert.deepEqual(customFooterLinks({ Bar: "Dashboard\nDashboard", Dashboard: "https://example.com/d" }).map((link) => link.url), [
    "https://example.com/d",
  ]);

  const name = "D".repeat(40);
  const wide = customFooterLinks({ Bar: name, [name]: "https://example.com/wide" });
  assert.equal(wide.length, 1);
  assert.ok(visibleWidth(wide[0].label) <= 24);
  assert.match(wide[0].label, /\.\.\.$/u);
  assert.equal(customFooterLinks({ Bar: "A\u001b[31m", "A\u001b[31m": "https://example.com/a" })[0]?.label, "A");

  const rendered = renderFooterLinks(links.slice(0, 2), (text) => `\x1b[34m${text}\x1b[39m`);
  assert.match(rendered!, /\x1b\]8;;https:\/\/github.com\/org\/repo\/pull\/9\x1b\\PR #9/);
  assert.match(rendered!, /Dashboard/);
  assert.match(rendered!, / · /);
  assert.equal(renderFooterLinks([], (text) => text), undefined);
});
