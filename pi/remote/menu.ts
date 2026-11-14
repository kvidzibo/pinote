import { DynamicBorder, getSelectListTheme, keyText, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Container, type TUI } from '@earendil-works/pi-tui';
import { clean, editorText, type NativeView } from './protocol.ts';

export interface MenuState { search: string; selected?: string; input?: Input }
export interface MenuChoice { id: string }
export interface MenuOptions {
  search?: 'none' | 'local' | 'tasks';
  searchLabel?: string;
  tab?: 'settings' | 'tasks';
  onSearch?: (query: string) => Promise<void>;
  notice?: string;
}
const line = (text: string) => clean(text).replace(/\n/g, ' ');
/** Keep the current submenu/editor identifiable when a breadcrumb exceeds the viewport. */
export function heading(title: string, width: number): string {
  const text = line(title);
  return truncateToWidth(visibleWidth(text) > width && text.includes(' / ') ? `… / ${text.split(' / ').slice(-2).join(' / ')}` : text, width);
}

/** Reserve the native dock (including footer/widgets), not just the terminal's last row. */
export function inlineHeight(tui: TUI, width: number, component: Component): number {
  const children = tui.children ?? [];
  const owner = children.find((child) => (child as Partial<Container>).children?.includes(component));
  const reserved = owner ? children.slice(1).filter((child) => child !== owner)
    .reduce((height, child) => height + child.render(width).length, 0) : 0;
  return Math.max(1, Math.min(tui.terminal.rows - 6, tui.terminal.rows - 1 - reserved));
}

