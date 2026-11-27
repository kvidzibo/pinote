import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Text, truncateToWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { NativeFooter } from './footer.ts';
import { clean, cleanMarkdown, editorText, footerText, type NativeControl, type NativeView } from './protocol.ts';
import { PinoteFailure } from './client.ts';
import { PinoteSession } from './session.ts';
import { pinoteMenu, type MenuState } from './menu.ts';
import { document, editValue, working, type Draft } from './dialogs.ts';
import { disclosure, menuView, parentScreen, serverScreen, type Screen } from './navigation.ts';
import { KittyPane, paneCloser } from './kitty.ts';
import { parseKittyOneTaskPerTab, parseTaskCompletion, readConfigDocument, type TaskCompletionAction } from '../footer-config.ts';

const line = (text: string) => clean(text).replace(/\n/g, ' ');
const disconnected = 'Pinote unavailable · retrying… (/pinote)';
/** The configured action after completing this session's task; invalid settings keep Pi open. */
export function taskCompletion(): TaskCompletionAction {
  try { return parseTaskCompletion(readConfigDocument().value); } catch { return 'keep-open'; }
}

/** Review and approval are separate; Enter can never approve by default. */
export async function review(ctx: ExtensionContext, title: string, text: string, signal: AbortSignal, accept = 'Confirm'): Promise<boolean> {
  return await document(ctx, title, text, signal, true) && !signal.aborted &&
    await ctx.ui.select(line(title), ['Cancel', accept], { signal }) === accept && !signal.aborted;
}

