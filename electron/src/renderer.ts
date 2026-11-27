import { MarkdownEditor, compactTitle } from './markdown-editor';
import { base64, convertImage } from './image-convert';
import { imageHashes, imageRef } from './image-refs';
import { undo, undoDepth } from '@codemirror/commands';
import type { Task, Tag, Snapshot, UIState, View, Operations, RendererOperation, Result, MenuPoint, MenuRequest, MenuAction } from './protocol';
import { defaultTaskActions, initialState, normalizeTaskActions, TASK_ACTION_STATES } from './protocol';
import type { TaskActionId, TaskActionState, TaskActionPreferences, TaskRowElementId } from './protocol';
import { fillPreview } from './preview-content';
import type { KittySettings, TaskCompletionAction, WindowSettings, WindowStartup, PreviewData, Watcher, WatcherEntry, WatcherParam, WatcherSettings, WatcherValue } from './protocol';
import { APP_EVENTS, DEFAULT_KITTY_START_PROMPT, DEFAULT_KITTY_TAB_TITLE, FIELD_EVENTS, TASK_EVENTS, WATCHER_LIMITS, savedTagName, tagFolderPath, validKittyStartPrompt, validKittyTabTitle } from './protocol';
const api = window.pinote;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ordinary = $('ordinary'), pinned = $('pinned'), checklist = $('checklist');
const composerEditor = new MarkdownEditor($('draft-host'), '', 'Add a task…', true, () => {
  if (closing || !stateLoaded) return;
  state.draft = composerEditor.value; draftVersion++; resizeComposer(); saveSoon();
}, () => { void track(addTask()); }, file => storeImage(file));
const composer = composerEditor.dom; composer.id = 'draft';
// Images are pruned when deleted from the composer once it loses focus; undo works until then.
composer.addEventListener('blur', () => { if (composerEditor.releaseImages()) void pruneImages(); });
$('draft-host').addEventListener('load', () => fitWindow(), true);
const toolbar = $('toolbar'), notice = $('notice'), popupRoot = $('popups');
new ResizeObserver(() => document.documentElement.style.setProperty('--notice-height', `${notice.hidden ? 0 : notice.getBoundingClientRect().height + 6}px`)).observe(notice);
let state: UIState = initialState();
let active: Snapshot | null = null;
let creationTag: string | null = null;
let readonly = false, closing = false, collapsed = false, polling = false, baseline = false, stateLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistChain: Promise<void> = Promise.resolve();
let draftSaveFailed = false;
const pending = new Set<Promise<unknown>>();
const marked = new Map<number, string>();
const rowNodes = new Map<number, HTMLElement>();
const rowKeys = new Map<number, string>();
const exiting = new Set<number>();
let scrollToId: number | undefined;
let scrollReady = false;
let draftVersion = 0;
const editFlushers = new Set<() => Promise<void>>();
const closedEdits = new Map<number, Promise<void>>();
let editEpoch = 0;
function restoreScroll(): void {
  ordinary.scrollTop = state.scroll?.ordinary ?? 0;
  pinned.scrollTop = state.scroll?.pinned ?? 0;
}
for (const list of [ordinary, pinned]) list.addEventListener('scroll', () => {
  if (!scrollReady || collapsed || closing) return;
  const next = { ordinary: ordinary.scrollTop, pinned: pinned.scrollTop };
  if (next.ordinary === (state.scroll?.ordinary ?? 0) && next.pinned === (state.scroll?.pinned ?? 0)) return;
  state.scroll = next; saveSoon();
});
const busyTasks = new Set<number>();
let pointerInside = false;
const icons = {
  add: 'list-add', edit: 'document-edit', save: 'document-save', copy: 'edit-copy',
  reset: 'document-revert', start: 'media-playback-start', done: 'task-complete',
  remove: 'archive', trash: 'edit-delete', folder: 'folder', tag: 'tag',
  filter: 'view-filter', clear: 'view-filter-clear', all: 'edit-select-all',
  preview: 'view-reveal', unread: 'view-reveal-unread', menu: 'open-menu', settings: 'settings',
  close: 'window-close', kitty: 'utilities-terminal', schedule: 'preferences-system-notifications',
  collapse: 'view-collapse', expand: 'view-expand', move: 'move', grip: 'drag-handle', undo: 'edit-undo',
} as const;
type Icon = keyof typeof icons;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}
function fitWindow(): void {
  if (!active || collapsed) return;
  const count = active.notes.filter(visible).length;
  const height = Math.min(count, Math.max(2, active.config.maxVisibleNotes)) * 34 + $('composer').offsetHeight + (notice.hidden ? 0 : notice.offsetHeight + 5) + 20;
  void api.fit(layers.some(l => l.kind === 'task-actions' || l.kind === 'manage-tags' || l.kind === 'watchers' || l.kind === 'kitty' || l.kind === 'edit') ? Math.max(560, height) : height).catch(e => console.error(message(e)));
}
function report(message: string): void {
  notice.replaceChildren(el('span', message));
  notice.hidden = false;
  if (readonly && state.warning) {
    if (message !== state.warning) notice.append(el('span', state.warning));
    notice.append(button('done', 'I checked saved tasks; enable writes', async () => {
      if (await api.acknowledgeWarning()) { readonly = false; state.warning = ''; composerEditor.readOnly = false; notice.hidden = true; updateEditors(); renderTasks(); renderToolbar(); }
    }));
  } else notice.append(button('close', 'Dismiss notice', () => { notice.hidden = true; fitWindow(); }));
  fitWindow();
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** A main-process error without Electron's IPC prefix. */
function ipcMessage(error: unknown): string { return message(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
function recoveryWarning(text: string, preserveDrafts = false): void {
  readonly = true; state.warning = text; composerEditor.readOnly = true; updateEditors(); report(text); renderTasks(); renderToolbar();
  if (preserveDrafts) void track(persist(true)).catch(() => undefined);
}
function button(icon: Icon, label: string, action: (event: MouseEvent) => unknown, disabled = false): HTMLButtonElement {
  const b = el('button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
  const image = el('img'); image.src = `icons/${icons[icon]}-symbolic.svg`; image.alt = ''; image.setAttribute('aria-hidden', 'true');
  b.append(image); b.disabled = disabled;
  b.addEventListener('click', event => {
    if (closing) return;
    try {
      const result = action(event);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void track(Promise.resolve(result)).catch(e => report(message(e)));
      }
    } catch (e) { report(message(e)); }
  });
  return b;
}
function tagBadge(name: string): HTMLElement {
  const badge = el('span', undefined, 'badge'); badge.title = name;
  const image = el('img'); image.src = `icons/${icons.tag}-symbolic.svg`; image.alt = ''; image.setAttribute('aria-hidden', 'true');
  badge.append(image, el('span', name)); return badge;
}
function textButton(text: string, action: () => unknown): HTMLButtonElement {
  const b = button('save', text, action); b.replaceChildren(document.createTextNode(text)); return b;
}
let statePending = false;
function saveSoon(): void {
  if (readonly || closing) return;
  clearTimeout(persistTimer); statePending = true;
  persistTimer = setTimeout(() => { void persist().catch(() => undefined); }, 180);
}
function persist(recovery = false): Promise<void> {
  clearTimeout(persistTimer); statePending = false;
  if ((readonly && !recovery) || !stateLoaded) return Promise.resolve();
  const copy: UIState = JSON.parse(JSON.stringify({ ...state, creationTag, collapsed }));
  const work = persistChain.then(() => api.saveState(copy));
  persistChain = work.then(() => { draftSaveFailed = false; }, e => { draftSaveFailed = true; report(`Draft cache could not be saved: ${message(e)}. Keep this window open or copy your draft.`); });
  return work;
}
// Images open editors, drafts or task text still use. Undo history counts as use while an editor is open.
const liveEditors = new Set<MarkdownEditor>([composerEditor]);
let imageAdds = 0, pruneQueued = false, pruning = false, closeRequested = false;
async function storeImage(file: File): Promise<string | null> {
  if (readonly || closing || closeRequested || !active) { report('Images cannot be added while saving is paused or Pinote is closing.'); return null; }
  imageAdds++;
  try {
    const result = await call('image_add', { data: await base64(await convertImage(file)) });
    return result ? imageRef(result.hash) : null;
  } catch (e) { report(`Image not added: ${message(e)}`); return null; }
  // The caller inserts the reference before a queued prune runs.
  finally { imageAdds--; if (!imageAdds && pruneQueued) setTimeout(pruneImages); }
}
async function pruneImages(): Promise<void> {
  if (readonly || closing || !active) return;
  if (imageAdds || pruning) { pruneQueued = true; return; }
  pruneQueued = false; pruning = true;
  try {
    // Save the drafts that dropped a reference first; until then the saved draft keeps its images.
    if (statePending || draftSaveFailed) { try { await persist(); } catch { return; } }
    // Wait for every queued save, including ones queued meanwhile.
    for (let tail = persistChain; ; tail = persistChain) { await tail; if (tail === persistChain) break; }
    if (draftSaveFailed || readonly || closing) return;
    if (imageAdds || statePending) { pruneQueued = true; return; }
    const keep = new Set(imageHashes(state.draft));
    for (const editor of liveEditors) for (const hash of editor.imageHashes) keep.add(hash);
    for (const draft of Object.values(state.edits)) for (const hash of imageHashes(draft.text)) keep.add(hash);
    // Not a journaled task write: a failure only leaves unused images until the next prune.
    const result = await track(api.image_prune({ keep: [...keep] }));
    if (!result.ok && result.error.code !== 'busy') report(`Unused images were not deleted: ${result.error.message}`);
  } catch (e) { report(`Unused images were not deleted: ${message(e)}`); }
  finally { pruning = false; if (pruneQueued) void pruneImages(); }
}
async function call<K extends RendererOperation>(name: K, params: Operations[K]['params'], drainEdit = false): Promise<Operations[K]['result'] | null> {
  const write = name !== 'snapshot' && name !== 'completions';
  if (write && (readonly || (closing && !drainEdit) || !active)) { report('Read-only: writes are disabled until tasks and configuration load safely. Copy drafts to recover them.'); return null; }
  // Flush the submitted text before dispatch; debounce alone cannot protect fast failures.
  if (write) {
    try { await persist(); } catch { report('Drafts could not be saved; the operation was not submitted. Keep this window open or copy your text.'); return null; }
    // Closing drains accepted callbacks, but recovery must stop writes not yet dispatched.
    if (readonly) return null;
  }
  try {
    const fn = api[name] as (p: Operations[K]['params']) => Promise<Result<Operations[K]['result']>>;
    const result = await track(fn(params));
    if (!result.ok) {
      report(`${result.error.code}: ${result.error.message}${result.error.code === 'unknown' ? ' Outcome unknown; inspect current tasks before explicitly retrying. Nothing will be replayed automatically.' : ''}`);
      if (result.error.code === 'unknown') recoveryWarning(result.error.message, true);
      return null;
    }
    if (result.warning) recoveryWarning(result.warning, true);
    return result.result;
  } catch (e) {
    if (write) recoveryWarning(`Outcome unknown; inspect tasks before retrying. ${message(e)}`, true);
    else report(`Refresh failed: ${message(e)}`);
    return null;
  }
}
function target(task: Task) { return { id: task.id, revision: task.updated_at }; }
function isProgress(task: Task): boolean { return task.state === 'in_progress'; }
function matches(task: Task): boolean { return state.filters === null || state.filters.includes(task.tag ?? ''); }
function unread(task: Task): boolean { return task.agent_event_id > (state.read[String(task.id)] ?? 0); }
function visible(task: Task): boolean { return isProgress(task) || matches(task); }
function selectAll(): void { state.filters = null; saveSoon(); renderTasks(); renderToolbar(); }
function showSaved(id?: number): void {
  scrollToId = id;
  const task = active?.notes.find(t => t.id === id);
  if (task && !visible(task)) {
    report('Saved task is hidden by the tag filter.');
    notice.append(button('preview', 'Show task (select all tags)', () => { selectAll(); renderTasks(); if (!readonly || !state.warning) notice.hidden = true; }));
  }
}
function resizeComposer(): void {
  fitWindow();
}
function newComposerDraft(): string { return state.composerStartAsMarkdown ? '# ' : ''; }
function setComposerDraft(text: string): void {
  state.draft = text; composerEditor.setText(text);
  composerEditor.view.dispatch({ selection: { anchor: text.length } });
  draftVersion++; resizeComposer(); saveSoon();
}
async function addTask(): Promise<void> {
  // A paste still being stored belongs to this task.
  await composerEditor.imagesSettled();
  if (!composerEditor.value.trim() || (state.composerStartAsMarkdown && /^#\s*$/.test(composerEditor.value)) || adding || readonly || closing) return;
  const text = composerEditor.value, tag = creationTag, version = draftVersion;
  adding = true; renderToolbar();
  try {
    const result = await call('add', { text, tag });
    if (!result) return;
    if (version === draftVersion) setComposerDraft(newComposerDraft());
    if (composerEditor.releaseImages()) void pruneImages();
    // Commit success is independent of the following read/cache operations.
    scrollToId = result.id;
    await refresh(); showSaved(result.id);
  } finally { adding = false; renderToolbar(); if (!layers.length && !closing) composerEditor.view.focus(); }
}
let adding = false;
let nativeMenuOpen = false;
let taskActions: { task: Task; source: HTMLElement } | undefined;
$('composer').addEventListener('submit', e => { e.preventDefault(); void track(addTask()); });

// Each layer owns its callbacks. Escape removes only the topmost layer.
type Layer = { overlay: HTMLElement; panel: HTMLElement; close: () => void; update?: () => void; taskId?: number; kind?: string };
const layers: Layer[] = [];
function layer(title: string, kind = '', taskId?: number): Layer {
  closeTaskActions();
  const prior = document.activeElement as HTMLElement | null;
  const overlay = el('div', undefined, 'overlay');
  const panel = el('section', undefined, 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title); panel.tabIndex = -1;
  const header = el('header'); header.append(el('h2', title));
  const item: Layer = { overlay, panel, kind, taskId, close: () => {
    const index = layers.indexOf(item); if (index < 0) return;
    for (const child of layers.slice(index + 1).reverse()) child.close();
    layers.splice(index, 1); overlay.remove();
    if (prior?.isConnected) prior.focus(); else composer.focus();
    renderSelected();
    if (kind === 'task-actions' || kind === 'manage-tags' || kind === 'watchers' || kind === 'kitty' || kind === 'edit') fitWindow();
  } };
  header.append(button('close', `Close ${title}`, () => item.close())); panel.append(header); overlay.append(panel); popupRoot.append(overlay); layers.push(item);
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) item.close(); });
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  panel.focus(); renderSelected(); return item;
}
function renderSelected(): void {
  for (const [id, row] of rowNodes) row.classList.toggle('selected', taskActions?.task.id === id || openedPreview?.data.task.id === id || layers.some(l => l.taskId === id));
}
function field(label: string, value = ''): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = el('label', label), input = el('input'); input.value = value; wrapper.append(input); return { wrapper, input };
}
function controls(panel: HTMLElement): HTMLElement { const bar = el('div', undefined, 'controls'); panel.append(bar); return bar; }
function confirmAction(title: string, description: string, action: () => Promise<void>): void {
  const modal = layer(title); modal.panel.append(el('p', description));
  const bar = controls(modal.panel); bar.append(textButton('Cancel', modal.close), textButton('Confirm', async () => { await action(); modal.close(); }));
}
// Keep controls mounted: polling must not steal keyboard focus or break dialog focus return.
const tagControl = button('tag', 'New-task tag', () => tagsMenu('creation'));
tagControl.className = 'creation-tag';
const tagLabel = el('span'); tagControl.append(tagLabel);
tagControl.addEventListener('contextmenu', e => { e.preventDefault(); creationTag = null; saveSoon(); renderToolbar(); });
const filterControl = button('filter', 'Filter by tag', () => tagsMenu('filter'));
const filterCount = el('span'); filterControl.append(filterCount);
const collapseControl = button('collapse', 'Collapse checklist', async () => {
  const next = !collapsed; await api.collapse(next); collapsed = next; baseline = false; checklist.hidden = next;
  if (!next) restoreScroll();
  saveSoon(); renderToolbar();
});
const moveControl = button('move', 'Drag to move window', () => undefined); moveControl.className = 'move-handle';
const menuControl = button('settings', 'Menu', openMenu); menuControl.setAttribute('aria-haspopup', 'menu');
toolbar.append(tagControl, filterControl, collapseControl, moveControl, menuControl);
function renderToolbar(): void {
  tagLabel.textContent = creationTag ?? 'Untagged';
  tagControl.title = `New-task tag: ${creationTag ?? 'Untagged'}`; tagControl.setAttribute('aria-label', tagControl.title);
  const count = active?.notes.filter(visible).length ?? 0;
  filterCount.textContent = String(count);
  filterControl.title = `Filter by tag: ${state.filters === null ? 'All' : state.filters.length ? state.filters.map(t => t || 'Untagged').join(', ') : 'None'} (${count} visible tasks, including in-progress)`;
  filterControl.setAttribute('aria-label', filterControl.title);
  filterControl.classList.toggle('filter-active', state.filters !== null);
  collapseControl.title = collapsed ? 'Expand checklist' : 'Collapse checklist'; collapseControl.setAttribute('aria-label', collapseControl.title);
  collapseControl.querySelector('img')!.src = `icons/${icons[collapsed ? 'expand' : 'collapse']}-symbolic.svg`;
  fitWindow();
}
function menuPoint(element: HTMLElement): MenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.bottom)) };
}
async function chooseMenu(request: MenuRequest, returnTo: HTMLElement): Promise<MenuAction | null> {
  if (nativeMenuOpen || closing) return null;
  closeTaskActions(false);
  nativeMenuOpen = true; returnTo.setAttribute('aria-expanded', 'true');
  try { return await api.popupMenu(request); }
  finally {
    nativeMenuOpen = false; returnTo.setAttribute('aria-expanded', 'false');
    if (!closing) (returnTo.isConnected ? returnTo : composer).focus({ preventScroll: true });
  }
}
async function openMenu(event: MouseEvent): Promise<void> {
  const source = event.currentTarget as HTMLElement;
  const action = await chooseMenu({ kind: 'app', ...menuPoint(source) }, source);
  if (closing) return;
  switch (action) {
    case 'scheduled': auxiliary('scheduled'); break;
    case 'archive': auxiliary('archive'); break;
    case 'manage-tags': manageTags(); break;
    case 'task-actions': configureTaskActions(); break;
    case 'composer-settings': configureComposer(); break;
    case 'watchers': configureWatchers(); break;
    case 'kitty': configureKitty(); break;
    case 'window-settings': configureWindow(); break;
    case 'drafts': recoverDrafts(); break;
    case 'close': window.close(); break;
  }
}
function configureComposer(): void {
  const modal = layer('New task editor');
  const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = state.composerStartAsMarkdown === true; toggle.disabled = readonly;
  const label = el('label', undefined, 'setting-toggle'); label.append(toggle, el('span', 'Start as Markdown'));
  modal.panel.append(label, el('p', 'Start new drafts with # and heading formatting. Off keeps the current plain-text start. Existing text is kept.'));
  let saving = false;
  const save = button('save', 'Save new task editor settings', async () => {
    if (readonly || closing || saving || !stateLoaded) return;
    saving = true; save.disabled = toggle.disabled = true;
    const previous = state.composerStartAsMarkdown;
    state.composerStartAsMarkdown = toggle.checked;
    try {
      await persist();
      if (!composerEditor.value || (previous && composerEditor.value === '# ')) setComposerDraft(newComposerDraft());
      modal.close(); composerEditor.view.focus();
    } catch (error) { state.composerStartAsMarkdown = previous; throw error; }
    finally { saving = false; save.disabled = toggle.disabled = readonly; }
  }, readonly);
  controls(modal.panel).append(save);
}
function configureKitty(): void {
  const existing = layers.find(l => l.kind === 'kitty'); if (existing) { existing.panel.focus(); return; }
  const modal = layer('Kitty', 'kitty');
  const status = el('p', 'Loading…', 'tag-hint'); status.setAttribute('role', 'status');
  // Start in Kitty: Electron-only working state.
  const name = field('Tab name', state.kittyTabTitle ?? DEFAULT_KITTY_TAB_TITLE);
  name.input.spellcheck = false;
  const prompt = el('textarea'); prompt.rows = 2; prompt.spellcheck = false; prompt.value = state.kittyStartPrompt ?? DEFAULT_KITTY_START_PROMPT;
  const promptLabel = el('label', 'Start prompt'); promptLabel.append(prompt);
  for (const input of [name.input, prompt]) input.addEventListener('input', () => update());
  const launch = el('div', undefined, 'window-setting'); launch.setAttribute('role', 'group'); launch.setAttribute('aria-label', 'Start in Kitty');
  launch.append(el('p', 'Start in Kitty', 'settings-heading'), name.wrapper,
    el('p', '{tag} adds "[tag] " for tagged tasks, {id} the task number and {title} its first line; {title:30} keeps the first 30 characters.', 'tag-hint'),
    promptLabel, el('p', 'Placed in Pi\'s empty editor, never sent. Leave empty for none.', 'tag-hint'));
  // Pi: shared with Pi settings in pi-note.json.
  const toggle = el('input'); toggle.type = 'checkbox'; toggle.disabled = true;
  const label = el('label', undefined, 'setting-toggle'); label.append(toggle, el('span', 'One task per tab'));
  const choices: [TaskCompletionAction, string][] = [['keep-open', 'Keep Pi open'], ['close-pi', 'Close Pi'], ['close-pane', 'Close Pi and its pane']];
  const radios = choices.map(([value, text]) => {
    const input = el('input'); input.type = 'radio'; input.name = 'kitty-completion'; input.value = value; input.disabled = true;
    const option = el('label', undefined, 'setting-toggle'); option.append(input, el('span', text)); return input;
  });
  const completion = el('div', undefined, 'window-setting'); completion.setAttribute('role', 'radiogroup'); completion.setAttribute('aria-label', 'When a task is completed in Pi');
  completion.append(el('p', 'When a task is completed in Pi', 'settings-heading'), ...radios.map(input => input.parentElement!));
  const piGroup = el('div', undefined, 'window-setting'); piGroup.setAttribute('role', 'group'); piGroup.setAttribute('aria-label', 'Pi');
  piGroup.append(el('p', 'Pi', 'settings-heading'), label,
    el('p', 'When you select a task in Pi and another pane in its Kitty tab has a different task, the pane moves to a new tab beside it, named after the task. Off renames the shared tab.', 'tag-hint'),
    completion, el('p', 'Closing a pane also ends the shell Pi ran in. Shared with Pi settings.', 'tag-hint'));
  modal.panel.append(launch, piGroup, status);
  let settings: KittySettings | undefined, saving = false;
  const chosen = () => radios.find(input => input.checked)?.value as TaskCompletionAction | undefined;
  const update = () => {
    toggle.disabled = !settings || saving || readonly;
    for (const input of radios) input.disabled = toggle.disabled;
    name.input.disabled = prompt.disabled = !stateLoaded || saving || readonly;
    save.disabled = name.input.disabled || !validKittyTabTitle(name.input.value) || !validKittyStartPrompt(prompt.value);
  };
  const save = button('save', 'Save Kitty settings', async () => {
    if (saving || readonly || closing || !stateLoaded || !validKittyTabTitle(name.input.value) || !validKittyStartPrompt(prompt.value)) return;
    saving = true; status.textContent = ''; update();
    const title = name.input.value.trim(), nextTitle = title === DEFAULT_KITTY_TAB_TITLE ? undefined : title;
    const nextPrompt = prompt.value === DEFAULT_KITTY_START_PROMPT ? undefined : prompt.value;
    try {
      // Electron-only working state is saved first, so a failed shared write can be retried alone.
      if (nextTitle !== state.kittyTabTitle || nextPrompt !== state.kittyStartPrompt) {
        const previous = [state.kittyTabTitle, state.kittyStartPrompt] as const;
        state.kittyTabTitle = nextTitle; state.kittyStartPrompt = nextPrompt;
        try { await persist(); } catch (error) { [state.kittyTabTitle, state.kittyStartPrompt] = previous; throw error; }
      }
      // Only changed values rewrite the file shared with Pi.
      const action = chosen() ?? settings?.onTaskComplete;
      if (settings && action && (toggle.checked !== settings.oneTaskPerTab || action !== settings.onTaskComplete)) await api.saveKittySettings(toggle.checked, action, settings.raw);
      modal.close();
    } catch (error) { status.textContent = ipcMessage(error); }
    finally { saving = false; update(); }
  }, true);
  controls(modal.panel).append(save); update(); fitWindow();
  void api.kittySettings().then(loaded => {
    settings = loaded; toggle.checked = loaded.oneTaskPerTab;
    for (const input of radios) input.checked = input.value === loaded.onTaskComplete;
    status.textContent = ''; update();
  }, error => { status.textContent = `Could not load Kitty settings: ${ipcMessage(error)}`; });
}
function configureWindow(): void {
  const existing = layers.find(l => l.kind === 'window-settings'); if (existing) { existing.panel.focus(); return; }
  const modal = layer('Window', 'window-settings');
  const status = el('p', 'Loading…', 'tag-hint'); status.setAttribute('role', 'status');
  let settings: WindowSettings | undefined, saving = false;
  // One setting: Remember last, or fixed values that fill from the current window when first chosen.
  const group = (heading: string, name: string, fields: [label: string, key: string, min: number][]) => {
    const radio = (text: string) => { const input = el('input'); input.type = 'radio'; input.name = name; const label = el('label', undefined, 'setting-toggle'); label.append(input, el('span', text)); return { input, label }; };
    const remember = radio('Remember last'), fixed = radio('Fixed');
    const row = el('div', undefined, 'window-fields');
    const inputs = fields.map(([text, key, min]) => {
      const input = el('input'); input.type = 'number'; input.step = '1'; input.min = String(min); input.max = '100000'; input.dataset.key = key;
      const label = el('label'); label.append(el('span', text), input); row.append(label); return input;
    });
    const section = el('div', undefined, 'window-setting'); section.setAttribute('role', 'radiogroup'); section.setAttribute('aria-label', heading);
    const choice = el('div', undefined, 'window-choice'); choice.append(remember.label, fixed.label);
    section.append(el('p', heading, 'settings-heading'), choice, row); modal.panel.append(section);
    // Empty fixed values start from the window's current bounds, not those at opening.
    const fill = (current: WindowSettings['current']) => { if (fixed.input.checked) for (const input of inputs) if (!input.value) input.value = String(current[input.dataset.key as keyof WindowSettings['current']]); update(); };
    for (const input of [remember.input, fixed.input]) input.addEventListener('change', () => {
      update();
      if (fixed.input.checked && inputs.some(input => !input.value)) void api.windowSettings().then(fresh => fill(fresh.current), () => { if (settings) fill(settings.current); });
    });
    const value = () => fixed.input.checked ? Object.fromEntries(inputs.map(input => [input.dataset.key!, Number(input.value)])) : undefined;
    const load = (saved?: Record<string, number>) => { remember.input.checked = !saved; fixed.input.checked = !!saved; inputs.forEach(input => { input.value = saved ? String(saved[input.dataset.key!]) : ''; }); };
    return { remember: remember.input, fixed: fixed.input, inputs, value, load, valid: () => !fixed.input.checked || inputs.every(input => input.value !== '' && input.checkValidity()) };
  };
  const position = group('Starting position', 'window-position', [['X', 'x', -100000], ['Y', 'y', -100000]]);
  const size = group('Starting size', 'window-size', [['Width', 'width', 280], ['Height', 'height', 120]]);
  modal.panel.append(el('p', 'Applies when Pinote starts, kept on screen. Positions are desktop coordinates. Your window manager may still tile or move it.'), status);
  const update = () => {
    const off = !settings || saving || readonly;
    for (const group of [position, size]) { group.remember.disabled = group.fixed.disabled = off; group.inputs.forEach(input => { input.disabled = off || !group.fixed.checked; }); }
    save.disabled = off || !position.valid() || !size.valid();
  };
  const save = button('save', 'Save window settings', async () => {
    if (!settings || saving || closing || !position.valid() || !size.valid()) return;
    saving = true; status.textContent = ''; update();
    const startup: WindowStartup = {};
    const fixedPosition = position.value(), fixedSize = size.value();
    if (fixedPosition) startup.position = fixedPosition as WindowStartup['position'];
    if (fixedSize) startup.size = fixedSize as WindowStartup['size'];
    try { await api.saveWindowSettings(startup); modal.close(); }
    catch (error) { status.textContent = ipcMessage(error); }
    finally { saving = false; update(); }
  }, true);
  for (const input of [...position.inputs, ...size.inputs]) input.addEventListener('input', update);
  controls(modal.panel).append(save);
  void api.windowSettings().then(loaded => { settings = loaded; position.load(loaded.startup.position); size.load(loaded.startup.size); status.textContent = ''; update(); },
    error => { status.textContent = `Could not load window settings: ${ipcMessage(error)}`; });
}
function dueLabel(task: Task): string {
  const date = task.reminder_due_at ?? task.remind_at;
  if (!date) return '';
  const ms = Date.now() - Date.parse(date);
  const hours = Math.floor(Math.abs(ms) / 3600000);
  return `${ms >= 0 ? 'Due' : 'Reminder in'} ${hours ? `${hours} hour${hours === 1 ? '' : 's'}` : 'less than an hour'}${ms >= 0 ? ' ago' : ''} — ${new Date(date).toLocaleString()}`;
}
function taskContent(task: Task, preferences: TaskActionPreferences, sample = false): HTMLElement {
  const mark = marked.has(task.id);
  const title = el('span', compactTitle(task.text), 'task-title');
  title.title = [task.text, dueLabel(task)].filter(Boolean).join('\n'); title.tabIndex = sample ? -1 : 0;
  if (!sample) title.addEventListener('contextmenu', e => { e.preventDefault(); openTaskActions(task, title); });
  if (!sample) title.addEventListener('keydown', e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openTaskActions(task, title); } });
  if (!sample) title.addEventListener('mouseup', event => {
    if (event.button !== 0 || nativeMenuOpen) return;
    const selection = window.getSelection()?.toString();
    if (selection) void api.copy(selection).catch(e => report(message(e)));
    composer.focus();
  });
  const content = el('div', undefined, 'task-content');
  const menuButton = () => button('menu', `Actions for task ${task.id}`, event => { if (!sample) openTaskActions(task, event.currentTarget as HTMLElement); });
  for (const id of preferences.row) {
    let node: HTMLElement;
    if (id === 'task-text') node = title;
    else if (id === 'task-tag') node = tagBadge(task.tag ?? 'Untagged');
    else if (id === 'actions') node = menuButton();
    else {
      const action = taskAction(task, id);
      const label = id === 'preview' ? (unread(task) ? 'Unread agent update — click to view.' : 'Preview full task')
        : `Task ${task.id}: ${action.label}; right-click ${mark ? 'delete' : isProgress(task) ? 'reset' : 'mark for deletion'}`;
      const b = button(id === 'preview' && unread(task) ? 'unread' : action.icon, label, event => { if (!sample) return runTaskAction(task, action.id, event); }, !sample && actionBlocked(task, action.id));
      b.classList.add('row-action');
      if (id !== 'preview') {
        b.classList.add('checkbox');
        if (!mark) b.classList.add(isProgress(task) ? 'in-progress-check' : 'empty-check');
        if (id === (isProgress(task) ? 'done' : 'start') && !mark) {
          b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', isProgress(task) ? 'mixed' : 'false');
        }
        if (!sample) b.addEventListener('contextmenu', e => {
          e.preventDefault();
          if (readonly || busyTasks.has(task.id)) return;
          if (mark) void track(transition(task, 'rm'));
          else if (isProgress(task)) void track(transition(task, 'reset'));
          else { marked.set(task.id, task.updated_at); renderTasks(); }
        });
      }
      if (id === 'schedule' && dueLabel(task)) b.title += `\n${dueLabel(task)}`;
      node = b;
    }
    node.dataset.rowElement = id;
    if (sample) node.tabIndex = -1;
    content.append(node);
  }
  if (!preferences.row.includes('actions')) {
    const overflow = menuButton(); overflow.dataset.overflowMenu = ''; overflow.hidden = true;
    if (sample) overflow.tabIndex = -1;
    content.append(overflow);
  }
  return content;
}
// Keep required fields visible; overflowing actions remain available even when hidden in the menu.
function fitTaskRows(): void {
  for (const content of document.querySelectorAll<HTMLElement>('.task-content')) {
    if (!content.getClientRects().length) continue;
    const actions = Array.from(content.querySelectorAll<HTMLElement>('.row-action'));
    const overflow = content.querySelector<HTMLElement>('[data-overflow-menu]');
    for (const action of actions) action.hidden = false;
    if (overflow) overflow.hidden = true;
    for (const action of actions.reverse()) {
      if (content.scrollWidth <= content.clientWidth) break;
      action.hidden = true;
      if (overflow) overflow.hidden = false;
    }
    // Inset the separator to the required text/tag fields, regardless of action order.
    const row = content.closest<HTMLElement>('.task-row')!;
    const bounds = row.getBoundingClientRect();
    const fields = ['.task-title', '.badge'].map(selector => content.querySelector(selector)!.getBoundingClientRect());
    row.style.setProperty('--separator-left', `${Math.min(...fields.map(r => r.left)) - bounds.left - row.clientLeft}px`);
    row.style.setProperty('--separator-right', `${bounds.right - Math.max(...fields.map(r => r.right)) - row.clientLeft}px`);
    if (content.contains(document.activeElement) && (document.activeElement as HTMLElement).hidden) {
      content.querySelector<HTMLElement>('[data-row-element="actions"], [data-overflow-menu]')?.focus();
    }
  }
}
window.addEventListener('resize', fitTaskRows);
function makeRow(task: Task): HTMLElement {
  const row = el('article', undefined, `task-row${isProgress(task) ? ' progress' : ''}${marked.has(task.id) ? ' marked' : ''}`);
  row.dataset.id = String(task.id);
  row.append(taskContent(task, normalizeTaskActions(state.taskActions)[taskActionState(task)]));
  return row;
}
function renderTasks(): void {
  if (!active) return;
  const opened = taskActions;
  let restoreActionFocus: number | undefined;
  if (opened) {
    const task = active.notes.find(t => t.id === opened.task.id && visible(t));
    const key = task && JSON.stringify([task, state.read[String(task.id)], marked.get(task.id), busyTasks.has(task.id), readonly, state.taskActions]);
    if (!task || rowKeys.get(task.id) !== key || exiting.has(task.id)) {
      if (rowNodes.get(opened.task.id)?.contains(document.activeElement)) restoreActionFocus = opened.task.id;
      closeTaskActions(false);
    }
  }
  const wanted = new Set<number>();
  // Capture placement before replacing row content; state and controls still update.
  const placement = new Map<number, { parent: HTMLElement; index: number }>();
  if (pointerInside) for (const parent of [ordinary, pinned]) {
    Array.from(parent.children).forEach((row, index) => {
      if (row instanceof HTMLElement && row.dataset.id) placement.set(Number(row.dataset.id), { parent, index });
    });
  }
  const ordinaryRows: HTMLElement[] = [], progressRows: HTMLElement[] = [];
  for (const task of active.notes) {
    if (!visible(task)) continue;
    wanted.add(task.id);
    const key = JSON.stringify([task, state.read[String(task.id)], marked.get(task.id), busyTasks.has(task.id), readonly, state.taskActions]);
    let row = rowNodes.get(task.id);
    // Keep the exit node until its timer finishes, even if busy clears before refresh.
    if (!row || (!exiting.has(task.id) && rowKeys.get(task.id) !== key)) { const next = makeRow(task); row?.replaceWith(next); row = next; rowNodes.set(task.id, row); rowKeys.set(task.id, key); }
    const parent = placement.get(task.id)?.parent ?? (isProgress(task) ? pinned : ordinary);
    (parent === pinned ? progressRows : ordinaryRows).push(row);
  }
  for (const [id, row] of rowNodes) {
    if (!wanted.has(id) && !exiting.has(id)) { row.remove(); rowNodes.delete(id); rowKeys.delete(id); }
  }
  // Moving an already-correct node would interrupt selection; insert only on order changes.
  function reconcile(parent: HTMLElement, rows: HTMLElement[]): void {
    let cursor: ChildNode | null = parent.firstChild;
    for (const row of rows) {
      while (cursor instanceof HTMLElement && exiting.has(Number(cursor.dataset.id))) cursor = cursor.nextSibling;
      if (row === cursor) cursor = cursor.nextSibling; else parent.insertBefore(row, cursor);
    }
    for (const empty of parent.querySelectorAll('.empty')) empty.remove();
  }
  if (pointerInside) for (const rows of [ordinaryRows, progressRows]) {
    rows.sort((a, b) => (placement.get(Number(a.dataset.id))?.index ?? Infinity) - (placement.get(Number(b.dataset.id))?.index ?? Infinity));
  }
  reconcile(ordinary, ordinaryRows); reconcile(pinned, progressRows);
  if (!wanted.size && !exiting.size) {
    const empty = el('div', active.notes.length ? 'No tasks match this filter' : 'Add your first task below', 'empty');
    if (active.notes.length) empty.append(button('filter', 'Show all tasks', selectAll)); ordinary.append(empty);
  }
  checklist.classList.toggle('mixed', ordinaryRows.length > 0);
  pinned.hidden = !progressRows.length && !Array.from(pinned.children).some(n => exiting.has(Number((n as HTMLElement).dataset.id)));
  renderSelected(); fitWindow(); fitTaskRows(); updatePreview();
  if (restoreActionFocus !== undefined) (rowNodes.get(restoreActionFocus)?.querySelector<HTMLElement>('.task-title') ?? composer).focus({ preventScroll: true });
  if (scrollToId !== undefined) {
    const row = rowNodes.get(scrollToId);
    if (row && wanted.has(scrollToId)) { row.scrollIntoView({ block: 'nearest' }); scrollToId = undefined; }
  }
}
function animateDone(id: number): void {
  const row = rowNodes.get(id);
  if (!row || exiting.has(id) || collapsed || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (taskActions?.task.id === id) closeTaskActions();
  exiting.add(id); row.classList.add('completed'); row.setAttribute('aria-label', 'Completed');
  for (const b of row.querySelectorAll('button')) b.disabled = true;
  const check = row.querySelector('[data-row-element="done"], [data-row-element="start"]'); if (check) { check.setAttribute('aria-checked', 'true'); const image = check.querySelector('img'); if (image) image.src = `icons/${icons.done}-symbolic.svg`; }
  setTimeout(() => { if (!exiting.has(id) || rowNodes.get(id) !== row) return; exiting.delete(id); row.remove(); rowNodes.delete(id); rowKeys.delete(id); renderTasks(); }, 410);
}
async function transition(task: Task, action: 'start' | 'reset' | 'done' | 'rm' | 'restore'): Promise<void> {
  if (busyTasks.has(task.id)) return;
  busyTasks.add(task.id); renderTasks();
  try {
    const result = await call('transition', { ...target(task), action, state: task.state });
    if (!result) return;
    if (action === 'done' && result.changed) animateDone(task.id);
    marked.delete(task.id);
    await refresh();
    if (action === 'restore') showSaved(task.id);
  } finally { busyTasks.delete(task.id); renderTasks(); }
}
function closeTaskActions(restoreFocus = true): void {
  const opened = taskActions;
  if (!opened) return;
  taskActions = undefined;
  const row = rowNodes.get(opened.task.id);
  row?.querySelector('.task-actions')?.remove();
  const content = row?.querySelector<HTMLElement>('.task-content');
  if (content) content.hidden = false;
  fitTaskRows(); renderSelected();
  if (restoreFocus && !closing) {
    const source = opened.source.isConnected && !opened.source.hidden ? opened.source : row?.querySelector<HTMLElement>('.task-title') ?? composer;
    source.focus({ preventScroll: true });
  }
}
function openTaskActions(task: Task, source: HTMLElement): void {
  const row = rowNodes.get(task.id);
  if (!row || closing || nativeMenuOpen || exiting.has(task.id)) return;
  closeTaskActions(false);
  taskActions = { task, source };
  const bar = el('div', undefined, 'task-actions');
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', `Actions for task ${task.id}: ${compactTitle(task.text)}`);
  const settings = normalizeTaskActions(state.taskActions)[taskActionState(task)];
  for (const id of settings.order) {
    if (settings.hidden.includes(id) && !row.querySelector<HTMLElement>(`.row-action[data-row-element="${id}"]`)?.hidden) continue;
    const action = taskAction(task, id);
    bar.append(button(action.icon, action.label, event => runTaskAction(task, action.id, event), actionBlocked(task, action.id)));
  }
  bar.append(button('close', 'Close task actions', () => closeTaskActions()));
  const enabled = Array.from(bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  for (const b of bar.querySelectorAll('button')) b.tabIndex = -1;
  enabled[0].tabIndex = 0;
  bar.addEventListener('focusin', e => { for (const b of enabled) b.tabIndex = b === e.target ? 0 : -1; });
  bar.addEventListener('keydown', e => {
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : e.key === 'ArrowRight' ? (index + 1) % enabled.length : e.key === 'ArrowLeft' ? (index + enabled.length - 1) % enabled.length : undefined;
    if (next !== undefined) { e.preventDefault(); enabled[next].focus(); }
  });
  bar.addEventListener('contextmenu', e => e.preventDefault());
  row.querySelector<HTMLElement>('.task-content')!.hidden = true;
  row.append(bar); renderSelected(); enabled[0].focus({ preventScroll: true });
}
type TaskAction = TaskActionId | 'reset';
const actionChoices: Record<TaskActionId, { icon: Icon; label: string }> = {
  kitty: { icon: 'kitty', label: 'Start in Kitty…' }, copy: { icon: 'copy', label: 'Copy note' },
  start: { icon: 'start', label: 'Start' }, done: { icon: 'done', label: 'Complete' },
  archive: { icon: 'remove', label: 'Remove to archive' }, edit: { icon: 'edit', label: 'Edit text…' },
  schedule: { icon: 'schedule', label: 'Set reminder…' }, tag: { icon: 'tag', label: 'Change tag…' },
  unmark: { icon: 'reset', label: 'Cancel deletion mark' }, preview: { icon: 'preview', label: 'Preview' },
};
function taskActionState(task: Task): TaskActionState {
  return marked.has(task.id) ? 'marked' : isProgress(task) ? 'in_progress' : 'active';
}
const actionStateLabels: Record<TaskActionState, string> = { active: 'Not started', in_progress: 'In progress', marked: 'Marked for deletion' };
function actionChoice(id: TaskActionId, state: TaskActionState): { icon: Icon; label: string } {
  if (id === 'start' && state === 'in_progress') return { icon: 'reset', label: 'Reset progress' };
  return actionChoices[id];
}
function taskAction(task: Task, id: TaskActionId): { id: TaskAction; icon: Icon; label: string } {
  return { id: id === 'start' && isProgress(task) ? 'reset' : id, ...actionChoice(id, isProgress(task) ? 'in_progress' : 'active') };
}
function actionBlocked(task: Task, id: TaskAction): boolean {
  return id !== 'copy' && id !== 'edit' && id !== 'preview' && (readonly || busyTasks.has(task.id));
}
function configureTaskActions(): void {
  const existing = layers.find(l => l.kind === 'task-actions');
  if (existing) { existing.panel.focus(); return; }
  const modal = layer('Task actions', 'task-actions');
  modal.panel.classList.add('action-settings');
  const draft = normalizeTaskActions(state.taskActions);
  let selected: TaskActionState = 'active', saving = false;
  const tabs = el('div', undefined, 'action-state-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Task state');
  const panel = el('div'); panel.id = 'task-action-state-panel'; panel.setAttribute('role', 'tabpanel');
  const tabButtons = TASK_ACTION_STATES.map((state, index) => {
    const tab = textButton(actionStateLabels[state], () => selectState(state));
    tab.id = `task-action-tab-${state}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('keydown', event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : undefined;
      if (next === undefined) return;
      event.preventDefault(); selectState(TASK_ACTION_STATES[next]); tabButtons[next].focus();
    });
    tabs.append(tab); return tab;
  });
  function selectState(state: TaskActionState): void {
    if (saving) return;
    selected = state; draw();
  }
  const previewRow = el('div', undefined, 'task-row layout-preview');
  previewRow.setAttribute('aria-label', 'Task row preview'); previewRow.inert = true;
  const list = el('div', undefined, 'row-settings-list');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Row order');
  panel.append(el('p', 'Live preview', 'settings-heading'), previewRow,
    el('p', 'Row order · top to bottom = left to right', 'settings-heading'), list);
  modal.panel.append(tabs, panel);
  const status = el('span', undefined, 'sr-only'); status.setAttribute('aria-live', 'polite'); modal.panel.append(status);
  const choice = (id: TaskRowElementId): { icon: Icon; label: string } => id === 'task-text' ? { icon: 'edit', label: 'Task text' }
    : id === 'task-tag' ? { icon: 'tag', label: 'Tag' } : id === 'actions' ? { icon: 'menu', label: 'Actions' } : actionChoice(id, selected);
  const name = (id: TaskRowElementId) => {
    const label = el('span', undefined, 'action-name'), image = el('img');
    image.src = `icons/${icons[choice(id).icon]}-symbolic.svg`; image.alt = '';
    label.append(image, el('span', choice(id).label)); return label;
  };
  // Row order and menu order use the same keyboard and pointer interaction.
  function orderedList<T extends TaskRowElementId>(container: HTMLElement, order: T[], redraw: (focus?: T) => void, populate: (row: HTMLElement, id: T) => void): void {
    let dragging: T | undefined;
    const clearDrop = () => { for (const row of container.children) row.classList.remove('drop-before', 'drop-after'); };
    const move = (id: T, to: number) => {
      const from = order.indexOf(id);
      if (readonly || saving || from === to || to < 0 || to >= order.length) return;
      order.splice(from, 1); order.splice(to, 0, id); redraw(id);
      status.textContent = `${choice(id).label}, position ${to + 1} of ${order.length}`;
    };
    container.replaceChildren();
    for (const id of order) {
      const row = el('div', undefined, 'action-setting'); row.dataset.element = id;
      const handle = button('grip', `Reorder ${choice(id).label}`, () => undefined, readonly || saving);
      handle.className = 'action-drag'; handle.draggable = !readonly && !saving;
      handle.title = `Drag to reorder ${choice(id).label}; ↑ / ↓ to move`;
      handle.setAttribute('aria-description', 'Drag, or press Arrow Up or Arrow Down to reorder.');
      handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault(); move(id, order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1));
      });
      handle.addEventListener('dragstart', event => {
        if (readonly || saving || !event.dataTransfer) { event.preventDefault(); return; }
        dragging = id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id);
      });
      handle.addEventListener('dragend', () => { dragging = undefined; clearDrop(); });
      row.addEventListener('dragover', event => {
        if (!dragging || readonly || saving) return;
        event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        clearDrop();
        const rect = row.getBoundingClientRect();
        row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
      });
      row.addEventListener('dragleave', event => { if (!row.contains(event.relatedTarget as Node | null)) row.classList.remove('drop-before', 'drop-after'); });
      row.addEventListener('drop', event => {
        if (!dragging || readonly || saving) return;
        event.preventDefault();
        const from = order.indexOf(dragging), rect = row.getBoundingClientRect();
        const at = order.indexOf(id) + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
        const moved = dragging; dragging = undefined; clearDrop(); move(moved, at > from ? at - 1 : at);
      });
      row.append(handle, name(id)); populate(row, id); container.append(row);
    }
  }
  function focusHandle(container: HTMLElement, id?: TaskRowElementId): void {
    if (!id) return;
    const handle = container.querySelector<HTMLButtonElement>(`[data-element="${id}"] .action-drag`);
    handle?.focus({ preventScroll: true }); handle?.scrollIntoView({ block: 'nearest' });
  }
  function availableActions(): void {
    const picker = layer('Available actions'); picker.panel.classList.add('action-settings');
    picker.panel.append(el('p', 'Add existing actions to the row. Drag to reorder the menu; menu visibility is independent.', 'settings-hint'));
    const heading = el('div', undefined, 'action-setting headings');
    heading.append(el('span'), el('span', 'Action'), el('span', 'In menu'), el('span', 'Row'));
    const items = el('div', undefined, 'action-settings-list'); picker.panel.append(heading, items);
    const preferences = draft[selected];
    const add = (id: TaskRowElementId) => {
      if (readonly || saving || preferences.row.includes(id)) return;
      preferences.row.push(id); draw(); redraw();
      items.querySelector<HTMLElement>(`[data-element="${id}"] .action-drag`)?.focus({ preventScroll: true });
    };
    const menu = button('add', 'Add Actions to row', () => { add('actions'); menu.disabled = true; }, readonly || preferences.row.includes('actions'));
    const menuLine = el('div', undefined, 'action-menu-choice'); menuLine.append(name('actions'), menu); picker.panel.append(menuLine);
    const redraw = (focus?: TaskActionId) => {
      orderedList(items, preferences.order, redraw, (row, id) => {
        const shown = el('input'); shown.type = 'checkbox'; shown.checked = !preferences.hidden.includes(id);
        shown.setAttribute('aria-label', `Show ${choice(id).label} in menu`); shown.title = `Show ${choice(id).label} in menu`;
        shown.disabled = readonly || saving;
        shown.addEventListener('change', () => { preferences.hidden = shown.checked ? preferences.hidden.filter(value => value !== id) : [...preferences.hidden, id]; });
        const added = preferences.row.includes(id);
        row.append(shown, button(added ? 'done' : 'add', added ? `${choice(id).label} already in row` : `Add ${choice(id).label} to row`, () => add(id), readonly || saving || added));
      });
      focusHandle(items, focus);
    };
    redraw();
  }
  function draw(focus?: TaskRowElementId): void {
    const top = modal.panel.scrollTop, preferences = draft[selected];
    tabButtons.forEach((tab, index) => {
      const chosen = TASK_ACTION_STATES[index] === selected;
      tab.setAttribute('aria-selected', String(chosen)); tab.tabIndex = chosen ? 0 : -1; tab.disabled = saving;
    });
    panel.setAttribute('aria-labelledby', `task-action-tab-${selected}`);
    reset.title = `Restore default actions for ${actionStateLabels[selected]}`; reset.setAttribute('aria-label', reset.title);
    const sample: Task = { id: 0, text: 'Configure the task row', tag: 'pinote', state: selected === 'in_progress' ? 'in_progress' : 'active', created_at: '', updated_at: '', remind_at: null, reminder_due_at: null, archived_at: null, agent_notes: {}, agent_event_id: 0, pi_sessions: [] };
    previewRow.className = `task-row layout-preview${selected === 'in_progress' ? ' progress' : selected === 'marked' ? ' marked' : ''}`;
    previewRow.replaceChildren(taskContent(sample, preferences, true));
    orderedList(list, preferences.row, draw, (row, id) => {
      const required = id === 'task-tag' || id === 'task-text';
      if (required) row.append(el('span', 'Required', 'required-element'));
      else row.append(button('close', `Remove ${choice(id).label} from row`, () => {
        const index = preferences.row.indexOf(id); preferences.row.splice(index, 1); draw(preferences.row[Math.min(index, preferences.row.length - 1)]);
      }, readonly || saving));
    });
    add.disabled = readonly || saving;
    modal.panel.scrollTop = top; fitTaskRows(); focusHandle(list, focus);
  }
  const add = button('add', 'Add actions / configure menu', availableActions, readonly);
  const addLine = el('div', undefined, 'controls'); addLine.append(add, el('span', 'Add actions / configure menu', 'settings-hint')); modal.panel.append(addLine);
  modal.panel.append(el('p', 'Drag or use ↑ / ↓. Tag and task text are required; both can move. Overflow buttons go under Actions.', 'settings-hint'));
  const bar = controls(modal.panel);
  const reset = button('reset', 'Restore default task actions', () => { if (readonly || saving) return; draft[selected] = defaultTaskActions()[selected]; draw(); }, readonly);
  const save = button('save', 'Save task actions', async () => {
    if (readonly || closing || saving || !stateLoaded) return;
    saving = true; reset.disabled = save.disabled = true; draw();
    const previous = state.taskActions;
    state.taskActions = structuredClone(draft);
    try {
      await persist(); closeTaskActions(false); renderTasks(); modal.close();
    } catch (error) {
      state.taskActions = previous; renderTasks();
      throw error;
    } finally { saving = false; reset.disabled = save.disabled = readonly; if (layers.includes(modal)) draw(); }
  }, readonly);
  bar.append(reset, save); draw(); fitWindow();
}
async function runTaskAction(task: Task, action: TaskAction, event: MouseEvent): Promise<void> {
  const source = event.currentTarget as HTMLElement;
  const point = event.detail ? { x: Math.round(event.clientX), y: Math.round(event.clientY) } : menuPoint(source);
  closeTaskActions();
  if (closing) return;
  if (!active?.notes.some(t => t.id === task.id && t.updated_at === task.updated_at)) { report('Task changed while its actions were open. Reopen them to use the latest version.'); return; }
  switch (action) {
    case 'kitty': await startKitty(task); break;
    case 'copy': await api.copy(task.text); break;
    case 'preview': await preview(task, point, source); break;
    case 'unmark': if (!actionBlocked(task, action)) { marked.delete(task.id); renderTasks(); } break;
    case 'start': case 'reset': case 'done': await transition(task, action); break;
    case 'archive': await transition(task, 'rm'); break;
    case 'edit': edit(task); break;
    case 'tag': tagsMenu('task', task); break;
    case 'schedule': schedule(task); break;
  }
}
async function startKitty(task: Task): Promise<void> {
  if (readonly || busyTasks.has(task.id)) return;
  busyTasks.add(task.id); renderTasks();
  try {
    const folder = active?.tags.find(t => t.name === task.tag)?.folder;
    const available = active?.tags.find(t => t.name === task.tag)?.available;
    const directory = folder && available !== false ? folder : await api.chooseFolder();
    if (!directory) return;
    let launchTask = task;
    if (!isProgress(task)) {
      const started = await call('transition', { ...target(task), action: 'start', state: task.state });
      if (!started || readonly) return;
      // Read explicitly: refresh() may skip while another poll is running.
      const next = await call('snapshot', { view: 'active' });
      if (!next) return;
      active = next; marked.delete(task.id);
      renderTasks(); renderToolbar();
      const current = next.notes.find(t => t.id === task.id);
      if (!current || !isProgress(current)) { report('Task changed before Kitty could start. Check its current state before retrying.'); return; }
      launchTask = current;
    }
    // Progress is already saved and visible, even if launching fails.
    // call() owns uncertain-outcome recovery; never replay a launch automatically.
    // Defaults are not sent, so an older backend can still launch.
    const { kittyTabTitle: tabTitle, kittyStartPrompt: prompt } = state;
    await call('kitty', { ...target(launchTask), directory, ...(tabTitle !== undefined && tabTitle !== DEFAULT_KITTY_TAB_TITLE ? { tabTitle } : {}),
      ...(prompt !== undefined && prompt !== DEFAULT_KITTY_START_PROMPT ? { prompt } : {}) });
  } finally { busyTasks.delete(task.id); renderTasks(); await refresh(); }
}

let previewToken = 0;
let openedPreview: { token: number; data: PreviewData; source: HTMLElement } | undefined;
async function preview(task: Task, point: MenuPoint, source: HTMLElement): Promise<void> {
  const entry = { token: ++previewToken, data: { task, markdown: active?.config.markdownPreview !== false, unread: unread(task) }, source };
  openedPreview = entry; renderSelected();
  try {
    const shown = await api.openPreview({ token: entry.token, data: entry.data, point });
    if (!shown || openedPreview !== entry) return;
    // Acknowledge only the event present when opened, never later updates.
    state.read[String(task.id)] = task.agent_event_id; saveSoon(); renderTasks();
  } catch (error) {
    if (openedPreview === entry) { openedPreview = undefined; renderSelected(); }
    throw error;
  }
}
function updatePreview(): void {
  const entry = openedPreview;
  if (!entry) return;
  const task = active?.notes.find(t => t.id === entry.data.task.id);
  if (!task || !visible(task)) { openedPreview = undefined; void api.updatePreview(entry.token, null).catch(e => report(message(e))); return; }
  const data = { ...entry.data, task, markdown: active?.config.markdownPreview !== false };
  if (JSON.stringify(data) === JSON.stringify(entry.data)) return;
  entry.data = data;
  void api.updatePreview(entry.token, data).catch(e => report(message(e)));
}
api.onPreviewClosed((token, editRequested) => {
  const entry = openedPreview;
  if (!entry || entry.token !== token) return;
  openedPreview = undefined; renderSelected();
  if (closing) return;
  const task = active?.notes.find(t => t.id === entry.data.task.id);
  if (editRequested && task && visible(task)) void track(edit(task));
  else if (document.hasFocus()) {
    const source = entry.source.isConnected ? entry.source : rowNodes.get(entry.data.task.id)?.querySelector<HTMLElement>('[data-row-element="preview"]');
    (source ?? composer).focus({ preventScroll: true });
  }
});
async function edit(task: Task): Promise<void> {
  // A detached editor still owns its pending save; never open a second writer.
  if (closedEdits.has(task.id)) {
    await closedEdits.get(task.id);
    task = active?.notes.find(t => t.id === task.id) ?? task;
  }
  const configuredFields = await api.agentFields().catch(() => [] as string[]);
  task = active?.notes.find(t => t.id === task.id) ?? task;
  if (closing) return;
  const existing = layers.find(l => l.kind === 'edit' && l.taskId === task.id); if (existing) { existing.panel.focus(); return; }
  const id = String(task.id), modal = layer(`Edit task ${task.id}`, 'edit', task.id);
  modal.panel.classList.add('task-editor');
  const draft = state.edits[id] ?? { text: task.text, revision: task.updated_at };
  let revision = draft.revision, savedText = task.text, tag = task.tag;
  let paused = !!state.edits[id], conflict = false, saving = false, detached = false, draining = false;
  let queuedTag = state.edits[id]?.pendingTag, queuedFolder = state.edits[id]?.pendingTagFolder, queuedFolderIfNew = state.edits[id]?.pendingTagFolderIfNew;
  let work: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const editorHost = el('div', undefined, 'edit-text');
  const changed = () => {
    if (readonly || closing || conflict) return;
    retain(); check(); clearTimeout(timer);
    if (!paused) timer = setTimeout(() => { void track(save()); }, 650);
  };
  const editor = new MarkdownEditor(editorHost, draft.text, 'Task text', false, changed, () => { void track(retry().then(() => { if (!paused && !conflict && !readonly && !dirty()) modal.close(); })); }, file => storeImage(file));
  liveEditors.add(editor);
  // Configured fields are offered even without a value; clearing a value removes the field.
  const savedFields = new Map(Object.entries(task.agent_notes)), draftFields = new Map(Object.entries(draft.fields ?? {}));
  const fieldInputs = new Map<string, HTMLTextAreaElement>();
  const fieldList = el('div', undefined, 'edit-fields'); fieldList.setAttribute('role', 'group'); fieldList.setAttribute('aria-label', 'Agent fields');
  fieldList.append(el('h3', 'Agent fields'));
  for (const name of new Set([...configuredFields, ...savedFields.keys(), ...draftFields.keys()])) {
    const input = el('textarea'); input.rows = 1; input.spellcheck = false; input.placeholder = 'Not set';
    input.value = draftFields.get(name) ?? savedFields.get(name) ?? ''; input.setAttribute('aria-label', `Agent field ${name}`);
    input.addEventListener('input', changed);
    const row = el('label'), label = el('span', name); label.title = name; row.append(label, input); fieldList.append(row); fieldInputs.set(name, input);
  }
  fieldList.hidden = !fieldInputs.size;
  // Values are kept verbatim (Markdown indentation matters); only a blank value means removal.
  const pendingFields = (): Record<string, string> => Object.fromEntries([...fieldInputs].map(([name, input]) => [name, input.value.trim() ? input.value : '']).filter(([name, value]) => value !== (savedFields.get(name) ?? '')));
  const dirty = () => editor.value !== savedText || queuedTag !== undefined || Object.keys(pendingFields()).length > 0;
  const warning = el('p', undefined, 'warning'); warning.setAttribute('role', 'status');
  const status = el('span', undefined, 'edit-status'); status.setAttribute('role', 'status');
  const tagControl = button('tag', 'Change tag', () => tagsMenu('task', task, async (name, folder, folderIfNew) => {
    // Choosing a tag is an explicit retry, so a failed tag change can be corrected.
    if (readonly || closing || conflict) return false;
    queuedTag = name; queuedFolder = folder; queuedFolderIfNew = folderIfNew; paused = false;
    // The picker may outlive the debounce and accept this while text is already
    // in flight. Journal it now, even if that earlier write fails.
    retain(); check();
    await save();
    return !paused && !conflict && queuedTag === undefined;
  }));
  tagControl.className = 'edit-tag'; tagControl.setAttribute('aria-haspopup', 'dialog');
  const tagName = el('span'); tagControl.append(tagName, el('span', '▾', 'tag-chevron'));
  const header = modal.panel.querySelector('header')!;
  header.querySelector('h2')!.textContent = `Edit task #${task.id}`;
  header.insertBefore(tagControl, header.lastChild);
  const footer = el('div', undefined, 'edit-footer');
  const feedback = el('div', undefined, 'edit-feedback');
  feedback.append(status, el('span', 'Autosave · Enter: newline', 'edit-hint'));
  const actions = el('div', undefined, 'controls');
  const undoButton = button('undo', 'Undo text edit (Ctrl+Z)', () => { undo(editor.view); editor.view.focus(); check(); });
  const retryButton = button('save', 'Retry saving changes (Ctrl+Enter)', () => retry());
  actions.append(retryButton, undoButton, button('copy', 'Copy edit draft', () => api.copy(editor.value)));
  footer.append(feedback, actions);
  function retain(): void {
    state.edits[id] = { text: editor.value, revision,
      ...(queuedTag !== undefined ? { pendingTag: queuedTag } : {}),
      ...(queuedFolder !== undefined ? { pendingTagFolder: queuedFolder } : {}),
      ...(queuedFolderIfNew !== undefined ? { pendingTagFolderIfNew: queuedFolderIfNew } : {}),
      ...(Object.keys(pendingFields()).length ? { fields: pendingFields() } : {}),
    };
    saveSoon();
  }
  function check(): void {
    const current = active?.notes.find(t => t.id === task.id);
    if (!saving && (!current || current.updated_at !== revision)) conflict = true;
    const locked = readonly || closing || conflict;
    editor.readOnly = locked;
    for (const input of fieldInputs.values()) input.readOnly = locked;
    tagName.textContent = (queuedTag === undefined ? tag : queuedTag) ?? 'Untagged';
    tagControl.title = `Change tag: ${tagName.textContent}${queuedTag === undefined ? '' : ' (not saved)'}`; tagControl.setAttribute('aria-label', tagControl.title);
    // Stays enabled while saving: a tag picked during an autosave is queued behind it.
    tagControl.disabled = readonly || closing || conflict;
    undoButton.disabled = readonly || closing || conflict || !undoDepth(editor.view.state);
    retryButton.hidden = !paused || conflict || readonly;
    retryButton.disabled = saving || closing;
    warning.hidden = !readonly && !conflict && !paused;
    warning.textContent = readonly ? 'Saving paused. Copy your text and resolve the recovery notice before retrying.'
      : conflict ? 'Task changed elsewhere. Local changes kept; copy your text, then close and use draft recovery to reconcile with the latest task.'
      : paused ? 'Local changes kept. Review them, then retry saving. Nothing is retried automatically.' : '';
    status.textContent = readonly || conflict ? 'Saving paused' : saving ? 'Saving…' : paused ? 'Not saved — retry' : dirty() ? 'Unsaved changes' : 'All changes saved';
    status.classList.toggle('saved', !readonly && !conflict && !saving && !paused && !dirty());
    if (readonly || conflict) clearTimeout(timer);
  }
  async function retry(): Promise<void> {
    if (readonly || closing || conflict) return;
    paused = false; await save();
  }
  function save(): Promise<void> {
    clearTimeout(timer);
    if (work) return work;
    if (readonly || (closing && !draining) || conflict || paused) return Promise.resolve();
    if (!dirty() && state.edits[id]) { delete state.edits[id]; saveSoon(); }
    work = (async () => {
      while (!readonly && (!closing || draining) && !conflict && !paused && dirty()) {
        const text = editor.value, textChanged = text !== savedText, nextTag = queuedTag, folder = queuedFolder, folderIfNew = queuedFolderIfNew, base = revision;
        // One revision-bound write per pass: text, then tag, then agent fields.
        const tagChanged = !textChanged && nextTag !== undefined, fields = pendingFields(), wasRead = !unread(task);
        retain(); saving = true; check();
        const result = textChanged
          ? await call('edit', { id: task.id, revision: base, text }, draining)
          : !tagChanged
            ? await call('agent', { id: task.id, revision: base, fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value || null])) }, draining)
          : folder !== undefined
            ? await call('create_tag', { id: task.id, revision: base, name: nextTag!, folder, ...(folderIfNew !== undefined ? { folderIfNew } : {}) }, draining)
            : await call('tag', { id: task.id, revision: base, tag: nextTag! }, draining);
        if (!result) { paused = true; break; }
        // Never infer a committed revision from a later snapshot: another client
        // may have changed the task between our commit and that read.
        if (!result.revision) {
          paused = true;
          report('Backend did not acknowledge the saved revision. Local changes kept; update the backend and reconcile before retrying.');
          conflict = true; break;
        }
        revision = result.revision; editEpoch++;
        if (textChanged) savedText = text;
        else if (!tagChanged) for (const [name, value] of Object.entries(fields)) { if (value) savedFields.set(name, value); else savedFields.delete(name); }
        else {
          tag = result.tag ?? nextTag!;
          if (queuedTag === nextTag && queuedFolder === folder && queuedFolderIfNew === folderIfNew) { queuedTag = undefined; queuedFolder = undefined; queuedFolderIfNew = undefined; }
        }
        // Your own field edit is not an unread agent update, even if a newer snapshot already replaced this revision.
        if (!textChanged && !tagChanged && wasRead && result.agentEvent !== undefined) state.read[id] = Math.max(state.read[id] ?? 0, result.agentEvent);
        const current = active?.notes.find(t => t.id === task.id);
        if (current && (current.updated_at === base || current.updated_at === revision)) {
          current.updated_at = revision; current.text = savedText.replace(/\r\n/g, '\n').trim(); current.tag = tag;
          if (!textChanged && !tagChanged) { current.agent_notes = Object.fromEntries(savedFields); current.agent_event_id = result.agentEvent ?? current.agent_event_id; }
          task = current;
        }
        if (!dirty()) delete state.edits[id]; else retain();
        saveSoon(); saving = false; check();
        renderTasks();
      }
    })().catch(e => { paused = true; report(message(e)); }).finally(() => {
      saving = false; work = undefined; check();
      if (detached && (paused || conflict)) report('Editor closed with unsaved local changes. Use Menu → Recover edit drafts.');
    });
    return work;
  }
  const flush = async () => { await editor.imagesSettled(); draining = true; await save(); };
  editFlushers.add(flush);
  const close = modal.close;
  modal.close = () => {
    if (detached) return;
    detached = true; close(); clearTimeout(timer);
    const done = track(flush().finally(() => { editor.destroy(); liveEditors.delete(editor); editFlushers.delete(flush); closedEdits.delete(task.id); void pruneImages(); }));
    closedEdits.set(task.id, done);
  };
  modal.panel.append(warning, editorHost, fieldList, footer); modal.update = check; check(); fitWindow(); editor.view.focus();
}
function recoverDrafts(): void {
  const modal = layer('Recover edit drafts');
  const list = el('div', undefined, 'scroll'); modal.panel.append(list);
  const draw = () => {
    list.replaceChildren();
    for (const [id, draft] of Object.entries(state.edits)) {
      const row = el('article', undefined, 'aux-row');
      row.append(el('h3', `Task ${id}`), el('p', `Revision: ${draft.revision}`, 'metadata'));
      if (draft.pendingTag !== undefined) row.append(el('p', `Pending tag: ${draft.pendingTag ?? 'Untagged'}`, 'metadata'));
      if (draft.pendingTagFolder !== undefined) row.append(el('p', `New tag folder: ${draft.pendingTagFolderIfNew ?? draft.pendingTagFolder ?? 'None'}`, 'metadata'));
      for (const [name, value] of Object.entries(draft.fields ?? {})) row.append(el('p', `Pending agent field ${name}: ${value || '(removed)'}`, 'metadata'));
      const text = el('textarea', undefined, 'recovery-text'); text.value = draft.text; text.readOnly = true; text.setAttribute('aria-label', `Private draft for task ${id}`); row.append(text);
      const bar = controls(row);
      bar.append(button('copy', 'Copy private draft', () => api.copy(draft.text)), button('edit', 'Open revision-bound editor', () => {
        const task = active?.notes.find(t => String(t.id) === id);
        if (task) return edit(task);
        report('This task is not active. Copy its private draft here, or restore the task from Archive first.');
      }), button('trash', 'Discard private draft', () => confirmAction('Discard draft?', `Discard the private text for task ${id}? No task will be changed.`, async () => {
        if (closedEdits.has(Number(id))) { report('This editor is still saving. Wait for it to finish before discarding local text.'); return; }
        delete state.edits[id]; saveSoon(); draw(); void pruneImages();
      }), readonly));
      list.append(row);
    }
    if (!Object.keys(state.edits).length) list.append(el('p', 'No private edit drafts.'));
  };
  draw();
}
function schedule(task: Task): void {
  const modal = layer(`Reminder for task ${task.id}`, 'schedule', task.id);
  const when = field('When (local time)', localInput(task.remind_at ?? new Date())); when.input.type = 'datetime-local'; modal.panel.append(when.wrapper);
  const bar = controls(modal.panel);
  bar.append(button('save', 'Set reminder', async () => {
    const result = await call('schedule', { ...target(task), when: when.input.value });
    if (result) { modal.close(); await refresh(); }
  }, readonly));
  if (task.state === 'scheduled') bar.append(button('reset', 'Release reminder now', async () => { const result = await call('transition', { ...target(task), action: 'restore', state: task.state }); if (result) { modal.close(); await refresh(); } }, readonly));
  when.input.focus();
}
function localInput(value: string | Date): string {
  const date = new Date(value); const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type TagMode = 'creation' | 'filter' | 'task';
function counts(name: string): string {
  const tasks = active?.notes.filter(t => (t.tag ?? '') === name) ?? [];
  return `(${tasks.length})${tasks.some(isProgress) ? ` ▶ ${tasks.filter(isProgress).length}` : ''}`;
}
function tagsMenu(mode: TagMode, task?: Task, selectTag?: (tag: string | null, folder?: string | null, folderIfNew?: string) => Promise<boolean>): void {
  const menu = layer(mode === 'filter' ? 'Filter by tag' : mode === 'creation' ? 'New-task tag' : 'Task tag', 'tags', task?.id);
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search or create tag…'; search.setAttribute('aria-label', 'Search tags');
  const list = el('div', undefined, 'tag-list scroll');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', mode === 'filter' ? 'Tag filters' : 'Tags');
  menu.panel.append(search, list);
  const choose = async (name: string) => {
    if (mode === 'filter') {
      if (state.filters === null) state.filters = ['', ...(active?.tags.map(t => t.name) ?? [])];
      state.filters = state.filters.includes(name) ? state.filters.filter(t => t !== name) : [...state.filters, name]; saveSoon(); renderTasks(); renderToolbar(); draw();
    } else if (mode === 'creation') { creationTag = name || null; saveSoon(); renderToolbar(); menu.close(); composer.focus(); }
    else if (selectTag) { if (await selectTag(name || null)) { menu.close(); await refresh(); } }
    else if (task) { const result = await call('tag', { ...target(task), tag: name || null }); if (result) { menu.close(); await refresh(); } }
  };
  let lastDraw = '';
  function draw(): void {
    const query = search.value.trim(), lower = query.toLocaleLowerCase();
    const key = JSON.stringify([query, active?.tags, active?.notes.map(t => [t.tag, t.state]), state.filters, creationTag]);
    if (lastDraw === key) return; lastDraw = key;
    const top = list.scrollTop;
    const focusedTag = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.tag : undefined;
    list.replaceChildren();
    // The backend orders tags by newest associated task, oldest first.
    const names = [...(active?.tags.map(t => t.name) ?? [])].reverse();
    names.push('');
    // Preserve unknown saved selections until the registry catches up or the user clears them.
    for (const selected of state.filters ?? []) if (!names.includes(selected)) names.push(selected);
    for (const name of names) {
      if (lower && !(name || 'Untagged').toLocaleLowerCase().includes(lower)) continue;
      const selected = mode === 'filter' ? state.filters === null || state.filters.includes(name) : mode === 'creation' ? (creationTag ?? '') === name : (task?.tag ?? '') === name;
      const count = active?.notes.filter(t => (t.tag ?? '') === name).length ?? 0;
      if (mode === 'filter' && !query && !count && !selected && name !== focusedTag) continue;
      const b = button('tag', `${name || 'Untagged'} ${counts(name)}`, () => choose(name), mode === 'task' && readonly);
      b.className = `tag-choice${selected ? ' chosen' : ''}`; b.dataset.tag = name;
      b.append(el('span', `${name || 'Untagged'} ${counts(name)}`));
      if (mode === 'filter') { b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(selected)); b.prepend(el('span', selected ? '☑' : '☐')); }
      b.addEventListener('contextmenu', e => { e.preventDefault(); manageTags(name || undefined); });
      list.append(b);
    }
    if (query && !active?.tags.some(t => t.name.toLocaleLowerCase() === lower)) {
      list.append(textButton(`Create tag “${query}”…`, () => newTag(query, async name => {
        if (mode === 'creation') { creationTag = name; saveSoon(); renderToolbar(); menu.close(); }
        else if (mode === 'task') menu.close();
        else draw();
      }, mode === 'task' && !selectTag ? task : undefined, selectTag ? (name, folder, folderIfNew) => selectTag(name, folder, folderIfNew) : undefined)));
    }
    if (focusedTag !== undefined) Array.from(list.querySelectorAll<HTMLButtonElement>('button')).find(b => b.dataset.tag === focusedTag)?.focus({ preventScroll: true });
    list.scrollTop = top;
  }
  menu.update = draw;
  if (mode === 'filter') {
    const bar = controls(menu.panel); bar.append(button('all', 'Select all tags', () => { selectAll(); draw(); }), button('clear', 'Clear selection (in-progress only)', () => { state.filters = []; saveSoon(); renderTasks(); renderToolbar(); draw(); }));
  }
  search.addEventListener('input', draw);
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') { e.preventDefault(); const items = list.querySelectorAll<HTMLButtonElement>('button'); if (e.key === 'Enter') items[0]?.click(); else items[e.key === 'ArrowUp' ? items.length - 1 : 0]?.focus(); }
  });
  list.addEventListener('keydown', e => {
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>('button'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); search.focus(); search.value += e.key; draw(); }
    else if (e.key === 'Backspace') { e.preventDefault(); search.focus(); search.value = search.value.slice(0, -1); draw(); }
  });
  draw(); search.focus();
}
function newTag(prefill = '', after?: (name: string) => unknown, attachTask?: Task, create?: (name: string, folder: string | null, folderIfNew?: string) => Promise<boolean>): void {
  const modal = layer('New tag'); const name = field('Name', prefill); modal.panel.append(name.wrapper);
  // With a base folder, a new tag's folder follows its name until one is chosen or cleared.
  // The backend creates and saves it only if the tag is new, so an existing tag keeps its folder;
  // the preview's existing-tag match is approximate (the backend uses full case folding).
  let folder: string | null = null, follow = state.tagBaseFolder !== undefined;
  const existing = (tag: string) => { const lower = savedTagName(tag)?.toLowerCase(); return active?.tags.find(t => t.name.toLowerCase() === lower); };
  const autoFolder = (tag: string) => state.tagBaseFolder === undefined || existing(tag) ? null : tagFolderPath(state.tagBaseFolder, tag);
  const folderLabel = el('p', undefined, 'folder-path'), folderHint = el('p', 'Created if missing when you create the tag.', 'tag-hint');
  const showFolder = () => {
    const match = follow ? existing(name.input.value) : undefined, shown = match ? match.folder : follow ? autoFolder(name.input.value) : folder;
    folderLabel.textContent = shown ?? 'No default folder'; folderLabel.title = shown ?? ''; folderHint.hidden = !follow || !!match || !shown;
  };
  name.input.addEventListener('input', showFolder);
  modal.panel.append(folderLabel, folderHint); modal.update = showFolder; showFolder();
  const bar = controls(modal.panel); let saving = false;
  bar.append(button('folder', 'Choose default Kitty folder', async () => { const chosen = await api.chooseFolder(); if (chosen) { folder = chosen; follow = false; showFolder(); } }),
    button('clear', 'Clear default folder', () => { folder = null; follow = false; showFolder(); }),
    button('save', 'Create tag', async () => {
      if (saving) return; saving = true;
      try {
        // The name is read once so the folder always matches the tag submitted.
        const typed = name.input.value, chosen = follow ? null : folder;
        const folderIfNew = follow && state.tagBaseFolder !== undefined ? tagFolderPath(state.tagBaseFolder, typed) ?? undefined : undefined;
        if (create) {
          // The editor journals and serializes creation plus assignment as one
          // revision-bound operation, including when the app starts closing.
          if (await create(typed, chosen, folderIfNew)) { await refresh(); modal.close(); await after?.(typed.trim()); }
          return;
        }
        const result = await call('create_tag', { name: typed, folder: chosen, ...(folderIfNew ? { folderIfNew } : {}), ...(attachTask ? target(attachTask) : {}) });
        if (result) { await refresh(); const savedName = result.tag ?? typed.trim(); modal.close(); await after?.(savedName); }
      } finally { saving = false; }
    }, readonly));
  name.input.focus();
}
function manageTags(selected?: string): void {
  const modal = layer('Manage tags', 'manage-tags'); modal.panel.classList.add('manage-tags');
  const layout = el('div', undefined, 'tag-layout'), sidebar = el('div', undefined, 'tag-sidebar');
  const searchBar = el('div', undefined, 'tag-search'), search = el('input');
  search.type = 'search'; search.placeholder = 'Find tag…'; search.setAttribute('aria-label', 'Find saved tag');
  const create = button('add', 'Create saved tag', () => newTag('', name => { selected = name; search.value = ''; draw(); }));
  searchBar.append(search, create);
  const count = el('p', undefined, 'tag-hint'), list = el('div', undefined, 'tag-list scroll');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Saved tags');
  const baseSection = el('section', undefined, 'tag-base'), baseRow = el('div', undefined, 'tag-base-header'), basePath = el('p', undefined, 'folder-path');
  const setBase = (next: string | undefined) => save(async () => {
    const previous = state.tagBaseFolder; state.tagBaseFolder = next;
    try { await persist(); } catch (error) { state.tagBaseFolder = previous; throw error; }
  });
  baseRow.append(el('p', 'Base folder', 'tag-editor-label'), button('folder', 'Choose base folder for new tags', async () => { const chosen = await api.chooseFolder(); if (chosen !== null) await setBase(chosen); }),
    button('clear', 'Clear base folder', () => setBase(undefined)));
  baseSection.append(baseRow, basePath, el('p', 'New tags default to a folder named after the tag inside it.', 'tag-hint'));
  sidebar.append(searchBar, count, list, el('p', 'Tags stay saved without tasks.', 'tag-hint'), baseSection);
  const editor = el('div', undefined, 'tag-editor'); layout.append(sidebar, editor); modal.panel.append(layout);
  selected ??= active?.tags[0]?.name;
  let lastDraw = '', listSelection: string | undefined, editorTag: string | undefined, folderPath: HTMLElement | undefined, saving = false;
  const showSelection = () => {
    const chosen = list.querySelector<HTMLElement>('.chosen'); if (!chosen) return;
    const row = chosen.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  };
  window.addEventListener('resize', showSelection);
  const close = modal.close;
  modal.close = () => { window.removeEventListener('resize', showSelection); close(); };
  const save = async (action: () => Promise<void>) => {
    if (saving || readonly) return;
    saving = true; draw();
    try { await action(); } finally { saving = false; draw(); }
  };
  const drawEditor = (tag?: Tag) => {
    editor.replaceChildren(); folderPath = undefined;
    if (!tag) { editor.append(el('p', 'Select a tag to edit its name and default Kitty folder.', 'empty')); return; }
    editor.append(el('h3', tag.name));
    const name = field('Tag name', tag.name), nameRow = el('div', undefined, 'tag-name-row');
    nameRow.append(name.wrapper, button('save', 'Rename tag', () => save(async () => {
      const result = await call('rename_tag', { name: tag.name, newName: name.input.value });
      if (result) {
        const next = result.tag ?? name.input.value.trim();
        if (creationTag === tag.name) creationTag = next;
        if (state.filters) state.filters = state.filters.map(t => t === tag.name ? next : t);
        saveSoon(); selected = next; search.value = ''; await refresh();
      }
    })));
    editor.append(nameRow, el('p', 'Renaming updates this tag on every task.', 'tag-hint'));
    const folder = el('section', undefined, 'tag-folder'), folderRow = el('div', undefined, 'tag-folder-row');
    folderPath = el('p', undefined, 'folder-path');
    folderRow.append(folderPath, button('folder', 'Set default Kitty folder', () => save(async () => {
      const chosen = await api.chooseFolder(); if (chosen === null) return;
      if (await call('tag_folder', { name: tag.name, folder: chosen })) await refresh();
    })), button('clear', 'Clear default Kitty folder', () => save(async () => {
      if (await call('tag_folder', { name: tag.name, folder: null })) await refresh();
    })));
    folder.append(el('p', 'Default Kitty folder', 'tag-editor-label'), folderRow,
      el('p', 'Used by “Start in Kitty…”. Folder changes apply immediately.', 'tag-hint'));
    const danger = el('div', undefined, 'tag-danger'), explanation = el('div');
    explanation.append(el('p', 'Delete saved tag', 'tag-editor-label'), el('p', 'Clears it from tasks. Tasks and history stay.', 'tag-hint'));
    danger.append(explanation, button('trash', 'Delete saved tag…', () => confirmAction('Delete tag?', `Delete “${tag.name}” and clear it from every task? Tasks and history are kept.`, () => save(async () => {
      const result = await call('delete_tag', { name: tag.name });
      if (result) {
        if (creationTag === tag.name) creationTag = null;
        if (state.filters) { state.filters = state.filters.filter(t => t !== tag.name); if (!state.filters.length) state.filters = null; }
        saveSoon(); selected = undefined; await refresh();
      }
    }))));
    editor.append(folder, danger);
  };
  const draw = () => {
    const tags = active?.tags ?? [], query = search.value.trim().toLocaleLowerCase();
    const matches = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query));
    count.textContent = query ? `${matches.length} of ${tags.length} saved tags` : `Saved tags · ${tags.length}`;
    const key = JSON.stringify([tags.map(tag => tag.name), selected, query]);
    if (key !== lastDraw) {
      lastDraw = key;
      const focused = list.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null;
      const top = list.scrollTop; list.replaceChildren();
      for (const tag of matches) {
        const b = button('tag', tag.name, () => { selected = tag.name; draw(); });
        b.append(el('span', tag.name)); b.className = `tag-choice${selected === tag.name ? ' chosen' : ''}`;
        b.setAttribute('aria-pressed', String(selected === tag.name)); list.append(b);
        if (focused === tag.name) b.focus();
      }
      if (!matches.length) list.append(el('p', tags.length ? 'No matching tags.' : 'No saved tags. Use + to create one.', 'empty'));
      list.scrollTop = top;
      if (listSelection !== selected) { listSelection = selected; showSelection(); }
    }
    const tag = tags.find(tag => tag.name === selected);
    // Polling updates folder metadata, but never replaces a name being edited.
    if (editorTag !== tag?.name || !editor.childElementCount) { editorTag = tag?.name; drawEditor(tag); }
    if (folderPath) { folderPath.textContent = tag?.folder ?? 'No default folder'; folderPath.title = tag?.folder ?? ''; }
    basePath.textContent = state.tagBaseFolder ?? 'No base folder'; basePath.title = state.tagBaseFolder ?? '';
    for (const b of baseRow.querySelectorAll('button')) b.disabled = readonly || saving || !stateLoaded;
    create.disabled = readonly || saving; search.disabled = saving;
    for (const b of list.querySelectorAll('button')) b.disabled = saving;
    for (const b of editor.querySelectorAll('button')) b.disabled = readonly || saving;
    const input = editor.querySelector('input'); if (input) input.readOnly = readonly || saving;
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); list.querySelector<HTMLButtonElement>('button')?.focus(); }
  });
  list.addEventListener('keydown', e => {
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  });
  modal.update = draw; draw(); search.focus(); fitWindow();
}
function configureWatchers(): void {
  const existing = layers.find(l => l.kind === 'watchers'); if (existing) { existing.panel.focus(); return; }
  const modal = layer('Watchers', 'watchers'); modal.panel.classList.add('manage-tags', 'watchers');
  const layout = el('div', undefined, 'tag-layout'), sidebar = el('div', undefined, 'tag-sidebar'), editor = el('div', undefined, 'tag-editor watcher-editor');
  const searchBar = el('div', undefined, 'tag-search'), search = el('input');
  search.type = 'search'; search.placeholder = 'Find watcher…'; search.setAttribute('aria-label', 'Find watcher');
  const count = el('p', undefined, 'tag-hint'), list = el('div', undefined, 'tag-list scroll');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Watchers');
  const footer = el('div', undefined, 'watcher-footer'), status = el('p', 'Loading watchers…', 'tag-hint'); status.setAttribute('role', 'status');
  let settings: WatcherSettings | undefined, draft: Watcher[] = [], selected: string | undefined, busy = false, note = '', error = '';
  let refreshEditor = () => {};
  const empty = (value: WatcherValue | undefined) => value === undefined || value === '' || Array.isArray(value) && !value.length;
  // Rows left blank in a list are not saved.
  const entry = (w: Watcher): WatcherEntry => ({ path: w.path, enabled: w.enabled, appEvents: w.appEvents, taskEvents: w.taskEvents, fieldEvents: w.fieldEvents, fields: w.fields,
    timeoutSeconds: w.timeoutSeconds, cooldownSeconds: w.cooldownSeconds,
    params: Object.fromEntries(Object.entries(w.params).map(([key, value]) => [key, Array.isArray(value) ? value.filter(row => Object.keys(row).length) : value] as const).filter(([, value]) => !empty(value))) });
  const dirty = () => !!settings && JSON.stringify(draft.map(entry)) !== JSON.stringify(settings.watchers.map(entry));
  const limitLabels = { timeoutSeconds: 'Time limit', cooldownSeconds: 'Cooldown' } as const;
  const problem = (w: Watcher) => {
    const missing = w.spec.find(param => param.required && empty(entry(w).params[param.key]));
    const limit = (Object.keys(WATCHER_LIMITS) as (keyof typeof WATCHER_LIMITS)[]).find(key => !Number.isInteger(w[key]) || w[key] < WATCHER_LIMITS[key].min || w[key] > WATCHER_LIMITS[key].max);
    return missing ? `Needs parameter: ${missing.label}` : limit ? `${limitLabels[limit]} must be a whole number of seconds from ${WATCHER_LIMITS[limit].min} to ${WATCHER_LIMITS[limit].max}` : w.problem && !/^(Needs|Invalid) parameter/.test(w.problem) ? w.problem : undefined;
  };
  const load = async () => {
    try {
      settings = await api.watcherSettings(); draft = structuredClone(settings.watchers);
      if (!draft.some(w => w.id === selected)) selected = draft[0]?.id;
    } catch (error) { settings = undefined; draft = []; note = `Could not load watchers: ${ipcMessage(error)}`; }
    draw();
  };
  const add = button('add', 'Add watcher script…', async () => {
    if (!settings || busy) return;
    try {
      const chosen = await api.chooseWatcher(); if (!chosen) return;
      const known = draft.find(w => w.path === chosen.path);
      if (!known && draft.length >= 32) { error = 'At most 32 watchers can be configured.'; update(); return; }
      if (!known) draft.push(chosen);
      selected = (known ?? chosen).id; note = ''; search.value = ''; draw();
    } catch (reason) { error = ipcMessage(reason); update(); }
  });
  const revert = button('reset', 'Discard unsaved watcher changes', () => { if (!settings || busy) return; draft = structuredClone(settings.watchers); note = ''; draw(); });
  const save = button('save', 'Save watcher settings…', async () => {
    if (!settings || busy || !dirty()) return;
    busy = true; error = ''; update();
    try { if (await api.saveWatchers(draft.map(entry), settings.raw)) { note = 'Saved.'; await load(); } }
    catch (reason) { error = ipcMessage(reason); }
    finally { busy = false; update(); }
  });
  searchBar.append(search, add); sidebar.append(searchBar, count, list, el('p', 'Trusted code, not sandboxed. Runs while Pinote is open.', 'tag-hint'));
  footer.append(status, revert, save); layout.append(sidebar, editor); modal.panel.append(layout, footer);
  const checks = (title: string, names: readonly string[], chosen: string[]) => {
    const group = el('div', undefined, 'watcher-events'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', title);
    for (const name of names) {
      const label = el('label', undefined, 'setting-toggle'), input = el('input'); input.type = 'checkbox'; input.checked = chosen.includes(name);
      input.addEventListener('change', () => {
        // Keep the declared order whatever the click order.
        const next = names.filter(n => n === name ? input.checked : chosen.includes(n)); chosen.splice(0, chosen.length, ...next); update();
      });
      label.append(input, el('span', name)); group.append(label);
    }
    return [el('p', title, 'tag-editor-label'), group];
  };
  const parameter = (w: Watcher, param: WatcherParam): HTMLElement => {
    const box = el('div', undefined, 'watcher-param'), current = w.params[param.key];
    const set = (value: WatcherValue | undefined) => {
      for (const target of param.configKey ? draft : [w]) {
        const key = target === w ? param.key : target.spec.find(other => other.configKey === param.configKey)?.key;
        if (!key) continue;
        if (value === undefined) delete target.params[key]; else target.params[key] = target === w ? value : structuredClone(value);
      }
      update();
    };
    const title = `${param.label}${param.required ? ' *' : ''}`;
    if (param.type === 'boolean') {
      const label = el('label', undefined, 'setting-toggle'), input = el('input'); input.type = 'checkbox'; input.checked = current === true;
      input.addEventListener('change', () => set(input.checked)); label.append(input, el('span', title)); box.append(label);
    } else if (param.type === 'select') {
      const label = el('label', title), select = el('select');
      for (const option of ['', ...param.options ?? []]) { const node = el('option', option || 'Select…'); node.value = option; select.append(node); }
      select.value = typeof current === 'string' && param.options?.includes(current) ? current : '';
      select.addEventListener('change', () => set(select.value || undefined)); label.append(select); box.append(label);
    } else if (param.type === 'list') {
      const rows = Array.isArray(current) ? current : [];
      box.append(el('p', title, 'tag-editor-label'));
      rows.forEach((row, index) => {
        const line = el('div', undefined, 'watcher-row');
        for (const column of param.columns ?? []) {
          const input = el('input'); input.value = row[column.key] ?? ''; input.placeholder = column.label; input.setAttribute('aria-label', `${column.label} ${index + 1}`);
          input.addEventListener('input', () => { if (input.value) row[column.key] = input.value; else delete row[column.key]; set(rows); });
          line.append(input);
        }
        line.append(button('trash', `Remove ${param.label} row ${index + 1}`, () => { rows.splice(index, 1); set(rows); draw(); }));
        box.append(line);
      });
      const more = el('div', undefined, 'watcher-row');
      more.append(button('add', `Add ${param.label} row`, () => { if (rows.length < 64) { rows.push({}); set(rows); draw(); } }), el('span', `Add to ${param.label}`, 'tag-hint'));
      box.append(more);
    } else {
      const line = el('div', undefined, 'watcher-row'), named = field(title, current === undefined ? '' : String(current));
      if (param.type === 'number') named.input.type = 'number';
      named.input.addEventListener('input', () => {
        const value = named.input.value;
        set(value === '' ? undefined : param.type === 'number' ? Number.isFinite(Number(value)) ? Number(value) : undefined : value);
      });
      line.append(named.wrapper);
      if (param.type === 'directory') line.append(button('folder', `Choose ${param.label}`, async () => {
        const chosen = await api.chooseFolder(); if (chosen === null) return;
        named.input.value = chosen; set(chosen);
      }));
      box.append(line);
    }
    if (param.help) box.append(el('p', param.help, 'tag-hint'));
    return box;
  };
  const drawEditor = (w?: Watcher) => {
    editor.replaceChildren(); refreshEditor = () => {};
    if (!w) { editor.append(el('p', settings ? 'Select a watcher, or add a script with +.' : '', 'empty')); return; }
    const issue = el('p', undefined, 'watcher-problem'), toggle = el('label', undefined, 'setting-toggle'), enabled = el('input');
    enabled.type = 'checkbox'; toggle.append(enabled, el('span', 'Enabled while Pinote is open'));
    enabled.addEventListener('change', () => { w.enabled = enabled.checked; update(); });
    refreshEditor = () => {
      const text = problem(w); issue.textContent = text ?? ''; issue.hidden = !text;
      enabled.checked = w.enabled; enabled.disabled = busy || !!text && !w.enabled;
    };
    const chips = el('div', undefined, 'watcher-chips'), input = el('input'), options = el('datalist');
    options.id = 'watcher-field-names'; input.setAttribute('list', options.id); input.placeholder = 'Add field…'; input.setAttribute('aria-label', 'Add field');
    for (const name of settings?.fieldNames ?? []) if (!w.fields.includes(name)) { const option = el('option'); option.value = name; options.append(option); }
    const addField = () => {
      const name = input.value.normalize('NFC').trim();
      if (!name || name.length > 128 || w.fields.length >= 64) return;
      if (!w.fields.includes(name)) w.fields.push(name);
      draw(); editor.querySelector<HTMLInputElement>('.watcher-chips input')?.focus();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addField(); } });
    // Choosing a suggestion fills the input without a key press.
    input.addEventListener('change', addField);
    for (const name of w.fields) {
      const chip = el('span', name, 'watcher-chip');
      chip.append(button('close', `Remove field ${name}`, () => { w.fields.splice(w.fields.indexOf(name), 1); draw(); }));
      chips.append(chip);
    }
    chips.append(input, options);
    const limits = el('div', undefined, 'watcher-row');
    for (const key of Object.keys(WATCHER_LIMITS) as (keyof typeof WATCHER_LIMITS)[]) {
      const named = field(`${limitLabels[key]} (seconds)`, String(w[key]));
      Object.assign(named.input, { type: 'number', min: String(WATCHER_LIMITS[key].min), max: String(WATCHER_LIMITS[key].max), step: '1' });
      // Blank or invalid stays visible as a problem rather than silently becoming a default.
      named.input.addEventListener('input', () => { w[key] = named.input.value === '' ? NaN : Number(named.input.value); update(); });
      limits.append(named.wrapper);
    }
    editor.append(el('h3', w.name), el('p', `${w.bundled ? 'Bundled' : 'Custom'} · ${w.path}`, 'tag-hint watcher-path'),
      ...w.description ? [el('p', w.description)] : [], issue, toggle,
      ...checks('App events', APP_EVENTS, w.appEvents), el('p', 'startup: once each time Pinote starts.', 'tag-hint'),
      ...checks('Task events', TASK_EVENTS, w.taskEvents), ...checks('Field events', FIELD_EVENTS, w.fieldEvents),
      el('p', 'Fields', 'tag-editor-label'), chips,
      el('p', 'Field events: only these fields. Task events: only tasks that have one. Empty: all.', 'tag-hint'),
      el('p', 'Limits', 'tag-editor-label'), limits,
      el('p', 'Cooldown: the least time between two runs of this watcher; 0 for none. Events meanwhile wait.', 'tag-hint'));
    if (w.spec.length) editor.append(el('p', 'Parameters', 'tag-editor-label'), ...w.spec.map(param => parameter(w, param)));
    if (!w.bundled) {
      const danger = el('div', undefined, 'tag-danger'), explanation = el('div');
      explanation.append(el('p', 'Remove watcher', 'tag-editor-label'), el('p', 'The script file is kept.', 'tag-hint'));
      danger.append(explanation, button('trash', 'Remove watcher', () => { draft.splice(draft.indexOf(w), 1); selected = draft[0]?.id; draw(); }));
      editor.append(danger);
    }
    refreshEditor();
  };
  // Without rebuilding controls: typing must keep its focus.
  const update = () => {
    for (const row of list.querySelectorAll<HTMLElement>('[data-watcher]')) {
      const w = draft.find(item => item.id === row.dataset.watcher); if (!w) continue;
      const state = problem(w) ? 'needs attention' : w.enabled ? 'enabled' : 'disabled';
      row.querySelector('.watcher-dot')!.className = `watcher-dot ${problem(w) ? 'warn' : w.enabled ? 'on' : 'off'}`;
      row.title = `${w.name}: ${state}`; row.setAttribute('aria-label', row.title);
    }
    refreshEditor();
    // A failed save stays visible until the next attempt or selection.
    status.textContent = error || (dirty() ? 'Unsaved changes. Saving asks for confirmation.' : note);
    status.classList.toggle('watcher-problem', !!error);
    save.disabled = revert.disabled = busy || !dirty(); add.disabled = busy || !settings;
  };
  const draw = () => {
    const query = search.value.trim().toLocaleLowerCase(), matches = draft.filter(w => w.name.toLocaleLowerCase().includes(query));
    error = '';
    count.textContent = query ? `${matches.length} of ${draft.length} watchers` : `Watchers · ${draft.length} / 32`;
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.watcher : undefined;
    list.replaceChildren();
    for (const w of matches) {
      const b = button('preview', w.name, () => { selected = w.id; draw(); });
      b.replaceChildren(el('span', undefined, 'watcher-dot'), el('span', w.name));
      b.className = `tag-choice${selected === w.id ? ' chosen' : ''}`; b.dataset.watcher = w.id; b.setAttribute('aria-pressed', String(selected === w.id));
      list.append(b); if (focused === w.id) b.focus();
    }
    if (!matches.length && settings) list.append(el('p', draft.length ? 'No matching watchers.' : 'No watchers. Use + to add a script.', 'empty'));
    drawEditor(draft.find(w => w.id === selected)); update();
  };
  search.addEventListener('input', draw);
  list.addEventListener('keydown', e => {
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  });
  draw(); search.focus(); fitWindow(); void load();
}
function auxiliary(view: 'archive' | 'scheduled'): void {
  const existing = layers.find(l => l.kind === view); if (existing) { existing.panel.focus(); return; }
  const modal = layer(view === 'archive' ? 'Archive' : 'Scheduled reminders', view);
  let snapshot: Snapshot | null = null, days = 0, loading = false, signature = '';
  const expanded = new Set<number>();
  const list = el('div', undefined, 'aux-list scroll');
  if (view === 'archive') {
    const bar = controls(modal.panel);
    for (const [label, value] of [['All', 0], ['1d', 1], ['7d', 7]] as const) bar.append(textButton(label, () => { days = value; signature = ''; draw(); }));
  }
  modal.panel.append(list);
  function draw(): void {
    if (!snapshot) return;
    const notes = snapshot.notes.filter(t => !days || (t.archived_at && Date.parse(t.archived_at) >= Date.now() - days * 86400000));
    const nextKey = JSON.stringify([notes, [...expanded], days]); if (signature === nextKey) return; signature = nextKey;
    const top = list.scrollTop; list.replaceChildren();
    for (const task of notes) {
      const row = el('article', undefined, 'aux-row');
      const heading = el('div', undefined, 'aux-heading'); heading.append(el('span', compactTitle(task.text), 'task-title'), button(expanded.has(task.id) ? 'collapse' : 'expand', 'Expand/collapse full text', () => { if (expanded.has(task.id)) expanded.delete(task.id); else expanded.add(task.id); draw(); }));
      row.append(heading);
      const metadata = el('div', undefined, 'metadata'); metadata.append(el('span', view === 'archive' ? `${task.state === 'done' ? 'Completed' : 'Deleted'} · ${task.archived_at ? new Date(task.archived_at).toLocaleString() : ''}` : `${task.remind_at ? new Date(task.remind_at).toLocaleString() : ''}`));
      if (task.tag) metadata.append(tagBadge(task.tag));
      if (view === 'archive') metadata.append(button('reset', 'Restore task', () => transition(task, 'restore'), readonly || busyTasks.has(task.id)));
      else metadata.append(button('schedule', 'Change reminder time', () => schedule(task), readonly), button('reset', 'Release reminder now', () => transition(task, 'restore'), readonly));
      row.append(metadata);
      if (expanded.has(task.id)) { const body = el('div', undefined, 'preview'); fillPreview(body, task, { markdown: active?.config.markdownPreview !== false, openLink: url => { void api.openLink(url).catch(e => report(message(e))); } }); row.append(body); }
      list.append(row);
    }
    if (!notes.length) list.append(el('p', 'No tasks here.', 'empty')); list.scrollTop = top;
  }
  const update = async () => {
    if (loading || !layers.includes(modal)) return; loading = true;
    try { const result = await call('snapshot', { view }); if (result && layers.includes(modal)) { snapshot = result; draw(); } } finally { loading = false; }
  };
  // Called from the single refresh loop, so auxiliary reads never overlap themselves.
  modal.update = () => { void track(update()); };
  void track(update());
}
async function refresh(): Promise<void> {
  if (polling || closing) return;
  polling = true;
  const epoch = editEpoch;
  try {
    const next = await call('snapshot', { view: 'active' }); if (!next || epoch !== editEpoch) return;
    const old = active;
    if (old) {
      const oldTags = new Set(old.tags.map(t => t.name)), nextTags = new Set(next.tags.map(t => t.name));
      if (state.filters !== null) {
        const deletedSelection = state.filters.some(name => oldTags.has(name) && !nextTags.has(name));
        state.filters = state.filters.filter(name => !oldTags.has(name) || nextTags.has(name));
        for (const tag of next.tags) if (!oldTags.has(tag.name) && !state.filters.includes(tag.name)) state.filters.push(tag.name);
        if (deletedSelection && !state.filters.length) state.filters = null;
        if (deletedSelection || next.tags.some(t => !oldTags.has(t.name))) saveSoon();
      }
    }
    const missing = baseline && !document.hidden && !collapsed && old ? old.notes.filter(t => visible(t) && !next.notes.some(n => n.id === t.id)).map(t => t.id) : [];
    active = next;
    if (creationTag && !next.tags.some(t => t.name === creationTag)) { creationTag = null; saveSoon(); }
    for (const [id, revision] of marked) if (next.notes.find(t => t.id === id)?.updated_at !== revision) marked.delete(id);
    if (missing.length) { const done = await call('completions', { ids: missing }); for (const id of done ?? []) animateDone(id); }
    baseline = !document.hidden && !collapsed;
    // A restored row must cancel a still-running exit animation.
    for (const id of exiting) if (next.notes.some(t => t.id === id)) { exiting.delete(id); rowNodes.get(id)?.classList.remove('completed'); rowKeys.delete(id); }
    renderTasks(); renderToolbar();
    if (!scrollReady) { restoreScroll(); scrollReady = true; }
    for (const modal of [...layers]) modal.update?.();
  } finally { polling = false; }
}
document.addEventListener('keydown', e => {
  if (closing) { e.preventDefault(); return; }
  if (nativeMenuOpen || e.key !== 'Escape') return;
  e.preventDefault(); e.stopPropagation();
  if (layers.length) { layers[layers.length - 1].close(); return; }
  if (taskActions) { closeTaskActions(); return; }
  if (creationTag !== null) { creationTag = null; saveSoon(); renderToolbar(); return; }
  window.close();
});
function dismissOutsideActions(event: Event): void {
  if (taskActions && !rowNodes.get(taskActions.task.id)?.contains(event.target as Node)) closeTaskActions(false);
}
document.addEventListener('pointerdown', dismissOutsideActions, true);
document.addEventListener('focusin', dismissOutsideActions);
document.addEventListener('visibilitychange', () => { baseline = false; if (!document.hidden) void track(refresh()); });
window.addEventListener('focus', () => { if (!document.hidden) void track(refresh()); });
document.documentElement.addEventListener('pointerenter', () => { pointerInside = true; });
document.documentElement.addEventListener('pointerleave', () => { pointerInside = false; renderTasks(); });
window.addEventListener('blur', () => { closeTaskActions(false); });
checklist.addEventListener('mouseup', e => {
  const target = e.target as HTMLElement;
  if (target === checklist || target === ordinary || target === pinned || target.classList.contains('empty')) composer.focus();
});
function updateEditors(): void {
  for (const modal of layers) if (modal.kind === 'edit') modal.update?.();
}
function setClosing(value: boolean): void {
  closing = value;
  document.body.inert = value;
  checklist.inert = $('composer').inert = popupRoot.inert = notice.inert = value;
  composerEditor.readOnly = readonly || value; updateEditors();
}
api.onCloseRequested(() => {
  if (closing || closeRequested) return;
  closeRequested = true;
  // Pastes already accepted are stored and inserted before editors freeze and save.
  void Promise.all([...liveEditors].map(editor => editor.imagesSettled())).finally(() => { closeRequested = false; finishClosing(); });
});
function finishClosing(): void {
  if (closing) return;
  const focused = document.activeElement as HTMLElement | null;
  for (const flush of editFlushers) void track(flush());
  setClosing(true); clearTimeout(persistTimer);
  void (async () => {
    // Wait for user callbacks, not just their individual IPC calls. They may update drafts after the reply.
    while (pending.size) await Promise.allSettled([...pending]);
    // Read-only recovery may still contain newer, unsaved text. A failed save must block close.
    await persist(draftSaveFailed); await persistChain;
    await api.finishClose();
  })().catch(async e => {
    setClosing(false);
    let detail = message(e);
    try { await api.cancelClose(); } catch (error) { detail += `; could not cancel close: ${message(error)}`; }
    report(`Could not finish closing: ${detail}`);
    if (focused?.isConnected) focused.focus();
  });
}
async function init(): Promise<void> {
  composerEditor.readOnly = true;
  try { state = await api.loadState(); stateLoaded = true; if (state.warning) { readonly = true; report(`Read-only draft recovery: ${state.warning}`); } }
  catch (e) { readonly = true; report(`Read-only: local drafts could not be loaded: ${message(e)}. Existing state will not be overwritten.`); }
  creationTag = state.creationTag ?? null; collapsed = state.collapsed ?? false; checklist.hidden = collapsed;
  if (!readonly && !state.draft && state.composerStartAsMarkdown) setComposerDraft(newComposerDraft());
  else { composerEditor.setText(state.draft); composerEditor.view.dispatch({ selection: { anchor: state.draft.length } }); }
  composerEditor.readOnly = readonly;
  if (readonly) {
    composer.title = 'Read-only draft recovery: copy your text; existing state will not be overwritten.'; composer.setAttribute('aria-description', composer.title);
    recoveryWarning(state.warning);
  }
  resizeComposer(); renderToolbar();
  await refresh(); composerEditor.view.focus();
  // Removes images left unreferenced, for example by a crash before their task was saved.
  void pruneImages();
  setInterval(() => { if (!document.hidden && !closing) void track(refresh()); }, 1000);
}
void track(init()).catch(e => report(message(e)));
