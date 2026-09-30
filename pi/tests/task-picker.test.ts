import assert from "node:assert/strict";
import { test } from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { TaskPicker } from "../task-picker.ts";

test("task picker filters full text, tag, ID and state, preserves identity and cancels", () => {
  let result: number | undefined;
  let finished = false;
  const picker = new TaskPicker([
    { id: 2, text: "Same title 日本語 " + "long text ".repeat(15) + "needle", tag: "Backend", state: "in_progress" },
    { id: 1, text: "Same title 日本語", tag: null, state: "active" },
  ], { fg: (_color: string, text: string) => text } as any,
  (data, action) => getKeybindings().matches(data, action),
  (id) => { result = id; finished = true; }, () => {});
  picker.focused = true;
  assert.equal(picker.focused, true);
  assert.match(picker.render(100).join("\n"), /● In progress \[Backend\]/);
  assert.match(picker.render(100).join("\n"), /○ Active \[Untagged\]/);
  picker.handleInput("backend #2 progress needle 日本語");
  assert.match(picker.render(100).join("\n"), /\(1\/2\)/);
  for (const width of [20, 40, 100]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
  }
  picker.handleInput("\r");
  assert.equal(result, 2);
  finished = false;
  picker.handleInput("missing");
  picker.handleInput("\r");
  assert.equal(finished, false, "Enter with no matches cannot select a stale row");
  picker.handleInput("\x15"); // Ctrl+U clears search.
  assert.match(picker.render(100).join("\n"), /\(2\/2\)/);
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.equal(result, 1);
  picker.handleInput("\x1b");
  assert.equal(result, undefined);
});
