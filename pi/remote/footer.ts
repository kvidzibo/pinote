// Vendored native footer primitive from mcp-session-gateway; no gateway runtime dependency.
import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { clean, footerText, type NativeView } from './protocol.ts';

type Item = NonNullable<NativeView['footer']>[number];
type Row = { uri: string; view: NativeView };
type Hit = Row & { item: Item; x: number; end: number; y: number };
const line = (text: string) => clean(text).replace(/\n/g, ' ');

/** Fullscreen-only click regions: no action hyperlinks, pointer changes, or keyboard focus. */
export class NativeFooter implements Component {
  private hits: Hit[] = [];
  private hover?: Hit;
  private armed?: string;
  private singleClick?: ReturnType<typeof setTimeout>;
  private pending = 0;
  private queue = Promise.resolve();
  private disposed = false;

  private rows: () => Row[];
  private theme: Theme;
  private invoke: (hit: Row, item: Item, action?: string) => Promise<boolean>;
  private repaint: () => void;
  constructor(rows: () => Row[], theme: Theme,
    invoke: (hit: Row, item: Item, action?: string) => Promise<boolean>, repaint: () => void) {
    this.rows = rows; this.theme = theme; this.invoke = invoke; this.repaint = repaint;
  }

  private doubleKey(hit: Hit): string | undefined {
    const action = hit.item.doubleAction;
    return action ? JSON.stringify([hit.uri, action,
      hit.view.controls.find((control) => control.id === action)?.revision ?? hit.view.revision]) : undefined;
  }

  render(width: number): string[] {
    this.hits = [];
    return this.rows().filter(({ view }) => view.footer?.length).map(({ uri, view }, y) => {
      let rendered = '', x = 0;
      for (const item of view.footer ?? []) {
        if (x >= width) break;
        const text = footerText({ ...view, footer: [item] },
          (value, budget) => truncateToWidth(value, Math.max(0, Math.min(budget, width - x))),
          (value, style) => {
            const colored = style.color ? this.theme.fg(style.color, value) : value;
            return style.italic ? this.theme.italic(colored) : colored;
          });
        const end = x + visibleWidth(text);
        if (end > x && (item.openApp || item.action || item.doubleAction || item.secondaryAction)) {
          this.hits.push({ uri, view, item, x, end, y });
        }
        rendered += text;
        x = end;
      }
      const hovered = this.hits.find((hit) => hit.uri === uri && hit.uri === this.hover?.uri && hit.item === this.hover.item);
      if (hovered || this.pending) {
        const label = (id: string) => line(view.controls.find((control) => control.id === id)?.label ?? id);
        const hint = this.pending ? 'Working…' : hovered!.item.openApp ? `Open ${line(view.title)}`
          : [hovered!.item.action ? `Click: ${label(hovered!.item.action)}` : '',
            hovered!.item.doubleAction ? `Double-click: ${label(hovered!.item.doubleAction)}` : ''].filter(Boolean).join(' · ');
        const remaining = width - x - 3;
        if (remaining >= 12) rendered += this.theme.fg('muted', ` · ${truncateToWidth(hint, remaining)}`);
      }
      return rendered;
    });
  }

  private cancelSingleClick(): void {
    clearTimeout(this.singleClick);
    this.singleClick = undefined;
    this.armed = undefined;
  }

  private dispatch(hit: Hit, action?: string, open = false): void {
    if (!action && !open) return;
    this.pending++;
    this.repaint();
    this.queue = this.queue.then(async () => {
      if (!this.disposed) await this.invoke(hit, hit.item, action);
    }).catch(() => {}).finally(() => {
      this.pending--;
      if (!this.disposed) this.repaint();
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const hit = this.hits.find((item) => item.y === event.y && event.x >= item.x && event.x < item.end);
    if (event.type === 'move') {
      const changed = hit?.item !== this.hover?.item;
      this.hover = hit;
      return changed ? { handled: true, render: true } : undefined;
    }
    if (!hit || event.ctrl || event.alt || event.shift || event.type === 'wheel' || event.type === 'drag') return;
    if (event.type !== 'click') return { handled: true, render: false };
    let action: string | undefined;
    let open = false;
    if (event.button === 'right') {
      this.cancelSingleClick();
      if (this.pending) return { handled: true, render: false };
      action = hit.item.secondaryAction;
    } else if (event.button === 'left') {
      const count = event.clickCount ?? 1;
      if (count === 1 && !this.pending) {
        this.cancelSingleClick();
        this.armed = this.doubleKey(hit);
        action = hit.item.action;
        open = Boolean(hit.item.openApp);
        if (this.armed) {
          // Match Pi TUI's 500ms component double-click window (measured on release).
          this.singleClick = setTimeout(() => {
            this.cancelSingleClick();
            this.dispatch(hit, action, open);
          }, 500);
          return { handled: true, render: false };
        }
      } else if (count === 2 && this.armed && this.armed === this.doubleKey(hit)) {
        this.cancelSingleClick();
        action = hit.item.doubleAction;
      } else {
        this.cancelSingleClick();
      }
    }
    this.dispatch(hit, action, open);
    return { handled: true, render: false };
  }

  invalidate(): void { this.hits = []; this.hover = undefined; }
  dispose(): void { this.disposed = true; this.hits = []; this.cancelSingleClick(); }
}
