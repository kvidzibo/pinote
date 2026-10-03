import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { defaultFooterField, defaultHandoffPrompt, parseHandoffPrompt, saveFooterConfig, readFooterDocument, type FooterConfig, type PinoteSettings } from "../footer-config.ts";
import { FooterSettings, TaskMenu, withSettingsTab } from "../footer-settings.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const theme = { fg: (_color: string, value: string) => value } as any;
const matches = (data: string, action: string) => getKeybindings().matches(data, action as any);
const createEditor = () => new Editor({ terminal: { rows: 24 }, requestRender() {} } as any, {
  borderColor: (value) => value,
  selectList: { selectedPrefix: (v) => v, selectedText: (v) => v, description: (v) => v, scrollInfo: (v) => v, noMatch: (v) => v },
});

test("global field settings autosave blank labels, PR formatting, links, add, remove and Tab", () => {
  const config: FooterConfig = { titleWidth: 60, fieldWidth: 60, maxFields: 4, fields: [defaultFooterField("PR")] };
  const original = structuredClone(config);
  let result: "tasks" | undefined;
  let saved: PinoteSettings | undefined;
  const ui = new FooterSettings({ footer: config, handoffPrompt: defaultHandoffPrompt }, ["PR", "Next"], theme, matches,
    (value) => { result = value; }, () => {}, createEditor, (value) => { saved = value; });
  const down = (count: number) => { for (let i = 0; i < count; i++) ui.handleInput("\x1b[B"); };
  const enter = () => ui.handleInput("\r");
  down(4); enter(); // PR
  down(1); enter(); ui.handleInput("\x0b"); enter(); // clear prefilled label from the initial cursor
  assert.match(ui.render(100).join("\n"), /Label: \(none\)/);
  down(1); enter(); ui.handleInput("\x0b"); ui.handleInput("#<number>"); enter();
  ui.handleInput("\x1b[A"); ui.handleInput("\x1b[A"); enter(); // Link off
  assert.match(ui.render(100).join("\n"), /Link: off/);
  assert.deepEqual(saved!.footer.fields, [{ name: "PR", label: "", link: false, format: "#<number>" }]);
  assert.equal(result, undefined, "saving does not close settings");
  ui.handleInput("\x1b"); // return, retaining changes
  down(6); enter(); ui.handleInput("Temporary"); enter();
  assert.match(ui.render(100).join("\n"), /Label: Temporary/);
  assert.equal(saved!.footer.fields!.at(-1)!.name, "Temporary", "adding saves immediately");
  down(4); enter(); // remove saves immediately
  assert.equal(saved!.footer.fields!.length, 1);
  down(6); enter(); ui.handleInput("Dashboard"); enter();
  ui.handleInput("\x1b");
  for (const width of [16, 40, 100]) assert.ok(ui.render(width).every((line) => visibleWidth(line) <= width));
  assert.doesNotMatch(ui.render(100).join("\n"), /Save field|Save settings/);
  ui.handleInput("\t"); assert.equal(result, "tasks");
  assert.deepEqual(saved!.footer.fields, [{ name: "PR", label: "", link: false, format: "#<number>" }, defaultFooterField("Dashboard")]);
  assert.deepEqual(config, original, "the supplied configuration is not mutated");
  const cancel = new FooterSettings({ footer: config, handoffPrompt: defaultHandoffPrompt }, [], theme, matches,
    (value) => { result = value; }, () => {}, createEditor, () => assert.fail("navigation must not save"));
  cancel.handleInput("\t"); assert.equal(result, "tasks");
  cancel.handleInput("\x1b"); assert.equal(result, undefined);
  let selected: string | undefined;
  new TaskMenu("Pinote", theme, matches, (value) => { selected = value; }, () => {}).handleInput("\t");
  assert.equal(selected, "Settings");
  let tabbed = false;
  const component = { focused: false, render: () => ["Tasks"], invalidate() {}, handleInput() {} };
  const wrapper = withSettingsTab(component, () => { tabbed = true; }, theme, () => {});
  wrapper.focused = true; assert.equal(component.focused, true);
  wrapper.handleInput("\t"); assert.equal(tabbed, true);
});