/** Native selection and input; only task search goes to the service. */
export function remoteMenu(ctx: ExtensionContext, view: NativeView, state: MenuState, signal: AbortSignal,
  watch: (changed: () => void) => () => void, options: MenuOptions = {}): Promise<MenuChoice | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return ctx.ui.custom<MenuChoice | undefined>((tui, theme, keys, done) => {
    const search = options.search ?? 'local';
    // Keep the native input/caret when a server result replaces the menu component.
    const input = state.input ?? new Input();
    if (!state.input) {
      state.search = clean(state.search.replace(/[\r\n\t]/g, ' '));
      input.handleInput(state.search);
      state.input = input;
    }
    const tasks = search === 'tasks';
    const items = view.controls.map((c) => ({ value: c.id,
      label: `${c.icon ? `${line(c.icon)} ` : ''}${line(c.label)}`,
      description: c.kind === 'action' ? undefined : c.kind === 'text' ? c.multiline ? 'Edit…' : line(String(c.value ?? '')) || '(none)'
        : c.kind === 'toggle' ? c.value ? 'On' : 'Off'
          : c.kind === 'select' ? line(c.options?.find((o) => o.value === c.value)?.label ?? '') : String(c.value ?? ''),
      help: line(c.description ?? ''),
    }));
    let filtered = items, list: SelectList | undefined, layout = '', geometry = '', usable = false, listTop = 0, listRows = 0, capacity = 1, rowHeight = 1;
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, searching = false, error = '';
    const cancel = () => done(undefined);
    const unwatch = watch(() => done({ id: '__changed' }));
    signal.addEventListener('abort', cancel, { once: true });
    const fresh = () => !tasks || state.search === String(view.state.search ?? '');
    const schedule = () => {
      clearTimeout(timer);
      if (fresh() || !options.onSearch || searching || disposed) return;
      timer = setTimeout(() => {
        if (disposed || signal.aborted) return;
        searching = true;
        void options.onSearch!(state.search).catch(() => { error = 'Search unavailable · Ctrl+R refresh'; }).finally(() => {
          searching = false;
          if (!disposed) tui.requestRender();
        });
      }, 250);
    };
    schedule();
    const activate = (preview = false) => {
      if (signal.aborted || !usable || !layout || !fresh() || searching || geometry !== `${tui.terminal.columns}:${tui.terminal.rows}:${inlineHeight(tui, tui.terminal.columns, component)}`) return;
      const item = list?.getSelectedItem();
      if (item && (!preview || item.value.startsWith('select:'))) done({ id: preview ? `__preview:${item.value.slice('select:'.length)}` : item.value });
    };
    const component: Component & { dispose(): void; focused: boolean; capturesViewportInput: boolean } = {
      capturesViewportInput: true,
      get focused() { return input.focused; },
      set focused(value) { input.focused = value; },
      render(width) {
        const height = inlineHeight(tui, width, component);
        geometry = `${width}:${tui.terminal.rows}:${height}`;
        usable = width >= 28 && height >= 10;
        if (!usable) { layout = ''; return [truncateToWidth('Enlarge terminal · Esc back', width)]; }
        const compact = height < 18;
        const border = new DynamicBorder((s) => theme.fg('border', s)).render(width);
        const hints = wrapTextWithAnsi(`${keyText('tui.select.up')}/${keyText('tui.select.down')} move · ${keyText('tui.select.confirm')} ${tasks ? 'open · F1 preview task' : 'open'}${options.tab ? ` · ${keyText('tui.input.tab')} ${options.tab}` : ''} · ${keyText('tui.select.cancel')} back · Ctrl+R refresh`, width);
        const summary = (view.body ?? '').split('\n').flatMap((s) => wrapTextWithAnsi(clean(s), width - 2));
        const summaryLimit = compact ? 1 : 3;
        const header = [...border, theme.fg('accent', heading(view.title, width)),
          ...summary.slice(0, summaryLimit).map((s, i) => theme.fg('muted', i === summaryLimit - 1 && summary.length > summaryLimit ? `${s}…` : s)),
          ...(options.notice ? [truncateToWidth(theme.fg('success', line(options.notice)), width)] : []),
          ...(search !== 'none' ? [theme.fg('muted', options.searchLabel ?? (tasks ? 'Search tasks · title, description, tag or #ID' : 'Type to filter')), ...input.render(width)] : []), ''];
        const detailRows = compact ? 1 : 2;
        rowHeight = tasks && !compact ? 2 : 1;
        capacity = Math.min(10, Math.floor((height - header.length - detailRows - hints.length - border.length - 2) / rowHeight));
        if (capacity < 1) { usable = false; layout = ''; return [truncateToWidth('Enlarge terminal · Esc back', width)]; }
        filtered = search === 'local' ? items.filter((item) => state.search.toLowerCase().split(/\s+/).every((term) => `${item.label} ${item.description ?? ''} ${item.help}`.toLowerCase().includes(term))) : items;
        const signature = `${width}:${capacity}:${state.search}`;
        if (layout !== signature) {
          layout = signature;
          list = new SelectList(filtered, capacity, {
            ...getSelectListTheme(), noMatch: () => theme.fg('muted', tasks ? state.search ? '  No tasks match this search.' : '  No active tasks.' : '  No matching items.'),
          }, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: Math.min(40, Math.floor(width * 0.6)) });
          const selected = filtered.some((item) => item.value === state.selected) ? state.selected
            : tasks && state.search.trim() ? filtered.find((item) => item.value.startsWith('select:'))?.value : undefined;
          list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
          list.onSelectionChange = (item) => { state.selected = item.value; };
          list.onSelect = () => activate(); list.onCancel = cancel;
          if (fresh() && list.getSelectedItem()) state.selected = list.getSelectedItem()!.value;
        }
        const selectedIndex = filtered.findIndex((item) => item.value === list?.getSelectedItem()?.value);
        const selected = filtered[selectedIndex];
        const help = selected && width <= 40 && selected.description && selected.description !== 'Edit…'
          ? `Current: ${selected.description}. ${selected.help}` : selected?.help ?? '';
        const description = wrapTextWithAnsi(error || (!fresh() || searching ? 'Searching… Selection is disabled until results arrive.' : help), width - 4).slice(0, detailRows);
        while (description.length < detailRows) description.push('');
        const nativeRows = list!.render(width);
        const start = Math.max(0, Math.min(selectedIndex - Math.floor(capacity / 2), filtered.length - capacity));
        listRows = Math.min(capacity, filtered.length); listTop = header.length;
        const rows = nativeRows.flatMap((row, i) => rowHeight === 2 && i < listRows
          ? [row, theme.fg('muted', truncateToWidth(`  ${filtered[start + i].help}`, width))] : [row]);
        return [...header, ...rows, '', ...description.map((s) => theme.fg('muted', `  ${s}`)), ...hints.map((s) => theme.fg('dim', s)), ...border]
          .map((s) => truncateToWidth(s, width));
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.columns}:${tui.terminal.rows}:${inlineHeight(tui, tui.terminal.columns, component)}`) {
          if (options.tab && keys.matches(data, 'tui.input.tab')) done({ id: `__${options.tab}` });
          else if (matchesKey(data, Key.ctrl('r'))) done({ id: '__refresh' });
          else if (tasks && matchesKey(data, Key.f1)) activate(true);
          else if (keys.matches(data, 'tui.select.confirm')) activate();
          else if (keys.matches(data, 'tui.select.pageUp') || keys.matches(data, 'tui.select.pageDown')) {
            const index = filtered.findIndex((item) => item.value === list?.getSelectedItem()?.value);
            list?.setSelectedIndex(index + (keys.matches(data, 'tui.select.pageUp') ? -capacity : capacity));
            state.selected = list?.getSelectedItem()?.value;
          } else if (keys.matches(data, 'tui.select.up') || keys.matches(data, 'tui.select.down')) { if (layout) list?.handleInput(data); }
          else if (search !== 'none') {
            input.handleInput(data);
            const value = input.getValue().replace(/[\r\n\t]/g, ' ');
            try { editorText(value); }
            catch { input.setValue(state.search); error = 'Unsupported terminal controls in search.'; tui.requestRender(); return; }
            if (value !== input.getValue()) input.setValue(value);
            if (state.search !== value) {
              if (tasks && value.length > 256) input.setValue(state.search);
              else { state.search = value; state.selected = undefined; layout = ''; error = ''; schedule(); }
            }
          }
        }
        tui.requestRender();
      },
      handleMouse(event) {
        if (!usable || !layout || !fresh() || searching || geometry !== `${tui.terminal.columns}:${tui.terminal.rows}:${inlineHeight(tui, tui.terminal.columns, component)}` || event.y < listTop || event.y >= listTop + listRows * rowHeight) return;
        return list?.handleMouse({ ...event, y: Math.floor((event.y - listTop) / rowHeight) });
      },
      invalidate() { layout = ''; input.invalidate(); list?.invalidate(); },
      dispose() { disposed = true; clearTimeout(timer); unwatch(); signal.removeEventListener('abort', cancel); },
    };
    return component;
  });
}
