import { BorderedLoader, DynamicBorder, getSelectListTheme, keyText, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Editor, Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from '@earendil-works/pi-tui';
import { clean, cleanUnbounded, editorText, type NativeControl, type NativeView } from './protocol.ts';
import { heading, inlineHeight } from './menu.ts';
import { inputValue } from './navigation.ts';

/** One scrollable, geometry-aware document for previews and mandatory review. */
export async function document(ctx: ExtensionContext, title: string, text: string, signal: AbortSignal, mustReview = false): Promise<boolean> {
  if (signal.aborted || ctx.mode !== 'tui') return false;
  const content = cleanUnbounded(text);
  return !!await ctx.ui.custom<boolean>((tui, theme, keys, done) => {
    let offset = 0, page = 1, max = 0, geometry = '', usable = false, lines: string[] = [], complete = false;
    const seen = new Set<number>();
    const cancel = () => done(false);
    signal.addEventListener('abort', cancel, { once: true });
    const component: Component & { dispose(): void; capturesViewportInput: boolean } = {
      capturesViewportInput: true,
      render(width) {
        const height = inlineHeight(tui, width, component);
        const current = `${width}:${tui.terminal.rows}:${height}`;
        if (geometry !== current) seen.clear();
        geometry = current;
        usable = width >= 28 && height >= 8;
        if (!usable) return [truncateToWidth('Enlarge terminal · Esc back', width)];
        const border = new DynamicBorder((s) => theme.fg('border', s)).render(width);
        lines = content.split('\n').flatMap((s) => wrapTextWithAnsi(s, width));
        // Reserve wrapped hints even before the final line becomes reviewable.
        const hint = `${keyText('tui.select.up')}/${keyText('tui.select.down')} scroll · ${keyText('tui.select.pageUp')}/${keyText('tui.select.pageDown')} page · ${keyText('tui.select.cancel')} back`;
        const hints = wrapTextWithAnsi(hint, width);
        page = Math.max(1, Math.min(18, height - border.length * 2 - hints.length - 4));
        max = Math.max(0, lines.length - page); offset = Math.min(offset, max);
        for (let i = offset; i < Math.min(lines.length, offset + page); i++) seen.add(i);
        complete = seen.size === lines.length;
        const status = mustReview ? complete ? `Review complete · ${keyText('tui.select.confirm')} to choose` : `Review ALL lines · ${offset + 1}–${Math.min(lines.length, offset + page)} / ${lines.length}`
          : `Read-only · ${offset + 1}–${Math.min(lines.length, offset + page)} / ${lines.length}`;
        return [...border, theme.fg('accent', heading(title, width)), '',
          ...lines.slice(offset, offset + page), '', truncateToWidth(theme.fg('muted', status), width),
          ...hints.map((s) => theme.fg('dim', s)), ...border].map((s) => truncateToWidth(s, width));
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.columns}:${tui.terminal.rows}:${inlineHeight(tui, tui.terminal.columns, component)}`) {
          if (mustReview && complete && keys.matches(data, 'tui.select.confirm') && !signal.aborted) done(true);
          else if (keys.matches(data, 'tui.select.down')) offset = Math.min(max, offset + 1);
          else if (keys.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1);
          else if (keys.matches(data, 'tui.select.pageDown')) offset = Math.min(max, offset + page);
          else if (keys.matches(data, 'tui.select.pageUp')) offset = Math.max(0, offset - page);
        }
        tui.requestRender();
      },
      handleMouse(event) {
        if (!usable || event.type !== 'wheel' || !event.wheelDelta) return;
        offset = Math.max(0, Math.min(max, offset + (event.wheelDelta > 0 ? 3 : -3)));
        return { handled: true, render: true };
      },
      invalidate() { geometry = ''; },
      dispose() { signal.removeEventListener('abort', cancel); },
    };
    return component;
  });
}

export interface Draft { text: string }
/** Native editors, bounded to the available dock, with exact submitted whitespace. */
export async function editValue(ctx: ExtensionContext, title: string, view: NativeView, control: NativeControl, draft: Draft, signal: AbortSignal): Promise<NativeControl['value'] | undefined> {
  if (signal.aborted) return undefined;
  editorText(draft.text);
  return ctx.ui.custom<NativeControl['value'] | undefined>((tui, theme, keys, done) => {
    let editorRows = 20, usable = false, geometry = '', error = '', inputTop = 0, inputHeight = 0;
    // Editor's public renderer sizes itself to 30% of terminal.rows (minimum five).
    // Give it this component's budget rather than the whole terminal/dock.
    const editorTui = { terminal: { get rows() { return editorRows; }, get columns() { return tui.terminal.columns; } }, requestRender: () => tui.requestRender() } as TUI;
    const widget = control.multiline ? new Editor(editorTui, { borderColor: (s) => theme.fg('border', s), selectList: getSelectListTheme() }) : new Input();
    if (widget instanceof Editor) { widget.disableSubmit = true; widget.setText(draft.text); }
    else widget.setValue(draft.text);
    const initial = widget instanceof Editor ? widget.getExpandedText() : widget.getValue(), original = draft.text;
    const value = () => {
      const text = widget instanceof Editor ? widget.getExpandedText() : widget.getValue();
      return text === initial ? original : text;
    };
    const cancel = () => { draft.text = value(); done(undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    const component: Component & { focused: boolean; dispose(): void; capturesViewportInput: boolean } = {
      capturesViewportInput: true,
      get focused() { return widget.focused; },
      set focused(focused) { widget.focused = focused; },
      render(width) {
        const height = inlineHeight(tui, width, component);
        geometry = `${width}:${tui.terminal.rows}:${height}`;
        const border = new DynamicBorder((s) => theme.fg('border', s)).render(width);
        const hints = wrapTextWithAnsi(`${keyText('tui.input.submit')} review${control.multiline ? ` · ${keyText('tui.input.newLine')} newline` : ''} · ${keyText('tui.select.cancel')} cancel`, width);
        const help = wrapTextWithAnsi(clean(control.description ?? 'Nothing is saved until you review and confirm.'), width).slice(0, 2);
        const header = [...border, theme.fg('accent', heading(title, width)), ...help.map((s) => theme.fg('muted', s)), ''];
        const errors = error ? wrapTextWithAnsi(error, width).slice(0, 2) : [];
        const normalization = original.includes('\t') ? [truncateToWidth('Editing expands tabs to spaces; review the exact change.', width)] : [];
        const budget = height - header.length - errors.length - normalization.length - hints.length - border.length - 1;
        usable = width >= 28 && budget >= (control.multiline ? 7 : 1);
        if (!usable) return [truncateToWidth('Enlarge terminal · Esc back', width)];
        editorRows = Math.floor(Math.max(5, budget - 2) / 0.3);
        const rows = widget.render(width);
        inputTop = header.length; inputHeight = rows.length;
        return [...header, ...rows, ...errors.map((s) => theme.fg('error', s)), ...normalization.map((s) => theme.fg('muted', s)), '', ...hints.map((s) => theme.fg('dim', s)), ...border]
          .map((s) => truncateToWidth(s, width));
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.columns}:${tui.terminal.rows}:${inlineHeight(tui, tui.terminal.columns, component)}`) {
          if (keys.matches(data, 'tui.input.submit') && !keys.matches(data, 'tui.input.newLine')) {
            draft.text = value();
            try { done(inputValue(control, draft.text, view)); }
            catch (cause) { error = cause instanceof Error ? cause.message : 'Invalid value.'; }
          } else {
            const previous = value();
            widget.handleInput(data);
            try { editorText(value()); draft.text = value(); error = ''; }
            catch {
              if (widget instanceof Editor) widget.setText(previous); else widget.setValue(previous);
              error = 'Unsupported terminal controls in pasted text.';
            }
          }
        }
        tui.requestRender();
      },
      handleMouse(event) {
        if (!usable || event.y < inputTop || event.y >= inputTop + inputHeight) return;
        return widget.handleMouse?.({ ...event, y: event.y - inputTop });
      },
      invalidate() { geometry = ''; widget.invalidate(); },
      dispose() { signal.removeEventListener('abort', cancel); },
    };
    return component;
  });
}

/** Keep operation keys out of the prompt; never offer a mutation retry while it is pending. */
export async function working<T>(ctx: ExtensionContext, title: string, run: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  const result = await ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _keys, done) => {
    const loader = new BorderedLoader(tui, theme, title, { cancellable: false });
    let settled = false;
    const finish = (result: { value?: T; error?: unknown }) => { if (!settled) { settled = true; done(result); } };
    const abort = () => finish({});
    signal.addEventListener('abort', abort, { once: true });
    void run().then((value) => finish({ value }), (error) => finish({ error }));
    return { render: (width) => loader.render(width), invalidate: () => loader.invalidate(),
      dispose() { signal.removeEventListener('abort', abort); loader.dispose(); } };
  });
  if (result?.error) throw result.error;
  return result?.value;
}
