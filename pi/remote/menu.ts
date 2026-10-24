import { DynamicBorder, getSettingsListTheme, keyText, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Container, type TUI } from '@earendil-works/pi-tui';
import { clean, type NativeView } from './protocol.ts';

export interface MenuState { search: string; selected?: string }
export interface MenuChoice { id: string; value?: string }
const line = (text: string) => clean(text).replace(/\n/g, ' ');

/** Reserve the native dock (including footer/widgets), not just the terminal's last row. */
function inlineHeight(tui: TUI, width: number, component: Component): number {
  const children = tui.children ?? [];
  const owner = children.find((child) => (child as Partial<Container>).children?.includes(component));
  const reserved = owner ? children.slice(1).filter((child) => child !== owner)
    .reduce((height, child) => height + child.render(width).length, 0) : 0;
  return Math.max(1, Math.min(tui.terminal.rows - 6, tui.terminal.rows - 1 - reserved));
}

/** Public Input/SelectList APIs only; state belongs to this navigation session. */
export function remoteMenu(ctx: ExtensionContext, view: NativeView, state: MenuState, signal: AbortSignal,
  watch: (changed: () => void) => () => void): Promise<MenuChoice | undefined> {
  return ctx.ui.custom<MenuChoice | undefined>((tui, theme, keys, done) => {
    const input = new Input(); input.setValue(state.search);
    const settings = getSettingsListTheme();
    const items = view.controls.map((c) => {
      const values = c.kind === 'toggle' ? ['false', 'true'] : c.kind === 'select' && (c.options?.length ?? 0) < 5
        ? c.options?.map((o, i) => `${i + 1}. ${line(o.label)}`) : undefined;
      const index = c.options?.findIndex((o) => o.value === c.value) ?? -1;
      return { id: c.id, label: `${c.icon ? `${line(c.icon)} ` : ''}${line(c.label)}`, description: line(c.description ?? ''), values,
        value: c.kind === 'action' ? 'Open' : c.kind === 'select' ? values?.[index] ?? line(c.options?.find((o) => o.value === c.value)?.label ?? String(c.value ?? '')) : line(String(c.value ?? '')) };
    });
    items.push({ id: '__refresh', label: 'Refresh', description: '', value: '', values: undefined });
    let filtered = items, list: SelectList | undefined, layout = '', geometry = '', usable = false, listTop = 0, listRows = 0;
    const cancel = () => done(undefined);
    const changed = () => done({ id: '__changed' });
    const unwatch = watch(changed);
    signal.addEventListener('abort', cancel, { once: true });
    const activate = () => {
      if (signal.aborted || !usable || !layout || geometry !== `${tui.terminal.columns}:${tui.terminal.rows}`) return;
      const item = filtered.find((item) => item.id === list?.getSelectedItem()?.value);
      if (item) done({ id: item.id, value: item.values?.[(item.values.indexOf(item.value) + 1) % item.values.length] });
    };
    const component: Component & { dispose(): void; focused: boolean } = {
      get focused() { return input.focused; },
      set focused(value) { input.focused = value; },
      render(width) {
        const height = inlineHeight(tui, width, component);
        geometry = `${width}:${tui.terminal.rows}`;
        usable = width >= 28 && height >= 10;
        if (!usable) { layout = ''; return [truncateToWidth('Enlarge terminal · Esc back', width)]; }
        const compact = height < 16;
        const border = new DynamicBorder((s) => theme.fg('border', s)).render(width);
        const hints = wrapTextWithAnsi(`${keyText('tui.select.up')}/${keyText('tui.select.down')} move · ${keyText('tui.select.confirm')}/Space change · ${keyText('tui.select.cancel')} back · Ctrl+R refresh`, width);
        const header = [...border, truncateToWidth(theme.fg('accent', line(view.title)), width),
          ...(!compact && view.body ? wrapTextWithAnsi(line(view.body), width).slice(0, 2) : []), ...input.render(width), ''];
        const detailRows = compact ? 1 : 2;
        // SelectList may append a scroll indicator. Reserve that row even at the ends.
        const capacity = Math.min(10, height - header.length - detailRows - hints.length - border.length - 2);
        if (capacity < 1) { usable = false; layout = ''; return [truncateToWidth('Enlarge terminal · Esc back', width)]; }
        filtered = items.filter((item) => state.search.toLowerCase().split(/\s+/).every((term) => item.label.toLowerCase().includes(term)));
        const signature = `${width}:${capacity}:${state.search}`;
        if (layout !== signature) {
          layout = signature;
          const labelWidth = Math.min(36, Math.floor((width - 6) * 0.6), Math.max(1, ...items.map((item) => visibleWidth(item.label))));
          const row = (item: typeof items[number], selected: boolean) => {
            const label = truncateToWidth(item.label, labelWidth, '');
            return settings.label(label + ' '.repeat(Math.max(0, labelWidth - visibleWidth(label))), selected) + '  '
              + settings.value(truncateToWidth(item.value, Math.max(1, width - labelWidth - 6), ''), selected);
          };
          list = new SelectList(filtered.map((item) => ({ value: item.id, label: row(item, false) })), capacity, {
            selectedPrefix: () => '', selectedText: () => settings.cursor + row(filtered.find((item) => item.id === list?.getSelectedItem()?.value)!, true),
            description: settings.description, scrollInfo: settings.hint, noMatch: () => settings.hint('  No matching settings'),
          });
          list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.id === state.selected)));
          list.onSelectionChange = (item) => { state.selected = item.value; };
          list.onSelect = activate; list.onCancel = cancel;
          if (list.getSelectedItem()) state.selected = list.getSelectedItem()!.value;
        }
        const selected = filtered.find((item) => item.id === list?.getSelectedItem()?.value);
        const wrapped = wrapTextWithAnsi(selected?.description ?? '', width - 4);
        const description = wrapped.slice(0, detailRows);
        if (wrapped.length > detailRows) description[detailRows - 1] = truncateToWidth(description[detailRows - 1], width - 5, '') + '…';
        while (description.length < detailRows) description.push('');
        const rows = list!.render(width); listTop = header.length; listRows = Math.min(capacity, filtered.length);
        return [...header, ...rows, '', ...description.map((s) => settings.description(`  ${s}`)), ...hints.map(settings.hint), ...border]
          .map((s) => truncateToWidth(s, width));
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.columns}:${tui.terminal.rows}`) {
          if (matchesKey(data, Key.ctrl('r'))) done({ id: '__refresh' });
          else if (data === ' ' && !state.search) activate();
          else if ((['tui.select.up', 'tui.select.down', 'tui.select.pageUp', 'tui.select.pageDown', 'tui.select.confirm'] as const).some((key) => keys.matches(data, key))) { if (layout) list?.handleInput(data); }
          else { input.handleInput(data); if (state.search !== input.getValue()) { state.search = input.getValue(); layout = ''; } }
        }
        tui.requestRender();
      },
      handleMouse(event) {
        if (!usable || !layout || geometry !== `${tui.terminal.columns}:${tui.terminal.rows}` || event.y < listTop || event.y >= listTop + listRows) return;
        return list?.handleMouse({ ...event, y: event.y - listTop });
      },
      invalidate() { layout = ''; input.invalidate(); list?.invalidate(); },
      dispose() { unwatch(); signal.removeEventListener('abort', cancel); },
    };
    return component;
  });
}
