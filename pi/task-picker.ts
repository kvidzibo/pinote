import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

export type TaskSummary = {
  id: number;
  text: string;
  state: string;
  tag: string | null;
};
const singleLine = (value: string) => value.replace(/\s+/gu, " ").trim();
export const taskState = (task: TaskSummary) => task.state === "in_progress" ? "● In progress" : "○ Active";
export const taskTag = (task: TaskSummary) => task.tag ? `[${singleLine(task.tag)}]` : "[Untagged]";

const selectionActions = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
type Matches = (data: string, action: typeof selectionActions[number]) => boolean;

export class TaskPicker {
  private input = new Input({ prompt: "Search: ", placeholder: "task text, #id, tag, or state" });
  private list!: SelectList;
  private count = 0;

  private tasks: TaskSummary[];
  private theme: Theme;
  private matches: Matches;
  private done: (id: number | undefined) => void;
  private requestRender: () => void;

  constructor(tasks: TaskSummary[], theme: Theme, matches: Matches,
    done: (id: number | undefined) => void, requestRender: () => void) {
    this.tasks = tasks;
    this.theme = theme;
    this.matches = matches;
    this.done = done;
    this.requestRender = requestRender;
    this.filter();
  }

  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private filter() {
    const terms = this.input.getValue().toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const tasks = this.tasks.filter((task) => {
      const search = `${task.text} #${task.id} ${taskTag(task)} ${taskState(task)}`.toLocaleLowerCase();
      return terms.every((term) => search.includes(term));
    });
    this.count = tasks.length;
    this.list = new SelectList(tasks.map((task) => ({
      value: String(task.id),
      label: `${taskState(task)} ${taskTag(task)} #${task.id} ${singleLine(task.text)}`,
    })), 8, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    this.list.onSelect = (item) => this.done(Number(item.value));
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string) {
    if (selectionActions.some((action) => this.matches(data, action))) this.list.handleInput(data);
    else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) this.filter();
    }
    this.requestRender();
  }

  render(width: number) {
    return [
      truncateToWidth(this.theme.fg("accent", `Pinote — select a task (${this.count}/${this.tasks.length})`), width),
      ...this.input.render(width),
      ...this.list.render(width),
      truncateToWidth(this.theme.fg("dim", "Type to filter · ↑↓ navigate · Enter select · Esc cancel"), width),
    ];
  }
  invalidate() { this.input.invalidate(); this.list.invalidate(); }
}
