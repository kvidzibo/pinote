import assert from "node:assert/strict";
import { test } from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { defaultFooterField, type FooterConfig } from "../footer-config.ts";
import { FooterSettings, TaskMenu, withSettingsTab } from "../footer-settings.ts";

test("global field settings draft supports blank labels, PR formatting, links, add, save and Tab", () => {
  const config: FooterConfig = { titleWidth: 60, fieldWidth: 60, maxFields: 4, fields: [defaultFooterField("PR")] };
  const original = structuredClone(config);
  let result: FooterConfig | "tasks" | undefined;
  const theme = { fg: (_color: string, value: string) => value } as any;
  const matches = (data: string, action: string) => getKeybindings().matches(data, action as any);
  const ui = new FooterSettings(config, ["PR", "Next"], theme, matches, (value) => { result = value; }, () => {});
  const down = (count: number) => { for (let i = 0; i < count; i++) ui.handleInput("\x1b[B"); };
  const enter = () => ui.handleInput("\r");
  down(3); enter(); // PR
  down(1); enter(); ui.handleInput("\x0b"); enter(); // clear prefilled label from the initial cursor
  assert.match(ui.render(100).join("\n"), /Label: \(none\)/);
  down(1); enter(); ui.handleInput("\x0b"); ui.handleInput("#<number>"); enter();
  ui.handleInput("\x1b[A"); ui.handleInput("\x1b[A"); enter(); // Link off
  assert.match(ui.render(100).join("\n"), /Link: off/);
  down(4); enter(); // save field draft
  down(5); enter(); ui.handleInput("Temporary"); enter();
  assert.match(ui.render(100).join("\n"), /Label: Temporary/);
  ui.handleInput("\x1b"); // cancel field
  assert.doesNotMatch(ui.render(100).join("\n"), /Temporary/);
  down(5); enter(); ui.handleInput("Dashboard"); enter(); down(4); enter(); // add field
  for (const width of [16, 40, 100]) assert.ok(ui.render(width).every((line) => visibleWidth(line) <= width));
  down(7); enter(); // persist result
  assert.ok(result && result !== "tasks");
  assert.deepEqual(result.fields, [{ name: "PR", label: "", link: false, format: "#<number>" }, defaultFooterField("Dashboard")]);
  assert.deepEqual(config, original, "the supplied configuration is not mutated");
  result = undefined;
  const cancel = new FooterSettings(config, [], theme, matches, (value) => { result = value; }, () => {});
  cancel.handleInput("\t"); assert.equal(result, "tasks");
  result = "tasks"; cancel.handleInput("\x1b"); assert.equal(result, undefined);
  let selected: string | undefined;
  new TaskMenu("Pinote", theme, matches, (value) => { selected = value; }, () => {}).handleInput("\t");
  assert.equal(selected, "Settings");
  let tabbed = false;
  const component = { focused: false, render: () => ["Tasks"], invalidate() {}, handleInput() {} };
  const wrapper = withSettingsTab(component, () => { tabbed = true; }, theme, () => {});
  wrapper.focused = true; assert.equal(component.focused, true);
  wrapper.handleInput("\t"); assert.equal(tabbed, true);
});
