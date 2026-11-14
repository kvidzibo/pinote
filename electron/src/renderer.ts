import type { Task, Tag, Snapshot, UIState, View, Operations, Operation, Result, MenuPoint, MenuRequest, MenuAction } from './protocol';
import { defaultTaskActions, initialState, normalizeTaskActions, TASK_ACTION_STATES } from './protocol';
import type { TaskActionId, TaskActionState } from './protocol';
// The optional frontend bundles markdown-it; raw HTML and resource loading are disabled.
import MarkdownIt from 'markdown-it';

type Token = { type: string; tag: string; nesting: number; content: string; children?: Token[]; attrs?: [string, string][] };
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const api = window.pinote;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ordinary = $('ordinary'), pinned = $('pinned'), checklist = $('checklist');
const composer = $<HTMLTextAreaElement>('draft');
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
let draftVersion = 0;
const editVersions = new Map<string, number>();
const busyTasks = new Set<number>();
const stayOrdinary = new Set<number>();
const icons = {
  add: 'list-add', edit: 'document-edit', save: 'document-save', copy: 'edit-copy',
  reset: 'document-revert', start: 'media-playback-start', done: 'task-complete',
  remove: 'archive', trash: 'edit-delete', folder: 'folder', tag: 'tag',
  filter: 'view-filter', clear: 'view-filter-clear', all: 'edit-select-all',
  preview: 'view-reveal', unread: 'view-reveal-unread', menu: 'open-menu',
  close: 'window-close', kitty: 'utilities-terminal', schedule: 'preferences-system-notifications',
  collapse: 'view-collapse', expand: 'view-expand', move: 'move', grip: 'drag-handle',
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
  void api.fit(layers.some(l => l.kind === 'task-actions') ? Math.max(480, height) : height).catch(e => console.error(message(e)));
}
function report(message: string): void {
  notice.replaceChildren(el('span', message));
  notice.hidden = false;
  if (readonly && state.warning) {
    if (message !== state.warning) notice.append(el('span', state.warning));
    notice.append(button('done', 'I checked saved tasks; enable writes', async () => {
      if (await api.acknowledgeWarning()) { readonly = false; state.warning = ''; composer.readOnly = false; notice.hidden = true; updateEditors(); renderTasks(); renderToolbar(); }
    }));
  } else notice.append(button('close', 'Dismiss notice', () => { notice.hidden = true; fitWindow(); }));
  fitWindow();
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function recoveryWarning(text: string, preserveDrafts = false): void {
  readonly = true; state.warning = text; composer.readOnly = true; updateEditors(); report(text); renderTasks(); renderToolbar();
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
let choosingFolder = false;
async function chooseFolder(): Promise<string | null> {
  choosingFolder = true;
  try { return await api.chooseFolder(); } finally { choosingFolder = false; }
}
function saveSoon(): void {
  if (readonly || closing) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { void persist().catch(() => undefined); }, 180);
}
function persist(recovery = false): Promise<void> {
  clearTimeout(persistTimer);
  if ((readonly && !recovery) || !stateLoaded) return Promise.resolve();
  const copy: UIState = JSON.parse(JSON.stringify(state));
  const work = persistChain.then(() => api.saveState(copy));
  persistChain = work.then(() => { draftSaveFailed = false; }, e => { draftSaveFailed = true; report(`Draft cache could not be saved: ${message(e)}. Keep this window open or copy your draft.`); });
  return work;
}
async function call<K extends Exclude<Operation, 'handshake'>>(name: K, params: Operations[K]['params']): Promise<Operations[K]['result'] | null> {
  const write = name !== 'snapshot' && name !== 'completions';
  if (write && (readonly || closing || !active)) { report('Read-only: writes are disabled until tasks and configuration load safely. Copy drafts to recover them.'); return null; }
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
  if (!composer.value) { composer.style.height = ''; fitWindow(); return; }
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(144, composer.scrollHeight + composer.offsetHeight - composer.clientHeight)}px`;
  fitWindow();
}
async function addTask(): Promise<void> {
  if (!composer.value.trim() || adding || readonly || closing) return;
  const text = composer.value, tag = creationTag, version = draftVersion;
  adding = true; renderToolbar();
  try {
    const result = await call('add', { text, tag });
    if (!result) return;
    if (version === draftVersion) { state.draft = ''; composer.value = ''; draftVersion++; resizeComposer(); saveSoon(); }
    // Commit success is independent of the following read/cache operations.
    scrollToId = result.id;
    await refresh(); showSaved(result.id);
  } finally { adding = false; renderToolbar(); if (!layers.length && !closing) composer.focus(); }
}
let adding = false;
let nativeMenuOpen = false;
let taskActions: { task: Task; source: HTMLElement } | undefined;
composer.addEventListener('input', () => { if (closing) return; state.draft = composer.value; draftVersion++; resizeComposer(); saveSoon(); });
composer.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void track(addTask()); }
});
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
    if (kind === 'task-actions') fitWindow();
  } };
  header.append(button('close', `Close ${title}`, item.close)); panel.append(header); overlay.append(panel); popupRoot.append(overlay); layers.push(item);
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) item.close(); });
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  panel.focus(); renderSelected(); return item;
}
function renderSelected(): void {
  for (const [id, row] of rowNodes) row.classList.toggle('selected', taskActions?.task.id === id || layers.some(l => l.taskId === id));
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
tagControl.addEventListener('contextmenu', e => { e.preventDefault(); creationTag = null; renderToolbar(); });
const filterControl = button('filter', 'Filter by tag', () => tagsMenu('filter'));
const filterCount = el('span'); filterControl.append(filterCount);
const collapseControl = button('collapse', 'Collapse checklist', async () => {
  const next = !collapsed; await api.collapse(next); collapsed = next; baseline = false; checklist.hidden = next; renderToolbar();
});
const moveControl = button('move', 'Drag to move window', () => undefined); moveControl.className = 'move-handle';
const menuControl = button('menu', 'Menu', openMenu); menuControl.setAttribute('aria-haspopup', 'menu');
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
    case 'filter': tagsMenu('filter'); break;
    case 'scheduled': auxiliary('scheduled'); break;
    case 'archive': auxiliary('archive'); break;
    case 'manage-tags': manageTags(); break;
    case 'task-actions': configureTaskActions(); break;
    case 'drafts': recoverDrafts(); break;
    case 'close': window.close(); break;
  }
}
function dueLabel(task: Task): string {
  const date = task.reminder_due_at ?? task.remind_at;
  if (!date) return '';
  const ms = Date.now() - Date.parse(date);
  const hours = Math.floor(Math.abs(ms) / 3600000);
  return `${ms >= 0 ? 'Due' : 'Reminder in'} ${hours ? `${hours} hour${hours === 1 ? '' : 's'}` : 'less than an hour'}${ms >= 0 ? ' ago' : ''} — ${new Date(date).toLocaleString()}`;
}
function makeRow(task: Task): HTMLElement {
  const row = el('article', undefined, `task-row${isProgress(task) ? ' progress' : ''}${marked.has(task.id) ? ' marked' : ''}`);
  row.dataset.id = String(task.id);
  const mark = marked.has(task.id);
  const primary = normalizeTaskActions(state.taskActions)[taskActionState(task)].primary;
  const action = taskAction(task, primary);
  const checkbox = button(action.icon, `Task ${task.id}: ${action.label}; right-click ${mark ? 'delete' : isProgress(task) ? 'reset' : 'mark for deletion'}`, () => runTaskAction(task, action.id), actionBlocked(task, action.id));
  checkbox.classList.add('checkbox');
  if (!mark) checkbox.classList.add(isProgress(task) ? 'in-progress-check' : 'empty-check');
  if (primary === (isProgress(task) ? 'done' : 'start') && !mark) {
    checkbox.setAttribute('role', 'checkbox'); checkbox.setAttribute('aria-checked', isProgress(task) ? 'mixed' : 'false');
  }
  checkbox.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (readonly || busyTasks.has(task.id)) return;
    if (mark) void track(transition(task, 'rm'));
    else if (isProgress(task)) void track(transition(task, 'reset'));
    else { marked.set(task.id, task.updated_at); renderTasks(); }
  });
  const title = el('span', task.text.split('\n')[0], 'task-title'); title.title = task.text; title.tabIndex = 0;
  title.addEventListener('contextmenu', e => { e.preventDefault(); openTaskActions(task, title); });
  title.addEventListener('keydown', e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openTaskActions(task, title); } });
  title.addEventListener('mouseup', event => {
    if (event.button !== 0 || nativeMenuOpen) return;
    const selection = window.getSelection()?.toString();
    if (selection) void api.copy(selection).catch(e => report(message(e)));
    composer.focus();
  });
  const content = el('div', undefined, 'task-content');
  content.append(checkbox, title);
  if (task.tag) content.append(tagBadge(task.tag));
  if (task.reminder_due_at || task.remind_at) content.append(button('schedule', dueLabel(task), () => schedule(task), readonly));
  // Always offer the eye, including titles whose ellipsis depends on window width.
  const actions = button('menu', `Actions for task ${task.id}`, event => openTaskActions(task, event.currentTarget as HTMLElement));
  content.append(button(unread(task) ? 'unread' : 'preview', unread(task) ? 'Unread agent update — click to view.' : 'Preview full task', () => preview(task)), actions);
  row.append(content);
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
  const ordinaryRows: HTMLElement[] = [], progressRows: HTMLElement[] = [];
  for (const task of active.notes) {
    if (!visible(task)) continue;
    wanted.add(task.id);
    const key = JSON.stringify([task, state.read[String(task.id)], marked.get(task.id), busyTasks.has(task.id), readonly, state.taskActions]);
    let row = rowNodes.get(task.id);
    // Keep the exit node until its timer finishes, even if busy clears before refresh.
    if (!row || (!exiting.has(task.id) && rowKeys.get(task.id) !== key)) { const next = makeRow(task); row?.replaceWith(next); row = next; rowNodes.set(task.id, row); rowKeys.set(task.id, key); }
    (isProgress(task) && !stayOrdinary.has(task.id) ? progressRows : ordinaryRows).push(row);
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
  reconcile(ordinary, ordinaryRows); reconcile(pinned, progressRows);
  if (!wanted.size && !exiting.size) {
    const empty = el('div', active.notes.length ? 'No tasks match this filter' : 'Add your first task below', 'empty');
    if (active.notes.length) empty.append(button('filter', 'Show all tasks', selectAll)); ordinary.append(empty);
  }
  checklist.classList.toggle('mixed', ordinaryRows.length > 0);
  pinned.hidden = !progressRows.length && !Array.from(pinned.children).some(n => exiting.has(Number((n as HTMLElement).dataset.id)));
  renderSelected(); fitWindow();
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
  const check = row.querySelector('button'); if (check) { check.setAttribute('aria-checked', 'true'); const image = check.querySelector('img'); if (image) image.src = `icons/${icons.done}-symbolic.svg`; }
  setTimeout(() => { if (!exiting.has(id) || rowNodes.get(id) !== row) return; exiting.delete(id); row.remove(); rowNodes.delete(id); rowKeys.delete(id); renderTasks(); }, 410);
}
async function transition(task: Task, action: 'start' | 'reset' | 'done' | 'rm' | 'restore'): Promise<void> {
  if (busyTasks.has(task.id)) return;
  busyTasks.add(task.id); renderTasks();
  try {
    const result = await call('transition', { ...target(task), action, state: task.state });
    if (!result) return;
    if (action === 'done' && result.changed) animateDone(task.id);
    if (action === 'start' && document.hasFocus()) stayOrdinary.add(task.id);
    if (action === 'reset') stayOrdinary.delete(task.id);
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
  renderSelected();
  if (restoreFocus && !closing) (opened.source.isConnected ? opened.source : composer).focus({ preventScroll: true });
}
function openTaskActions(task: Task, source: HTMLElement): void {
  const row = rowNodes.get(task.id);
  if (!row || closing || nativeMenuOpen || exiting.has(task.id)) return;
  closeTaskActions(false);
  taskActions = { task, source };
  const bar = el('div', undefined, 'task-actions');
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', `Actions for task ${task.id}: ${task.text.split('\n')[0]}`);
  const settings = normalizeTaskActions(state.taskActions)[taskActionState(task)];
  for (const id of settings.order) {
    if (settings.hidden.includes(id)) continue;
    const action = taskAction(task, id);
    bar.append(button(action.icon, action.label, () => runTaskAction(task, action.id), actionBlocked(task, action.id)));
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
  unmark: { icon: 'reset', label: 'Cancel deletion mark' },
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
  return id !== 'copy' && id !== 'edit' && (readonly || busyTasks.has(task.id));
}
function configureTaskActions(): void {
  const existing = layers.find(l => l.kind === 'task-actions');
  if (existing) { existing.panel.focus(); return; }
  const modal = layer('Task actions', 'task-actions');
  modal.panel.classList.add('action-settings');
  const draft = normalizeTaskActions(state.taskActions);
  let selected: TaskActionState = 'active';
  let dragging: TaskActionId | undefined, saving = false;
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
    selected = state; dragging = undefined; draw();
  }
  modal.panel.append(tabs, el('p', 'Drag to reorder (↑ / ↓ on a handle). Choose visible actions and one row button per tab.', 'settings-hint'), panel);
  const list = el('div', undefined, 'action-settings-list');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Task action preferences');
  const heading = el('div', undefined, 'action-setting headings');
  heading.append(el('span'), el('span', 'Action'), el('span', 'In menu'), el('span', 'Button'));
  panel.append(heading, list);
  const status = el('span', undefined, 'sr-only'); status.setAttribute('aria-live', 'polite'); modal.panel.append(status);
  const clearDrop = () => { for (const row of list.children) row.classList.remove('drop-before', 'drop-after'); };
  const move = (id: TaskActionId, to: number) => {
    const preferences = draft[selected];
    const from = preferences.order.indexOf(id);
    if (readonly || saving || from === to || to < 0 || to >= preferences.order.length) return;
    preferences.order.splice(from, 1); preferences.order.splice(to, 0, id);
    draw(id);
    status.textContent = `${actionChoice(id, selected).label}, position ${to + 1} of ${preferences.order.length}`;
  };
  const draw = (focus?: TaskActionId) => {
    const top = modal.panel.scrollTop;
    const preferences = draft[selected];
    tabButtons.forEach((tab, index) => {
      const chosen = TASK_ACTION_STATES[index] === selected;
      tab.setAttribute('aria-selected', String(chosen)); tab.tabIndex = chosen ? 0 : -1; tab.disabled = saving;
    });
    panel.setAttribute('aria-labelledby', `task-action-tab-${selected}`);
    reset.title = `Restore default actions for ${actionStateLabels[selected]}`; reset.setAttribute('aria-label', reset.title);
    list.replaceChildren();
    for (const id of preferences.order) {
      const choice = actionChoice(id, selected);
      const row = el('div', undefined, 'action-setting'); row.dataset.action = id;
      const handle = button('grip', `Reorder ${choice.label}`, () => undefined, readonly || saving);
      handle.className = 'action-drag'; handle.draggable = !readonly && !saving;
      handle.title = `Drag to reorder ${choice.label}; ↑ / ↓ to move`;
      handle.setAttribute('aria-description', 'Drag, or press Arrow Up or Arrow Down to reorder.');
      handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault(); move(id, preferences.order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1));
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
        const from = preferences.order.indexOf(dragging), rect = row.getBoundingClientRect();
        const at = preferences.order.indexOf(id) + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
        const moved = dragging; dragging = undefined; clearDrop(); move(moved, at > from ? at - 1 : at);
      });
      const label = el('span', undefined, 'action-name'), icon = el('img');
      icon.src = `icons/${icons[choice.icon]}-symbolic.svg`; icon.alt = '';
      label.append(icon, el('span', choice.label));
      const shown = el('input'); shown.type = 'checkbox'; shown.checked = !preferences.hidden.includes(id);
      shown.setAttribute('aria-label', `Show ${choice.label} in menu`); shown.title = `Show ${choice.label} in menu`;
      shown.disabled = readonly || saving;
      shown.addEventListener('change', () => { preferences.hidden = shown.checked ? preferences.hidden.filter(value => value !== id) : [...preferences.hidden, id]; });
      const primary = el('input'); primary.type = 'radio'; primary.name = 'task-row-action'; primary.checked = preferences.primary === id;
      primary.setAttribute('aria-label', `Use ${choice.label} as row button`); primary.title = `Use ${choice.label} as row button`;
      primary.disabled = readonly || saving;
      primary.addEventListener('change', () => { if (primary.checked) preferences.primary = id; });
      row.append(handle, label, shown, primary); list.append(row);
    }
    modal.panel.scrollTop = top;
    if (focus) {
      const handle = list.querySelector<HTMLButtonElement>(`[data-action="${focus}"] .action-drag`);
      handle?.focus({ preventScroll: true }); handle?.scrollIntoView({ block: 'nearest' });
    }
  };
  modal.panel.append(el('p', 'Includes existing tasks. Other tabs are unchanged. Hidden menu actions can still be row buttons.', 'settings-hint'));
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
async function runTaskAction(task: Task, action: TaskAction): Promise<void> {
  closeTaskActions();
  if (closing) return;
  if (!active?.notes.some(t => t.id === task.id && t.updated_at === task.updated_at)) { report('Task changed while its actions were open. Reopen them to use the latest version.'); return; }
  switch (action) {
    case 'kitty': await startKitty(task); break;
    case 'copy': await api.copy(task.text); break;
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
    const directory = folder && available !== false ? folder : await chooseFolder();
    if (!directory) return;
    // call() owns uncertain-outcome recovery; do not replace its acknowledgement action.
    await call('kitty', { ...target(task), directory });
  } finally { busyTasks.delete(task.id); renderTasks(); }
}

// Markdown tokens become only known DOM elements. No HTML, style, or event attributes are copied.
const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 's', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
function safeLink(value: string): boolean { try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol); } catch { return false; } }
function markdownDOM(text: string, parent: HTMLElement, firstLineHeading = true): void {
  if (active?.config.markdownPreview === false) { parent.append(el('pre', text, 'literal')); return; }
  const stack: HTMLElement[] = [parent];
  function tokens(items: Token[]): void {
    for (const token of items) {
      const top = () => stack[stack.length - 1];
      if (token.type === 'inline') { tokens(token.children ?? []); continue; }
      if (token.type === 'text' || token.type === 'html_inline' || token.type === 'html_block') { top().append(document.createTextNode(token.content)); continue; }
      if (token.type === 'softbreak' || token.type === 'hardbreak') { top().append(el('br')); continue; }
      if (token.type === 'image') { top().append(document.createTextNode(token.content || '(image)')); continue; }
      if (token.type === 'code_inline') { top().append(el('code', token.content)); continue; }
      if (token.type === 'fence' || token.type === 'code_block') { const pre = el('pre'); pre.append(el('code', token.content)); top().append(pre); continue; }
      if (token.type === 'hr') { top().append(el('hr')); continue; }
      if (token.type === 'link_open') {
        const url = token.attrs?.find(a => a[0] === 'href')?.[1] ?? '';
        const a = el('a');
        if (safeLink(url)) { a.href = url; a.title = url; a.addEventListener('click', e => { e.preventDefault(); void api.openLink(url).catch(err => report(message(err))); }); }
        top().append(a); stack.push(a); continue;
      }
      if (token.type === 'link_close') { if (stack.length > 1) stack.pop(); continue; }
      if (allowed.has(token.tag)) {
        if (token.nesting === 1) { const node = document.createElement(token.tag); top().append(node); stack.push(node); }
        else if (token.nesting === -1 && stack.length > 1) stack.pop();
      } else if (token.content) top().append(document.createTextNode(token.content));
    }
  }
  const parsed = markdown.parse(text, {}) as Token[];
  // A normal literal first line is a heading in the preview, without changing saved text.
  const first = text.split('\n')[0] ?? '';
  if (firstLineHeading && parsed[0]?.type === 'paragraph_open' && !/^\s*(?:[#>*+-]|\d+[.)])\s/.test(first)) {
    const split = text.indexOf('\n'), heading = el('h1');
    parent.append(heading); stack.push(heading);
    const line = markdown.parse(first, {}) as Token[];
    tokens(line.find(t => t.type === 'inline')?.children ?? []); stack.pop();
    if (split >= 0) tokens(markdown.parse(text.slice(split + 1), {}) as Token[]);
  } else tokens(parsed);
}
function fillPreview(parent: HTMLElement, task: Task): void {
  parent.replaceChildren(); markdownDOM(task.text, parent);
  if (Object.keys(task.agent_notes).length || task.agent_event_id > 0) {
    const agent = el('section', undefined, 'agent'); agent.append(el('h3', 'Agent'));
    if (!Object.keys(task.agent_notes).length) agent.append(el('p', 'Agent fields were removed.'));
    for (const [key, value] of Object.entries(task.agent_notes)) { agent.append(el('h4', key)); const body = el('div'); markdownDOM(value, body, false); agent.append(body); }
    parent.append(agent);
  }
}
function preview(task: Task): void {
  const modal = layer(`Task ${task.id}`, 'preview', task.id), body = el('div', undefined, 'preview scroll');
  let current = task;
  const bar = controls(modal.panel); bar.append(button('copy', 'Copy note', () => api.copy(current.text)), button('edit', 'Edit text…', () => { modal.close(); edit(active?.notes.find(t => t.id === task.id) ?? task); })); modal.panel.append(body);
  const wasUnread = unread(task); state.read[String(task.id)] = task.agent_event_id; saveSoon(); renderTasks();
  fillPreview(body, current);
  modal.update = () => {
    const next = active?.notes.find(t => t.id === task.id);
    if (!next || !visible(next)) { modal.close(); return; }
    if (JSON.stringify(current) !== JSON.stringify(next)) { const scroll = body.scrollTop; current = next; fillPreview(body, next); body.scrollTop = scroll; }
    // Do not advance the read cursor for updates arriving in an already-open preview.
  };
  if (wasUnread) requestAnimationFrame(() => body.querySelector('.agent')?.scrollIntoView({ block: 'start' }));
}
function edit(task: Task): void {
  const existing = layers.find(l => l.kind === 'edit' && l.taskId === task.id); if (existing) { existing.panel.focus(); return; }
  const id = String(task.id), modal = layer(`Edit task ${task.id}`, 'edit', task.id);
  const draft = state.edits[id] ?? { text: task.text, revision: task.updated_at };
  const revision = draft.revision;
  const textarea = el('textarea', undefined, 'edit-text'); textarea.value = draft.text; textarea.setAttribute('aria-label', 'Task text'); textarea.spellcheck = false;
  const warning = el('p', undefined, 'warning');
  const check = () => {
    const current = active?.notes.find(t => t.id === task.id);
    const conflict = !current || current.updated_at !== revision;
    textarea.readOnly = readonly || closing || conflict;
    warning.textContent = readonly ? 'Read-only: local draft state could not be loaded safely. Copy your text; nothing will be overwritten.' : conflict ? 'This revision changed or left the active list. Your private draft is safe and read-only. Copy it, discard, then reopen the latest task to reconcile.' : 'Private draft. Enter inserts a newline; Ctrl+Enter saves text only.';
    save.disabled = readonly || closing || conflict || saving;
  };
  const retain = () => { if (!readonly && !closing) { state.edits[id] = { text: textarea.value, revision }; editVersions.set(id, (editVersions.get(id) ?? 0) + 1); saveSoon(); } };
  textarea.addEventListener('input', retain);
  let saving = false;
  const saveText = async () => {
    if (closing || save.disabled || saving) return;
    const text = textarea.value, version = editVersions.get(id) ?? 0;
    retain(); const submittedVersion = editVersions.get(id) ?? version;
    saving = true; check();
    try {
      const result = await call('edit', { id: task.id, revision, text });
      if (!result) return;
      // A committed response has no revision token. Resolve only by a fresh read;
      // never bind newer private text to someone else's revision.
      if ((editVersions.get(id) ?? 0) === submittedVersion) { delete state.edits[id]; saveSoon(); modal.close(); }
      else report('Text saved, but newer edits remain in a revision-bound private draft. Copy/reconcile them before saving again.');
      await refresh();
    } finally { saving = false; check(); }
  };
  const bar = controls(modal.panel);
  const save = button('save', 'Save text (Ctrl+Enter)', saveText);
  bar.append(button('copy', 'Copy edit draft', () => api.copy(textarea.value)), button('trash', 'Discard private draft', () => confirmAction('Discard draft?', 'Discard this private text without changing the task?', async () => {
    if (readonly) { report('Read-only draft store cannot be changed. Repair the local state before discarding.'); return; }
    delete state.edits[id]; editVersions.set(id, (editVersions.get(id) ?? 0) + 1); saveSoon(); modal.close();
  }), readonly), save);
  modal.panel.append(warning, textarea); modal.update = check; check(); textarea.focus();
  textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void track(saveText()); } });
}
function recoverDrafts(): void {
  const modal = layer('Private edit drafts');
  const list = el('div', undefined, 'scroll'); modal.panel.append(list);
  const draw = () => {
    list.replaceChildren();
    for (const [id, draft] of Object.entries(state.edits)) {
      const row = el('article', undefined, 'aux-row');
      row.append(el('h3', `Task ${id}`), el('p', `Revision: ${draft.revision}`, 'metadata'));
      const text = el('textarea', undefined, 'recovery-text'); text.value = draft.text; text.readOnly = true; text.setAttribute('aria-label', `Private draft for task ${id}`); row.append(text);
      const bar = controls(row);
      bar.append(button('copy', 'Copy private draft', () => api.copy(draft.text)), button('edit', 'Open revision-bound editor', () => {
        const task = active?.notes.find(t => String(t.id) === id);
        if (task) edit(task); else report('This task is not active. Copy its private draft here, or restore the task from Archive first.');
      }), button('trash', 'Discard private draft', () => confirmAction('Discard draft?', `Discard the private text for task ${id}? No task will be changed.`, async () => {
        delete state.edits[id]; editVersions.set(id, (editVersions.get(id) ?? 0) + 1); saveSoon(); draw();
      }), readonly));
      list.append(row);
    }
    if (!Object.keys(state.edits).length) list.append(el('p', 'No private edit drafts.'));
  };
  draw();
}
function schedule(task: Task): void {
  const modal = layer(`Reminder for task ${task.id}`, 'schedule', task.id);
  modal.panel.append(el('p', 'Enter local time as YYYY-MM-DD HH:MM. For ambiguous daylight-saving times, append an explicit offset (for example +02:00). The backend validates your exact input.'));
  const when = field('When (local time)', task.remind_at ? localInput(task.remind_at) : ''); modal.panel.append(when.wrapper);
  const bar = controls(modal.panel);
  bar.append(button('save', 'Set reminder', async () => {
    const result = await call('schedule', { ...target(task), when: when.input.value });
    if (result) { modal.close(); await refresh(); }
  }, readonly));
  if (task.state === 'scheduled') bar.append(button('reset', 'Release reminder now', async () => { const result = await call('transition', { ...target(task), action: 'restore', state: task.state }); if (result) { modal.close(); await refresh(); } }, readonly));
  when.input.focus();
}
function localInput(value: string): string {
  const date = new Date(value); const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type TagMode = 'creation' | 'filter' | 'task';
function counts(name: string): string {
  const tasks = active?.notes.filter(t => (t.tag ?? '') === name) ?? [];
  return `(${tasks.length})${tasks.some(isProgress) ? ` ▶ ${tasks.filter(isProgress).length}` : ''}`;
}
function tagsMenu(mode: TagMode, task?: Task): void {
  const menu = layer(mode === 'filter' ? 'Filter by tag' : mode === 'creation' ? 'New-task tag' : 'Task tag', 'tags', task?.id);
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search or create tag…'; search.setAttribute('aria-label', 'Search tags');
  const list = el('div', undefined, 'tag-list scroll');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', mode === 'filter' ? 'Tag filters' : 'Tags');
  menu.panel.append(search, list);
  const choose = async (name: string) => {
    if (mode === 'filter') {
      if (state.filters === null) state.filters = ['', ...(active?.tags.map(t => t.name) ?? [])];
      state.filters = state.filters.includes(name) ? state.filters.filter(t => t !== name) : [...state.filters, name]; saveSoon(); renderTasks(); renderToolbar(); draw();
    } else if (mode === 'creation') { creationTag = name || null; renderToolbar(); menu.close(); composer.focus(); }
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
        if (mode === 'creation') { creationTag = name; renderToolbar(); menu.close(); }
        else if (mode === 'task') menu.close();
        else draw();
      }, mode === 'task' ? task : undefined)));
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
function newTag(prefill = '', after?: (name: string) => unknown, attachTask?: Task): void {
  const modal = layer('New tag'); const name = field('Name', prefill); modal.panel.append(name.wrapper);
  let folder: string | null = null;
  const folderLabel = el('p', 'No default folder', 'folder-path'); modal.panel.append(folderLabel);
  const bar = controls(modal.panel); let saving = false;
  bar.append(button('folder', 'Choose default Kitty folder', async () => { const chosen = await chooseFolder(); if (chosen) { folder = chosen; folderLabel.textContent = chosen; } }),
    button('clear', 'Clear default folder', () => { folder = null; folderLabel.textContent = 'No default folder'; }),
    button('save', 'Create tag', async () => {
      if (saving) return; saving = true;
      try {
        const result = await call('create_tag', { name: name.input.value, folder, ...(attachTask ? target(attachTask) : {}) });
        if (result) { await refresh(); const savedName = result.tag ?? name.input.value.trim(); modal.close(); await after?.(savedName); }
      } finally { saving = false; }
    }, readonly));
  name.input.focus();
}
function manageTags(selected?: string): void {
  const modal = layer('Manage tags');
  const list = el('div', undefined, 'tag-list scroll'), editor = el('div'); modal.panel.append(list, editor);
  let lastDraw = '';
  const draw = () => {
    const key = JSON.stringify([active?.tags, selected]); if (lastDraw === key) return; lastDraw = key;
    list.replaceChildren();
    for (const tag of active?.tags ?? []) {
      const b = button('tag', tag.name, () => { selected = tag.name; draw(); drawEditor(tag); }); b.append(el('span', tag.name)); b.className = `tag-choice${selected === tag.name ? ' chosen' : ''}`; list.append(b);
    }
  };
  const drawEditor = (tag: Tag) => {
    editor.replaceChildren(); const name = field('Rename tag', tag.name); editor.append(name.wrapper, el('p', tag.folder ?? 'No default folder', 'folder-path'));
    const bar = controls(editor);
    bar.append(button('save', 'Rename tag', async () => {
      const result = await call('rename_tag', { name: tag.name, newName: name.input.value });
      if (result) {
        const next = result.tag ?? name.input.value.trim();
        if (creationTag === tag.name) creationTag = next;
        if (state.filters) state.filters = state.filters.map(t => t === tag.name ? next : t);
        saveSoon(); selected = next; await refresh(); draw(); const updated = active?.tags.find(t => t.name === next); if (updated) drawEditor(updated);
      }
    }, readonly), button('folder', 'Set default Kitty folder', async () => {
      const folder = await chooseFolder(); if (folder === null) return;
      const result = await call('tag_folder', { name: tag.name, folder }); if (result) { await refresh(); drawEditor(active?.tags.find(t => t.name === tag.name) ?? { ...tag, folder }); }
    }, readonly), button('clear', 'Clear default Kitty folder', async () => {
      const result = await call('tag_folder', { name: tag.name, folder: null }); if (result) { await refresh(); drawEditor({ ...tag, folder: null }); }
    }, readonly), button('trash', 'Delete saved tag…', () => confirmAction('Delete tag?', `Delete “${tag.name}” and clear it from every task? Tasks and history are kept.`, async () => {
      const result = await call('delete_tag', { name: tag.name });
      if (result) { if (creationTag === tag.name) creationTag = null; if (state.filters) { state.filters = state.filters.filter(t => t !== tag.name); if (!state.filters.length) state.filters = null; } saveSoon(); selected = undefined; editor.replaceChildren(); await refresh(); draw(); }
    }), readonly));
  };
  controls(modal.panel).append(button('add', 'Create saved tag', () => newTag('', name => { selected = name; draw(); const tag = active?.tags.find(t => t.name === name); if (tag) drawEditor(tag); }), readonly));
  modal.update = draw; draw(); const tag = active?.tags.find(t => t.name === selected); if (tag) drawEditor(tag);
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
      const heading = el('div', undefined, 'aux-heading'); heading.append(el('span', task.text.split('\n')[0], 'task-title'), button(expanded.has(task.id) ? 'collapse' : 'expand', 'Expand/collapse full text', () => { if (expanded.has(task.id)) expanded.delete(task.id); else expanded.add(task.id); draw(); }));
      row.append(heading);
      const metadata = el('div', undefined, 'metadata'); metadata.append(el('span', view === 'archive' ? `${task.state === 'done' ? 'Completed' : 'Deleted'} · ${task.archived_at ? new Date(task.archived_at).toLocaleString() : ''}` : `${task.remind_at ? new Date(task.remind_at).toLocaleString() : ''}`));
      if (task.tag) metadata.append(tagBadge(task.tag));
      if (view === 'archive') metadata.append(button('reset', 'Restore task', () => transition(task, 'restore'), readonly || busyTasks.has(task.id)));
      else metadata.append(button('schedule', 'Change reminder time', () => schedule(task), readonly), button('reset', 'Release reminder now', () => transition(task, 'restore'), readonly));
      row.append(metadata);
      if (expanded.has(task.id)) { const body = el('div', undefined, 'preview'); fillPreview(body, task); row.append(body); }
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
  try {
    const next = await call('snapshot', { view: 'active' }); if (!next) return;
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
      if (creationTag && oldTags.has(creationTag) && !nextTags.has(creationTag)) creationTag = null;
    }
    const missing = baseline && !document.hidden && !collapsed && old ? old.notes.filter(t => visible(t) && !next.notes.some(n => n.id === t.id)).map(t => t.id) : [];
    active = next;
    for (const [id, revision] of marked) if (next.notes.find(t => t.id === id)?.updated_at !== revision) marked.delete(id);
    if (missing.length) { const done = await call('completions', { ids: missing }); for (const id of done ?? []) animateDone(id); }
    baseline = !document.hidden && !collapsed;
    // A restored row must cancel a still-running exit animation.
    for (const id of exiting) if (next.notes.some(t => t.id === id)) { exiting.delete(id); rowNodes.get(id)?.classList.remove('completed'); rowKeys.delete(id); }
    renderTasks(); renderToolbar();
    for (const modal of [...layers]) modal.update?.();
  } finally { polling = false; }
}
document.addEventListener('keydown', e => {
  if (closing) { e.preventDefault(); return; }
  if (nativeMenuOpen || e.key !== 'Escape') return;
  e.preventDefault(); e.stopPropagation();
  if (layers.length) { layers[layers.length - 1].close(); return; }
  if (taskActions) { closeTaskActions(); return; }
  if (creationTag !== null) { creationTag = null; renderToolbar(); return; }
  window.close();
});
function dismissOutsideActions(event: Event): void {
  if (taskActions && !rowNodes.get(taskActions.task.id)?.contains(event.target as Node)) closeTaskActions(false);
}
document.addEventListener('pointerdown', dismissOutsideActions, true);
document.addEventListener('focusin', dismissOutsideActions);
document.addEventListener('visibilitychange', () => { baseline = false; if (!document.hidden) void track(refresh()); });
window.addEventListener('focus', () => { if (!document.hidden) void track(refresh()); });
window.addEventListener('blur', () => { closeTaskActions(false); if (!choosingFolder) { stayOrdinary.clear(); renderTasks(); } });
checklist.addEventListener('mouseup', e => {
  const target = e.target as HTMLElement;
  if (target === checklist || target === ordinary || target === pinned || target.classList.contains('empty')) composer.focus();
});
function updateEditors(): void {
  for (const modal of layers) if (modal.kind === 'edit') modal.update?.();
}
function setClosing(value: boolean): void {
  closing = value; document.body.inert = value; composer.readOnly = readonly || value; updateEditors();
}
api.onCloseRequested(() => {
  if (closing) return;
  const focused = document.activeElement as HTMLElement | null;
  setClosing(true); clearTimeout(persistTimer);
  void (async () => {
    // Wait for user callbacks, not just their individual IPC calls. They may update drafts after the reply.
    while (pending.size) await Promise.allSettled([...pending]);
    // Read-only recovery may still contain newer, unsaved text. A failed save must block close.
    await persist(draftSaveFailed); await persistChain;
    await api.finishClose();
  })().catch(async e => { setClosing(false); await api.cancelClose(); report(`Could not finish closing: ${message(e)}`); if (focused?.isConnected) focused.focus(); });
});
async function init(): Promise<void> {
  composer.disabled = true;
  try { state = await api.loadState(); stateLoaded = true; if (state.warning) { readonly = true; report(`Read-only draft recovery: ${state.warning}`); } }
  catch (e) { readonly = true; report(`Read-only: local drafts could not be loaded: ${message(e)}. Existing state will not be overwritten.`); }
  composer.value = state.draft; composer.disabled = false; composer.readOnly = readonly;
  if (readonly) {
    composer.title = 'Read-only draft recovery: copy your text; existing state will not be overwritten.'; composer.setAttribute('aria-description', composer.title);
    recoveryWarning(state.warning);
  }
  resizeComposer(); renderToolbar();
  await refresh(); composer.focus();
  setInterval(() => { if (!document.hidden && !closing) void track(refresh()); }, 1000);
}
void track(init()).catch(e => report(message(e)));