test("task prompt edits autosave validated multiline text atomically without touching other settings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-note-prompt-"));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "pi-note.json");
  writeFileSync(path, JSON.stringify({ taskOfferPolicy: "never", other: 9 }));
  const document = readFooterDocument();
  const config = { footer: { ...document.config, fields: [] }, handoffPrompt: defaultHandoffPrompt };
  let result: "tasks" | undefined;
  let savedSettings: PinoteSettings | undefined;
  let expectedRaw = document.raw;
  const save = (settings: PinoteSettings) => {
    expectedRaw = saveFooterConfig(settings.footer, expectedRaw, settings.handoffPrompt).raw;
    savedSettings = settings;
  };
  const ui = new FooterSettings(config, [], theme, matches, (value) => { result = value; }, () => {}, createEditor, save);
  const down = (count: number) => { for (let i = 0; i < count; i++) ui.handleInput("\x1b[B"); };
  const enter = () => ui.handleInput("\r");
  ui.focused = true;
  down(3); enter();
  assert.match(ui.render(80).join("\n"), /Shift\+Enter\/Ctrl\+J newline/);
  ui.handleInput("\x03"); // clear the multiline editor
  enter();
  assert.match(ui.render(80).join("\n"), /nonblank string/);
  assert.equal(readFileSync(path, "utf8"), document.raw, "invalid edits never save");
  ui.handleInput("Review 日本語");
  ui.handleInput("\x1b[13;2u"); // Shift+Enter
  ui.handleInput("Summarize only.");
  ui.handleInput("\n"); // legacy Ctrl+J also matches confirmation, but must insert a newline
  ui.handleInput("Wait for approval.");
  const keybindings = getKeybindings();
  const originalBindings = keybindings.getUserBindings();
  try {
    keybindings.setUserBindings({ ...originalBindings, "tui.input.submit": "ctrl+enter" });
    const beforeSubmit = ui.render(80);
    ui.handleInput("\x1b[13;5u"); // a remapped Editor submit must not clear the draft
    assert.deepEqual(ui.render(80), beforeSubmit);
  } finally { keybindings.setUserBindings(originalBindings); }
  assert.match(ui.render(80).join("\n"), /Task prompt\n/);
  for (const width of [16, 40, 100]) assert.ok(ui.render(width).every((line) => visibleWidth(line) <= width));
  enter();
  assert.match(ui.render(80).join("\n"), /Task prompt: Review 日本語 Summarize only\. Wait for approval\./);
  assert.deepEqual(config.handoffPrompt, defaultHandoffPrompt, "editing never mutates the supplied config");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).handoffPrompt, "Review 日本語\nSummarize only.\nWait for approval.");
  assert.equal(result, undefined, "saving keeps settings open");
  enter(); ui.handleInput("\x03"); ui.handleInput("Discard this"); ui.handleInput("\x1b");
  assert.doesNotMatch(ui.render(80).join("\n"), /Discard this/);
  enter(); ui.handleInput("\x03");
  const pasted = "界".repeat(1100) + "\nKeep this whole paste.";
  ui.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  enter(); // expanded paste contents, not the editor's compact marker
  assert.equal(savedSettings!.handoffPrompt, pasted);
  ui.handleInput("\x1b"); // saved changes survive closing settings
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.handoffPrompt, pasted);
  assert.equal(saved.taskOfferPolicy, "never");
  assert.equal(saved.other, 9);
  assert.throws(() => saveFooterConfig(savedSettings!.footer, document.raw, pasted), /changed while settings were open/);
  for (const value of [null, false, "", "  \n\t", "Bad\x1bprompt"]) assert.throws(() => parseHandoffPrompt(value), /nonblank string/);
  const cancel = new FooterSettings(config, [], theme, matches, (value) => { result = value; }, () => {}, createEditor, save);
  cancel.handleInput("\t"); assert.equal(result, "tasks");
  cancel.handleInput("\x1b"); assert.equal(result, undefined);
});

test("failed autosaves retain input and persisted values until a successful retry", () => {
  const config = { footer: { titleWidth: 60, fieldWidth: 60, maxFields: 4, fields: [defaultFooterField("PR")] }, handoffPrompt: defaultHandoffPrompt };
  let blocked = true;
  let saved: PinoteSettings | undefined;
  const ui = new FooterSettings(config, [], theme, matches, () => {}, () => {}, createEditor, (settings) => {
    if (blocked) throw new Error("Settings are locked.");
    saved = settings;
  });
  ui.handleInput("\r"); ui.handleInput("\x0b"); ui.handleInput("42"); ui.handleInput("\r");
  assert.match(ui.render(80).join("\n"), /Settings are locked/);
  assert.match(ui.render(80).join("\n"), /42/);
  assert.equal(saved, undefined);
  blocked = false;
  ui.handleInput("\r");
  assert.equal(saved!.footer.titleWidth, 42);
  for (let i = 0; i < 4; i++) ui.handleInput("\x1b[B");
  ui.handleInput("\r"); // PR
  blocked = true;
  ui.handleInput("\r"); // toggle fails
  assert.match(ui.render(80).join("\n"), /Link: on/);
  assert.equal(saved!.footer.fields![0].link, true);
  blocked = false;
  ui.handleInput("\r");
  assert.equal(saved!.footer.fields![0].link, false);
});