export class PinoteUI {
  private ctx?: ExtensionContext;
  private repaint = () => {};
  private menuChanged?: () => void;
  private opening = false;
  private acting = false;
  private closing = false;
  private watcherFailureKey = '';
  private failure?: PinoteFailure;
  private pi: ExtensionAPI;
  private session: PinoteSession;
  private completion: () => TaskCompletionAction;
  private kitty: KittyPane;
  constructor(pi: ExtensionAPI, session: PinoteSession, completion = taskCompletion) {
    this.pi = pi; this.session = session; this.completion = completion;
    this.kitty = new KittyPane((command, args, options) => this.pi.exec(command, args, options));
    session.onChange = () => {
      this.render(); this.menuChanged?.();
      // Only the interactive Pi owns its pane: child processes inherit the Kitty environment.
      const id = session.view?.state.selectedId;
      if (this.ctx?.mode !== 'tui') return;
      if (session.view) void this.kitty.mark(typeof id === 'number' ? id : null, session.view.prStatus);
      else void this.kitty.clearPR();
    };
  }
  /** After detach on shutdown: this pane no longer holds a task. */
  release(): Promise<void> { return this.kitty.release(); }
  attach(ctx: ExtensionContext): void {
    this.ctx = ctx;
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('pinote-remote', (tui, theme) => {
      this.session.fullscreen = tui.mode === 'fullscreen';
      this.repaint = () => tui.requestRender();
      if (!this.session.fullscreen) return { render: () => [], invalidate() {} };
      const footer = new NativeFooter(() => this.session.view ? [{ uri: 'pinote://ui', view: this.session.view }] : [], theme,
        async ({ view }, item, action) => {
          if (this.opening || this.acting) return false;
          if (item.openApp) { await this.open(ctx); return true; }
          const control = view.controls.find((c) => c.id === action && c.kind === 'action');
          // Deliberate footer double-click approves completion, suggestion acceptance or adding a future task.
          const approved = (action === 'done' || action === 'proposal:accept' || action === 'later:accept') && item.doubleAction === action;
          return control ? this.dispatch(ctx, view, control, undefined, approved) : false;
        }, this.repaint);
      return {
        render: (width: number) => this.session.view ? footer.render(width) :
          [truncateToWidth(theme.fg('warning', disconnected), width)],
        handleMouse: (event: TuiMouseEvent) => this.session.view ? footer.handleMouse(event) : undefined,
        invalidate: () => footer.invalidate(),
        dispose: () => footer.dispose(),
      };
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
    const diagnostics = this.session.view?.watcherDiagnostics;
    if (diagnostics) {
      const key = diagnostics.failures.length ? JSON.stringify(diagnostics) : '';
      if (key !== this.watcherFailureKey) {
        const failures = diagnostics.failures.map((watcher) =>
          `${line(watcher.name)} [${watcher.fields.map(line).join(', ')}${watcher.moreFields ? `, +${watcher.moreFields} fields` : ''}]`).join(', ').slice(0, 2000);
        this.ctx.ui.notify(failures ? `Pinote watchers failing: ${failures}.\nDetails: ${line(diagnostics.logPath)}` :
          'Pinote watcher failures cleared.', failures ? 'warning' : 'info');
        this.watcherFailureKey = key;
      }
    }
    const theme = this.ctx.ui.theme;
    this.ctx.ui.setStatus('pinote-remote', this.session.fullscreen ? undefined : this.session.view ? footerText(this.session.view, truncateToWidth, (text, style) => {
      let rendered = style.color ? theme.fg(style.color, text) : text;
      if (style.italic) rendered = theme.italic(rendered);
      return style.strikethrough ? theme.strikethrough(rendered) : rendered;
    }) : disconnected);
    this.repaint();
  }
  async dispatch(ctx: ExtensionContext, view: NativeView, control: NativeControl, value?: NativeControl['value'], footerConfirmed = false): Promise<boolean> {
    if (ctx.mode !== 'tui') throw new Error('Pinote UI actions require TUI mode');
    if (this.acting) return false;
    if (control.id === 'done' && !ctx.isIdle()) {
      ctx.ui.notify('Wait for the current agent run before completing this task.', 'warning'); return false;
    }
    this.acting = true; this.failure = undefined;
    const current = this.session.current(), signal = this.session.signal;
    // Read once, so the confirmation describes what completion does.
    const completion = control.id === 'done' ? this.completion() : 'keep-open';
    try {
      if (typeof value === 'string') editorText(value);
      if (control.id === 'done' && !footerConfirmed) {
        const exits = completion !== 'keep-open';
        const accept = exits ? 'Complete task and exit' : 'Complete task';
        const summary = truncateToWidth(line(view.body ?? ''), 100);
        if (await ctx.ui.select(`Pinote / ${accept} #${view.state.selectedId}\n${summary}\n${completion === 'close-pane' ? 'Closes Pi and its Kitty pane.' : exits ? 'Closes this Pi session.' : 'Clears selection; keeps this conversation and editor.'}`,
          ['Cancel', accept], { signal }) !== accept) return false;
      }
      if (control.confirm && !(footerConfirmed && (control.id === 'proposal:accept' || control.id === 'later:accept'))) {
        const details = control.kind === 'action' ? control.confirm : `${control.confirm}\n\n${control.id === 'add' || control.id === 'add-field' || control.id === 'add-watcher' ? '' : `Before:\n${disclosure(control.value)}\n\n`}After:\n${disclosure(value)}`;
        const accept = control.id === 'add' ? 'Create, start and select' : control.id === 'proposal:accept' ? 'Accept suggestion' : control.id === 'later:accept' ? 'Add for later' :
          control.id === 'remove-field' ? 'Remove display field' : control.id === 'add-field' ? 'Add field' : 'Save change';
        if (!await review(ctx, line(control.label), details, signal, accept)) return false;
      }
      if (!current() || signal.aborted) return false;
      if (control.id === 'continue' && ctx.ui.getEditorText().length) {
        ctx.ui.notify('Draft not inserted: your editor already contains text. Clear or save it first.', 'warning'); return false;
      }
      const result = await working(ctx, control.id === 'preview' || control.id.endsWith(':preview') ? 'Loading preview…' : 'Applying Pinote action…',
        () => this.session.action(view, control, value, () => control.id !== 'done' || ctx.isIdle()), signal);
      if (!current() || !result) return false;
      const selected = this.session.view;
      // An explicit selection, even of the current task (e.g. to retry a skipped move), names the Kitty tab.
      if (selected && typeof selected.state.selectedId === 'number' && (control.id.startsWith('select:') || control.id === 'add' || control.id === 'proposal:accept')) {
        const title = line(selected.footer?.find((item) => item.action === 'preview')?.text ?? '').trim();
        let oneTaskPerTab = false;
        try { oneTaskPerTab = parseKittyOneTaskPerTab(readConfigDocument().value); } catch { /* Invalid settings: rename only. */ }
        const warning = await this.kitty.select(selected.state.selectedId, title, oneTaskPerTab, signal);
        if (!current()) return false;
        if (warning) ctx.ui.notify(warning, 'warning');
      }
      if (control.id === 'done' && ctx.isIdle() && typeof view.state.selectedId === 'number' &&
          this.session.view && this.session.view.state.selectedId == null && completion !== 'keep-open') {
        const arm = completion === 'close-pane' ? await paneCloser((command, args, options) => this.pi.exec(command, args, options)) : undefined;
        if (!current() || !ctx.isIdle()) return true; // Completed, but a run or session change since then keeps Pi open.
        arm?.();
        this.closing = true; ctx.shutdown(); return true;
      }
      if (result.notice) ctx.ui.notify(line(result.notice), 'info');
      if (result.preview) await document(ctx, `Pinote / ${control.id === 'proposal:preview' ? 'Suggestion' : control.id === 'later:preview' ? 'Future task' : 'Task preview'}`, result.preview, signal);
      if (result.draft && await review(ctx, 'Pinote / Insert task prompt', `Insert into the editor only; never submit.\n\n${disclosure(result.draft)}`, signal, 'Insert draft') && current()) {
        if (ctx.ui.getEditorText().length) ctx.ui.notify('Draft not inserted: clear the editor first.', 'warning');
        else ctx.ui.setEditorText(editorText(result.draft));
      }
      return true;
    } catch (error) {
      if (current()) {
        this.failure = error instanceof PinoteFailure ? error : new PinoteFailure(true);
        ctx.ui.notify(this.failure.message, 'warning');
        // Reconnection is an explicit read, never an automatic replay of a write.
      }
      return false;
    } finally { this.acting = false; }
  }
  private async refresh(ctx: ExtensionContext): Promise<boolean> {
    try {
      await working(ctx, 'Refreshing Pinote…', () => this.session.refresh(true), this.session.signal);
      this.failure = undefined;
      return !!this.session.view && !this.session.signal.aborted;
    } catch (error) {
      this.failure = error instanceof PinoteFailure ? error : new PinoteFailure();
      return false;
    }
  }
  async open(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== 'tui') { ctx.ui.notify('Pinote UI actions require TUI mode', 'warning'); return; }
    if (this.opening || this.acting) return;
    this.opening = true;
    const current = this.session.current(), signal = this.session.signal;
    const menus = new Map<string, MenuState>(), drafts = new Map<string, Draft>();
    let screen = 'tasks' as Screen, notice = '';
    const go = async (next: Screen): Promise<boolean> => {
      // Search changes view revisions. Navigate only after it settles, using fresh controls.
      await menus.get('tasks')?.pendingSearch;
      if (!current()) return false;
      const view = this.session.view;
      if (!view) return false;
      const target = serverScreen(next);
      if ((view.state.screen ?? 'tasks') !== target) {
        const control = view.controls.find((c) => c.id === `screen:${target}`);
        if (!control) return false;
        try { await working(ctx, 'Opening Pinote…', () => this.session.action(view, control), signal); }
        catch (error) { this.failure = error instanceof PinoteFailure ? error : new PinoteFailure(); return false; }
      }
      screen = next; notice = ''; return true;
    };
    try {
      await this.refresh(ctx);
      await go('tasks');
      while (current() && !signal.aborted && !this.closing) {
        if (this.failure || !this.session.view) {
          const failure = this.failure;
          const title = failure?.uncertain ? 'Pinote / Verify result' : failure?.stale ? 'Pinote / State changed' : 'Pinote / Unavailable';
          const choice = await ctx.ui.select(`${title}\n${failure?.message ?? 'Task state could not be verified.'}\nConnection recovery uses reads only; writes are never retried. Invalid config needs repair on the service.`,
            ['Refresh and verify', 'Close'], { signal });
          if (choice !== 'Refresh and verify' || !current()) return;
          if (await this.refresh(ctx)) await go(screen === 'field' ? 'fields' : screen);
          continue;
        }
        const view = this.session.view;
        if (screen === 'field' && view.state.screen !== 'field') screen = 'fields';
        const menu = menuView(view, screen);
        const key = screen === 'field' ? `field:${String(view.state.field)}` : screen;
        const state = menus.get(key) ?? { search: screen === 'tasks' ? String(view.state.search ?? '') : '' };
        menus.set(key, state);
        const choice = await pinoteMenu(ctx, menu, state, signal, (changed) => {
          this.menuChanged = changed;
          return () => { if (this.menuChanged === changed) this.menuChanged = undefined; };
        }, { search: screen === 'tasks' ? 'tasks' : screen === 'fields' ? 'local' : 'none', notice,
          tab: screen === 'tasks' ? 'settings' : screen === 'settings' ? 'tasks' : undefined,
          searchLabel: screen === 'fields' ? 'Filter fields' : undefined,
          onSearch: async (query) => {
            const latest = this.session.view, control = latest?.controls.find((c) => c.id === 'search');
            if (!current() || !latest || !control) throw new PinoteFailure();
            try { await this.session.action(latest, control, query); }
            catch (error) {
              if (current()) { this.failure = error instanceof PinoteFailure ? error : new PinoteFailure(); this.menuChanged?.(); }
              throw error;
            }
          },
        });
        if (!current()) return;
        if (!choice) {
          const parent = parentScreen(screen);
          if (!parent) return;
          await go(parent); continue;
        }
        if (choice.id === '__changed') continue;
        if (choice.id === '__refresh') { await this.refresh(ctx); continue; }
        if (choice.id.startsWith('__preview:')) {
          const id = Number(choice.id.slice('__preview:'.length));
          try {
            const task = await working(ctx, 'Loading task text…', () => this.session.tool('get_task', { task_id: id }, signal), signal) as { id?: unknown; text?: unknown } | undefined;
            if (!current() || !task) return;
            if (task?.id !== id || typeof task.text !== 'string') throw new PinoteFailure();
            await document(ctx, `Pinote / Task text #${id}`, task.text, signal);
          } catch (error) { if (current()) this.failure = error instanceof PinoteFailure ? error : new PinoteFailure(); }
          continue;
        }
        if (['__tasks', '__settings', '__prompts', '__footer', '__fields', '__watchers'].includes(choice.id)) { await go(choice.id.slice(2) as Screen); continue; }
        const control = view.controls.find((c) => c.id === choice.id);
        if (!control) continue;
        if (control.id.startsWith('field:')) {
          if (await this.dispatch(ctx, view, control)) { screen = 'field'; notice = ''; }
          continue;
        }
        let applied = false;
        if (control.kind === 'text' || control.kind === 'number') {
          const draftKey = `${key}:${control.id}`;
          const draft = drafts.get(draftKey) ?? { text: String(control.value ?? '') };
          drafts.set(draftKey, draft);
          do {
            let value: NativeControl['value'];
            try { value = await editValue(ctx, `${menu.title} / ${line(control.label)}`, view, control, draft, signal); }
            catch { ctx.ui.notify('This value cannot be edited safely in the terminal. Edit pi-note.json directly.', 'warning'); break; }
            if (value === undefined || !current()) break;
            applied = await this.dispatch(ctx, view, control, value);
            if (applied) drafts.delete(draftKey);
            // Approval cancellation returns to the draft; a stale/uncertain action returns to recovery.
          } while (!applied && !this.failure && current() && !signal.aborted);
        } else if (control.kind === 'toggle' || control.kind === 'select') {
          const options = control.kind === 'toggle' ? [{ label: 'On', value: true }, { label: 'Off', value: false }] : control.options ?? [];
          const choices = options.map((o, i) => ({ id: `option:${i}`, kind: 'action' as const,
            label: `${line(o.label)}${o.value === control.value ? '  [current]' : ''}`, description: control.description }));
          const picked = await pinoteMenu(ctx, { ...view, title: `${menu.title} / ${line(control.label)}`, body: 'Choose a value, then review and confirm the shared change.', controls: choices },
            { search: '', selected: `option:${Math.max(0, options.findIndex((o) => o.value === control.value))}` }, signal, () => () => {}, { search: 'none' });
          const option = picked && options[Number(picked.id.split(':')[1])];
          if (option && current()) applied = await this.dispatch(ctx, view, control, option.value);
        } else applied = await this.dispatch(ctx, view, control);
        if (applied) {
          if (control.id.startsWith('select:') || ['add', 'proposal:accept', 'continue'].includes(control.id)) return;
          if (control.id === 'remove-field') screen = 'fields';
          notice = control.id === 'clear' ? 'Selection cleared; task progress is unchanged.' : control.id === 'done' ? 'Task completed.' :
            control.id === 'proposal:dismiss' ? 'Suggestion dismissed; tasks are unchanged.' : control.id.startsWith('later:') ? '' : control.confirm ? `Saved: ${line(control.label)}.` : '';
        }
      }
    } finally { this.opening = false; this.menuChanged = undefined; }
  }
}

const STARTUP_TASK = 'pinote-startup-task';

export async function showStartupTask(pi: ExtensionAPI, ctx: ExtensionContext, session: PinoteSession): Promise<void> {
  const id = session.view?.state.selectedId;
  if (ctx.mode !== 'tui' || typeof id !== 'number') return;
  const current = session.current();
  try {
    const task = await session.tool('get_current', {}) as { id?: unknown; text?: unknown } | null;
    if (current() && session.view?.state.selectedId === id && task?.id === id && typeof task.text === 'string')
      pi.appendEntry(STARTUP_TASK, { id, text: cleanMarkdown(task.text) });
  } catch {
    if (current()) ctx.ui.notify('Pinote: could not display the selected task text.', 'warning');
  }
}
export function registerTaskEntries(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ id: number; text: string }>(STARTUP_TASK, (entry, _options, theme) => {
    if (!entry.data || !Number.isSafeInteger(entry.data.id) || entry.data.id < 1 || typeof entry.data.text !== 'string') return;
    const card = new Container();
    card.addChild(new Text(theme.fg('accent', `Task #${entry.data.id}`), 0, 0));
    card.addChild(new Markdown(cleanMarkdown(entry.data.text), 0, 0, getMarkdownTheme()));
    return card;
  });
  // Historical TUI-only preview entries remain readable after upgrading.
  pi.registerEntryRenderer<{ title: string; text: string }>('pinote-remote-preview', (entry, _options, theme) =>
    new Text(`${theme.fg('accent', line(entry.data?.title ?? 'Pinote preview'))}\n\n${clean(entry.data?.text ?? '')}`, 0, 0));
}
