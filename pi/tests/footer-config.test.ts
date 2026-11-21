import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFooterConfig, defaultNewSessionPrompt, parseNewSessionPrompt, parseFooterConfig, readFooterDocument, saveFooterConfig } from "../footer-config.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("footer config validates fields and bar order, and saves without losing unrelated settings", (t) => {
  assert.deepEqual(parseFooterConfig({}), defaultFooterConfig);
  assert.equal(defaultNewSessionPrompt, "Read the current Pinote task. Summarize your understanding, but don’t start work yet.");
  assert.equal(parseNewSessionPrompt(""), "");
  assert.throws(() => parseNewSessionPrompt("bad\x1bvalue"), /control characters/);
  for (const footer of [{ titleWidth: 2 }, { fieldWidth: true }, { maxFields: 65 },
    { fields: "Next" }, { fields: [{ label: "Next", width: 1 }] }, { fields: ["Bad\u001b"] },
    { fields: [{ name: "PR", link: "yes" }] }, { fields: [{ name: "PR", format: "<unknown>" }] },
    { bar: "Next" }, { bar: ["Bar"] }, { bar: ["PR", "PRs"] }, { bar: ["Bad\u001b"] }]) {
    assert.throws(() => parseFooterConfig({ footer }));
  }
  const ordered = parseFooterConfig({ footer: {
    fields: [{ name: "A", enabled: false }, "B", "C"], bar: ["C", "PR"],
  } });
  assert.deepEqual(ordered.bar, ["C", "PRs"]);
  const disabled = { name: "Worktree", enabled: false, instructions: "Save root\nafter choosing it." };
  const configured = parseFooterConfig({ footer: { fields: [disabled] } });
  assert.equal(configured.fields![0].instructions, disabled.instructions);
  for (const entry of [{ enabled: "yes" }, { instructions: "x".repeat(4097) }, { instructions: "bad\x1bvalue" }]) {
    assert.throws(() => parseFooterConfig({ footer: { fields: [{ name: "Worktree", ...entry }] } }));
  }
  const pr = { name: "PR", label: "", format: "#<number>", link: true };
  const linkedConfig = parseFooterConfig({ footer: { fields: [pr, "Empty"] } });
  const rawConfig = parseFooterConfig({ footer: { fields: [{ ...pr, link: false }] } });
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
