import { DynamicBorder, keyText, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { NativeFooter } from './footer.ts';
import { clean, cleanUnbounded, editorText, footerText, literal, type NativeControl, type NativeView } from './protocol.ts';
import { RemoteFailure } from './client.ts';
import { RemoteSession } from './session.ts';
import { pullBeforeExit } from './exit.ts';
import { inlineHeight, remoteMenu, type MenuState } from './menu.ts';

const line = (text: string) => clean(text).replace(/\n/g, ' ');


/** Inline, review-gated disclosure. Enter is NEVER a default approval. */
export async function review(ctx: ExtensionContext, title: string, text: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || ctx.mode !== 'tui') return false;
  // Escaped values can exceed the wire text limit. Every disclosure line must remain reviewable.
  const disclosure = cleanUnbounded(text);
  const reviewed = await ctx.ui.custom<boolean>((tui, theme, keys, done) => {
    let offset = 0, page = 1, max = 0, geometry = '', usable = false;
    let seen = new Set<number>();
    const cancel = () => done(false);
    signal.addEventListener('abort', cancel, { once: true });
    const component: Component & { dispose(): void } = {
      render(width) {
        const height = inlineHeight(tui, width, component);
        const current = `${width}:${tui.terminal.rows}:${height}`;
        if (geometry !== current) seen = new Set();
        geometry = current;
        page = Math.max(1, Math.min(18, height - 5));
        usable = width >= 20 && height >= 6 && tui.terminal.rows >= 14;
        if (!usable) return [truncateToWidth('Enlarge terminal · Esc cancel', width)];
        const lines = disclosure.split('\n').flatMap((s) => wrapTextWithAnsi(s, width));
        max = Math.max(0, lines.length - page); offset = Math.min(offset, max);
        for (let i = offset; i < Math.min(lines.length, offset + page); i++) seen.add(i);
        const complete = seen.size === lines.length;
        const border = new DynamicBorder((s) => theme.fg('border', s)).render(width);
        return [...border, truncateToWidth(theme.fg('accent', line(title)), width), ...lines.slice(offset, offset + page), '',
          truncateToWidth(complete ? `Review complete · ${keyText('tui.select.confirm')} to choose · ${keyText('tui.select.cancel')} cancel` : `${keyText('tui.select.up')}/${keyText('tui.select.down')} review ALL · ${keyText('tui.select.cancel')} cancel`, width), ...border];
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.columns}:${tui.terminal.rows}:${inlineHeight(tui, tui.terminal.columns, component)}`) {
          if (keys.matches(data, 'tui.select.confirm') && !signal.aborted) {
            // Every wrapped line must have been visible in this geometry.
            const lines = disclosure.split('\n').flatMap((s) => wrapTextWithAnsi(s, tui.terminal.columns));
            if (seen.size === lines.length) done(true);
          } else if (keys.matches(data, 'tui.select.down')) offset = Math.min(max, offset + 1);
          else if (keys.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1);
          else if (matchesKey(data, Key.pageDown)) offset = Math.min(max, offset + page);
          else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
        }
        tui.requestRender();
      },
      invalidate() {},
      dispose() { signal.removeEventListener('abort', cancel); },
    };
    return component;
  });
  return reviewed && !signal.aborted && await ctx.ui.select(line(title), ['Cancel', 'Confirm'], { signal }) === 'Confirm';
}

export class RemoteUI {
  private ctx?: ExtensionContext;
  private repaint = () => {};
  private menuChanged?: () => void;
  private opening = false;
  private closing = false;
  private pi: ExtensionAPI;
  private session: RemoteSession;
  private exitOnComplete: (taskId: number) => boolean;
  constructor(pi: ExtensionAPI, session: RemoteSession, exitOnComplete = (_taskId: number) => false) {
    this.pi = pi; this.session = session; this.exitOnComplete = exitOnComplete;
    session.onChange = () => { this.render(); this.menuChanged?.(); };
  }
  attach(ctx: ExtensionContext): void {
    this.ctx = ctx;
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('pinote-remote', (tui, theme) => {
      this.session.fullscreen = tui.mode === 'fullscreen';
      this.repaint = () => tui.requestRender();
      if (!this.session.fullscreen) return { render: () => [], invalidate() {} };
      return new NativeFooter(() => this.session.view ? [{ uri: 'pinote://ui', view: this.session.view }] : [], theme,
        async ({ view }, item, action) => {
          if (item.openApp) { await this.open(ctx); return true; }
          const control = view.controls.find((c) => c.id === action && c.kind === 'action');
          return control ? this.dispatch(ctx, view, control) : false;
        }, this.repaint);
    }, { placement: 'belowEditor' });
    this.render();
  }
  detach(): void {
    if (this.ctx?.mode === 'tui') {
      this.ctx.ui.setWidget('pinote-remote', undefined);
      this.ctx.ui.setStatus('pinote-remote', undefined);
    }
    this.ctx = undefined; this.repaint = () => {}; this.menuChanged?.();
  }
  private render(): void {
    if (this.ctx?.mode !== 'tui') return;
    this.ctx.ui.setStatus('pinote-remote', this.session.fullscreen ? undefined : this.session.view ? footerText(this.session.view, truncateToWidth) : 'Pinote · unavailable (/pinote to reconnect)');
    this.repaint();
  }
  async dispatch(ctx: ExtensionContext, view: NativeView, control: NativeControl, value?: NativeControl['value']): Promise<boolean> {
    if (ctx.mode !== 'tui') throw new Error('Pinote UI actions require TUI mode');
    if (control.id === 'done' && !ctx.isIdle()) {
      ctx.ui.notify('Wait for the current agent run before completing this task.', 'warning'); return false;
    }
    const current = this.session.current(), signal = this.session.signal;
    try {
      if (typeof value === 'string') editorText(value);
      if (control.confirm && !await review(ctx, line(control.label), `${clean(control.confirm)}${control.kind === 'action' ? '' : `\n${literal(value)}`}`, signal)) return false;
      if (!current()) return false;
      const result = await this.session.action(view, control, value, () => control.id !== 'done' || ctx.isIdle());
      if (!current()) return false;
      if (control.id === 'done' && ctx.isIdle() && typeof view.state.selectedId === 'number' &&
          this.session.view && this.session.view.state.selectedId == null && this.exitOnComplete(view.state.selectedId)) {
        if (await pullBeforeExit(this.pi, ctx, signal, current)) {
          this.closing = true;
          ctx.shutdown();
        }
        return true;
      }
      if (result.preview) this.pi.appendEntry('pinote-remote-preview', { title: line(view.title), text: clean(result.preview) });
      if (result.draft && await review(ctx, 'Insert server draft?', result.draft, signal) && current()) {
        if (ctx.ui.getEditorText().length) ctx.ui.notify('Draft not inserted: clear the editor first.', 'warning');
        else ctx.ui.setEditorText(editorText(result.draft));
      }
      return true;
    } catch (error) {
      if (current()) {
        ctx.ui.notify(error instanceof RemoteFailure ? error.message : 'Pinote action failed. It may have committed; refresh before retrying.', 'warning');
        await this.session.refresh(true).catch(() => {});
      }
      return false;
    }
  }
  async open(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== 'tui') { ctx.ui.notify('Pinote UI actions require TUI mode', 'warning'); return; }
    if (this.opening) return;
    this.opening = true;
    const current = this.session.current(), signal = this.session.signal;
    const menus = new Map<string, MenuState>();
    try {
      await this.session.refresh(true);
      while (current() && !signal.aborted && !this.closing) {
        const view = this.session.view;
        if (!view) return;
        const screen = String(view.state.screen ?? 'tasks');
        const state = menus.get(screen) ?? { search: '' };
        menus.set(screen, state);
        const choice = await remoteMenu(ctx, view, state, signal, (changed) => {
          this.menuChanged = changed;
          return () => { if (this.menuChanged === changed) this.menuChanged = undefined; };
        });
        if (!current()) return;
        if (!choice) {
          const back = view.state.screen === 'field' ? 'screen:settings' : view.state.screen === 'settings' ? 'screen:tasks' : undefined;
          const control = view.controls.find((item) => item.id === back);
          if (control) { await this.dispatch(ctx, view, control); continue; }
          return;
        }
        if (choice.id === '__changed') continue;
        if (choice.id === '__refresh') { await this.session.refresh(true); continue; }
        const control = view.controls.find((c) => c.id === choice.id);
        if (!control) continue;
        let value = control.value;
        if (control.kind === 'toggle') value = choice.value === 'true';
        else if (control.kind === 'select') {
          const options = control.options ?? [];
          if (options.length < 5) value = options[Number(choice.value?.split('.')[0]) - 1]?.value;
          else {
            const labels = options.map((o, i) => `${i + 1}. ${line(o.label)}`);
            const picked = await ctx.ui.select(line(control.label), labels, { signal });
            if (!picked) continue;
            value = options[labels.indexOf(picked)].value;
          }
        } else if (control.kind === 'text' || control.kind === 'number') {
          const entered = await jsonInput(ctx, line(control.label), JSON.stringify(value ?? (control.kind === 'text' ? '' : 0)), signal);
          if (entered === undefined) continue;
          try { value = JSON.parse(entered); }
          catch { ctx.ui.notify('Enter a JSON value; quote strings.', 'warning'); continue; }
          if (control.kind === 'text' ? typeof value !== 'string' : typeof value !== 'number' || !Number.isFinite(value)) {
            ctx.ui.notify('Value does not match the field type.', 'warning'); continue;
          }
        }
        if (current() && await this.dispatch(ctx, view, control, value) && control.id.startsWith('select:')) return;
      }
    } catch (error) { if (current()) ctx.ui.notify(error instanceof RemoteFailure ? error.message : 'Pinote unavailable', 'error'); }
    finally { this.opening = false; }
  }
}

export function registerPreview(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ title: string; text: string }>('pinote-remote-preview', (entry, _options, theme) =>
    new Text(`${theme.fg('accent', line(entry.data?.title ?? 'Pinote preview'))}\n\n${clean(entry.data?.text ?? '')}`, 0, 0));
}

/** JSON input preserves exact whitespace and does not confuse a placeholder with an initial value. */
async function jsonInput(ctx: ExtensionContext, title: string, value: string, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const input = new Input(); input.setValue(value.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    const cancel = () => done(undefined);
    input.onSubmit = (text) => { if (!signal.aborted) done(text); };
    signal.addEventListener('abort', cancel, { once: true });
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width) {
        const border = new DynamicBorder((s) => theme.fg('border', s)).render(width);
        return [...border, truncateToWidth(theme.fg('accent', title), width), ...input.render(width),
          truncateToWidth('JSON value · Enter submit · Esc cancel', width), ...border];
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) cancel();
        else input.handleInput(data);
        tui.requestRender();
      },
      invalidate() { input.invalidate(); },
      dispose() { signal.removeEventListener('abort', cancel); },
    };
  });
}
