import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { defaultFooterField, parseFooterConfig, parseHandoffPrompt, type PinoteSettings, type FooterConfig, type FooterField } from "./footer-config.ts";

type Matches = (data: string, action: string) => boolean;
type Row = { label: string; action: () => void };
const isTab = (data: string) => matchesKey(data, "tab") || matchesKey(data, "shift+tab");
const display = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
const actions = ["Continue", "Done", "Switch task", "Settings"];

export class TaskMenu {
  private index = 0;
  private title: string;
  private theme: Theme;
  private matches: Matches;
  private done: (action: string | undefined) => void;
  private requestRender: () => void;
  constructor(title: string, theme: Theme, matches: Matches,
    done: (action: string | undefined) => void, requestRender: () => void) {
    this.title = title; this.theme = theme; this.matches = matches;
    this.done = done; this.requestRender = requestRender;
  }
  handleInput(data: string) {
    if (isTab(data)) this.done("Settings");
    else if (this.matches(data, "tui.select.up")) this.index = (this.index + actions.length - 1) % actions.length;
    else if (this.matches(data, "tui.select.down")) this.index = (this.index + 1) % actions.length;
    else if (this.matches(data, "tui.select.confirm")) this.done(actions[this.index]);
    else if (this.matches(data, "tui.select.cancel")) this.done(undefined);
    this.requestRender();
  }
  render(width: number) {
    return [this.theme.fg("accent", this.title), this.theme.fg("dim", "Tasks · Settings (Tab)"),
      ...actions.map((action, index) => index === this.index ? this.theme.fg("accent", `> ${action}`) : `  ${action}`),
      this.theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel")].map((line) => truncateToWidth(line, width));
  }
  invalidate() {}
}

export class FooterSettings {
  private draft: FooterConfig;
  private prompt: string;
  private editor?: Editor;
  private createEditor: () => Editor;
  private knownFields: string[];
  private theme: Theme;
  private matches: Matches;
  private done: (result: PinoteSettings | "tasks" | undefined) => void;
  private requestRender: () => void;
  private index = 0;
  private field?: FooterField;
  private input?: { widget: Input; apply: (value: string) => void; heading: string };
  private error = "";
  private hasFocus = false;

  constructor(config: PinoteSettings, knownFields: string[], theme: Theme, matches: Matches,
    done: (result: PinoteSettings | "tasks" | undefined) => void, requestRender: () => void, createEditor: () => Editor) {
    this.draft = structuredClone(config.footer);
    this.prompt = config.handoffPrompt;
    this.createEditor = createEditor;
    this.draft.fields ??= [];
    this.knownFields = [...new Set(knownFields)].filter((name) => name !== "Bar");
    this.theme = theme; this.matches = matches; this.done = done; this.requestRender = requestRender;
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.input) this.input.widget.focused = value;
    if (this.editor) this.editor.focused = value;
  }

