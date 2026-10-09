import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultFooterConfig, defaultNewSessionPrompt, parseNewSessionPrompt, parseFooterConfig, readFooterDocument, saveFooterConfig } from "../footer-config.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { customFooterChips, renderFooterLinks } from "../footer-links.ts";

test("footer config selects fields and clips linked Unicode across segment boundaries", (t) => {
  assert.deepEqual(parseFooterConfig({}), defaultFooterConfig);
  assert.equal(defaultNewSessionPrompt, "Read the current Pinote task. Summarize your understanding, but don’t start work yet.");
  assert.equal(parseNewSessionPrompt(""), "");
  assert.throws(() => parseNewSessionPrompt("bad\x1bvalue"), /control characters/);
  const config = parseFooterConfig({ footer: {
    titleWidth: 24, fieldWidth: 16, maxFields: 2,
    fields: ["Missing", { label: "Next", width: 12 }, "Link", "Hidden", "PR"],
  } });
  const notes = { Bar: "Hidden", Hidden: "not configured", Next: "界界界界界界",
    Link: "[1234567890](https://example.com) [later](https://example.org)" };
  const chips = customFooterChips(notes, config);
  const rendered = renderFooterLinks(chips, (value) => value)!;
  assert.equal(stripVTControlCharacters(rendered), "Next: 界... · Link: 1234567...");
  assert.ok(chips.every((chip, index) => visibleWidth(chip.segments.map((part) => part.text).join("")) <= [12, 16][index]));
  assert.match(rendered, /\x1b\]8;;https:\/\/example\.com\/\x1b\\1234567\x1b\]8;;\x1b\\\.\.\./);
  assert.doesNotMatch(rendered, /later|Hidden|not configured/);
  // Exact segment boundaries must still indicate that later text was omitted.
  const boundary = parseFooterConfig({ footer: { fieldWidth: 9, fields: ["A"] } });
  assert.equal(stripVTControlCharacters(renderFooterLinks(customFooterChips({ A: "[abc](https://example.com) def" }, boundary), (v) => v)!), "A: abc...");
  assert.equal(stripVTControlCharacters(renderFooterLinks(customFooterChips({ A: "abcdef" }, boundary), (v) => v)!), "A: abcdef");
  assert.deepEqual(customFooterChips(notes, parseFooterConfig({ footer: { fields: [] } })), []);
  assert.deepEqual(customFooterChips(notes, parseFooterConfig({ footer: { maxFields: 0 } })), []);
  assert.equal(customFooterChips(notes, defaultFooterConfig).length, 1);
  for (const footer of [{ titleWidth: 2 }, { fieldWidth: true }, { maxFields: 65 },
    { fields: "Next" }, { fields: [{ label: "Next", width: 1 }] }, { fields: ["Bad\u001b"] },
    { fields: [{ name: "PR", link: "yes" }] }, { fields: [{ name: "PR", format: "<unknown>" }] }]) {
    assert.throws(() => parseFooterConfig({ footer }));
  }
  const pr = { name: "PR", label: "", format: "#<number>", link: true };
  const linkedConfig = parseFooterConfig({ footer: { fields: [pr, "Empty"] } });
  const prNotes = { PR: "[Fix](https://github.com/org/repo/pull/42)", Empty: "  " };
  const linkText = renderFooterLinks(customFooterChips(prNotes, linkedConfig), (v) => v)!;
  assert.equal(stripVTControlCharacters(linkText), "#42");
  assert.match(linkText, /\x1b\]8;;https:\/\/github.com\/org\/repo\/pull\/42/);
  const rawConfig = parseFooterConfig({ footer: { fields: [{ ...pr, link: false }] } });
  assert.equal(renderFooterLinks(customFooterChips(prNotes, rawConfig), (v) => v), "#42");
  assert.deepEqual(customFooterChips({ PR: "bad link" }, linkedConfig), []);
  const directory = mkdtempSync(join(tmpdir(), "pi-note-fields-"));
  const savedDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => { if (savedDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDirectory; rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, "pi-note.json");
  writeFileSync(path, JSON.stringify({ handoffPrompt: "Keep this prompt", taskOfferPolicy: "never", other: 9 }));
  const document = readFooterDocument();
  saveFooterConfig(linkedConfig, document.raw, undefined, "");
  const root = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(root.handoffPrompt, "Keep this prompt");
  assert.equal(root.newSessionPrompt, "");
  assert.equal(root.other, 9);
  assert.equal(root.taskOfferPolicy, "never");
  assert.deepEqual(readFooterDocument().config, linkedConfig);
  assert.throws(() => saveFooterConfig(rawConfig, document.raw), /changed while settings were open/);
  writeFileSync(join(directory, "pi-note.json.lock"), "");
  assert.throws(() => saveFooterConfig(rawConfig, readFooterDocument().raw), /settings are locked/);
  rmSync(join(directory, "pi-note.json.lock"));
});