  private ask(heading: string, value: string, apply: (value: string) => void) {
    const widget = new Input();
    widget.setValue(value); widget.focused = this.hasFocus;
    this.input = { widget, heading, apply }; this.error = "";
  }
  private validate(field: FooterField): FooterField {
    return parseFooterConfig({ footer: { fields: [field] } }).fields![0];
  }
  private edit(name: string) {
    this.field = structuredClone(this.draft.fields!.find((field) => field.name === name) ?? defaultFooterField(name));
    this.index = 0; this.error = "";
  }
  private rootRows(): Row[] {
    const rows: Row[] = (["titleWidth", "fieldWidth", "maxFields"] as const).map((key) => ({
      label: `${{ titleWidth: "Title width", fieldWidth: "Default field width", maxFields: "Max fields" }[key]}: ${this.draft[key]}`,
      action: () => this.ask(key, String(this.draft[key]), (value) => {
        const candidate = { ...this.draft, [key]: Number(value) };
        if (!value.trim()) throw new Error("Enter a number.");
        this.draft = parseFooterConfig({ footer: candidate });
      }),
    }));
    rows.push({ label: `Task prompt: ${display(this.prompt)}`, action: () => {
      this.editor = this.createEditor();
      this.editor.setText(this.prompt);
      this.editor.focused = this.hasFocus;
    } });
    const configured = this.draft.fields!.map((field) => field.name);
    for (const name of [...configured, ...this.knownFields.filter((name) => !configured.includes(name))]) {
      rows.push({ label: `Field: ${display(name)}${configured.includes(name) ? "" : " (not configured)"}`, action: () => this.edit(name) });
    }
    rows.push({ label: "+ Add field", action: () => this.ask("Field name", "", (value) => {
      const field = this.validate(defaultFooterField(value));
      this.edit(field.name);
    }) }, { label: "Save settings", action: () => this.done({ footer: parseFooterConfig({ footer: this.draft }), handoffPrompt: parseHandoffPrompt(this.prompt) }) },
    { label: "Return to tasks", action: () => this.done("tasks") });
    return rows;
  }
  private fieldRows(): Row[] {
    const field = this.field!;
    const rows: Row[] = [
      { label: `Link: ${field.link ? "on" : "off (plain text)"}`, action: () => { field.link = !field.link; } },
      { label: `Label: ${display(field.label) || "(none)"}`, action: () => this.ask("Label (empty = no prefix)", field.label, (value) => {
        this.field = this.validate({ ...field, label: value });
      }) },
      { label: `Format: ${display(field.format) || "(empty)"}`, action: () => this.ask("Format: <value>, <url>, <number>", field.format, (value) => {
        this.field = this.validate({ ...field, format: value });
      }) },
      { label: `Width: ${field.width ?? `default (${this.draft.fieldWidth})`}`, action: () => this.ask("Width (empty = default)", field.width === undefined ? "" : String(field.width), (value) => {
        const candidate = { ...field };
        if (value.trim()) candidate.width = Number(value); else delete candidate.width;
        this.field = this.validate(candidate);
      }) },
      { label: "Save field", action: () => {
        const candidate = this.validate(field);
        const fields = this.draft.fields!.filter((entry) => entry.name !== candidate.name);
        const index = this.draft.fields!.findIndex((entry) => entry.name === candidate.name);
        fields.splice(index < 0 ? fields.length : index, 0, candidate);
        this.draft = parseFooterConfig({ footer: { ...this.draft, fields } });
        this.field = undefined; this.index = 0;
      } },
    ];
    if (this.draft.fields!.some((entry) => entry.name === field.name)) rows.push({ label: "Remove field", action: () => {
      this.draft.fields = this.draft.fields!.filter((entry) => entry.name !== field.name);
      this.field = undefined; this.index = 0;
    } });
    rows.push({ label: "Cancel field", action: () => { this.field = undefined; this.index = 0; } });
    return rows;
  }
  handleInput(data: string) {
    this.error = "";
    try {
      if (isTab(data)) this.done("tasks");
      else if (this.editor) {
        if (matchesKey(data, "ctrl+c")) this.editor.setText("");
        else if (this.matches(data, "tui.select.cancel")) this.editor = undefined;
        else if (this.matches(data, "tui.input.newLine")) this.editor.handleInput(data);
        else if (this.matches(data, "tui.select.confirm")) {
          this.prompt = parseHandoffPrompt(this.editor.getExpandedText());
          this.editor = undefined;
        } else this.editor.handleInput(data);
      } else if (this.input) {
        if (this.matches(data, "tui.select.cancel")) this.input = undefined;
        else if (this.matches(data, "tui.select.confirm")) {
          const input = this.input;
          input.apply(input.widget.getValue());
          this.input = undefined;
        } else this.input.widget.handleInput(data);
      } else if (this.matches(data, "tui.select.cancel")) {
        if (this.field) { this.field = undefined; this.index = 0; } else this.done(undefined);
      } else {
        const rows = this.field ? this.fieldRows() : this.rootRows();
        this.index = Math.min(this.index, rows.length - 1);
        if (this.matches(data, "tui.select.up")) this.index = (this.index + rows.length - 1) % rows.length;
        else if (this.matches(data, "tui.select.down")) this.index = (this.index + 1) % rows.length;
        else if (this.matches(data, "tui.select.confirm")) rows[this.index].action();
      }
    } catch (error) { this.error = error instanceof Error ? error.message : "Invalid settings."; }
    this.requestRender();
  }
  render(width: number) {
    const lines = [this.theme.fg("accent", "Pinote — Global Settings"), this.theme.fg("dim", "Tasks (Tab) · Settings · Fields")];
    if (this.editor) {
      lines.push(this.theme.fg("accent", "Task prompt"), ...this.editor.render(width),
        this.theme.fg("dim", "Enter apply · Shift+Enter/Ctrl+J newline · Ctrl+C clear · Esc cancel"));
    } else if (this.input) {
      lines.push(this.theme.fg("accent", this.input.heading), ...this.input.widget.render(width),
        this.theme.fg("dim", "Enter apply to draft · Esc cancel"));
    } else {
      if (this.field) lines.push(this.theme.fg("accent", `Field: ${display(this.field.name)}`));
      const rows = this.field ? this.fieldRows() : this.rootRows();
      this.index = Math.min(this.index, rows.length - 1);
      const start = Math.max(0, Math.min(this.index - 3, rows.length - 8));
      lines.push(...rows.slice(start, start + 8).map((row, offset) => offset + start === this.index
        ? this.theme.fg("accent", `> ${row.label}`) : `  ${row.label}`));
      if (rows.length > 8) lines.push(this.theme.fg("dim", `${this.index + 1}/${rows.length}`));
      lines.push(this.theme.fg("dim", "↑↓ navigate · Enter edit · Esc cancel"));
    }
    if (this.error) lines.push(this.theme.fg("error", this.error));
    lines.push(this.theme.fg("dim", "Tab: tasks, discard draft · Save settings: persist globally"));
    return lines.map((line) => truncateToWidth(line, width));
  }
  invalidate() { this.input?.widget.invalidate(); this.editor?.invalidate(); }
}

export function withSettingsTab<T extends { handleInput?(data: string): void; render(width: number): string[]; invalidate(): void; focused?: boolean }>(
  component: T, onSettings: () => void, theme: Theme, requestRender: () => void,
) {
  return {
    get focused() { return component.focused ?? false; },
    set focused(value: boolean) { component.focused = value; },
    handleInput(data: string) { if (isTab(data)) onSettings(); else component.handleInput?.(data); requestRender(); },
    render(width: number) { return [truncateToWidth(theme.fg("accent", "Tasks · Settings (Tab)"), width), ...component.render(width)]; },
    invalidate() { component.invalidate(); },
  };
}
