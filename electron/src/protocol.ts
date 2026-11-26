export const PROTOCOL = 1;
export type View = 'active' | 'archive' | 'scheduled';
export type Task = {
  id: number; text: string; state: string; created_at: string; updated_at: string;
  tag: string | null; remind_at: string | null; reminder_due_at: string | null;
  archived_at: string | null; agent_notes: Record<string, string>; agent_event_id: number; pi_sessions: string[];
};
export type Tag = { name: string; folder: string | null; available?: boolean };
export type Snapshot = { notes: Task[]; tags: Tag[]; config: { maxVisibleNotes: number; markdownPreview: boolean; kittyStartPrompt: string } };
export type Target = { id: number; revision: string };
export type Mutation = { changed: boolean; id?: number; tag?: string; revision?: string; agentEvent?: number };
export type Operations = {
  handshake: { params: Record<string, never>; result: { version: string; protocol: number; database: string } };
  snapshot: { params: { view: View }; result: Snapshot };
  add: { params: { text: string; tag: string | null }; result: Mutation };
  edit: { params: Target & { text: string }; result: Mutation };
  transition: { params: Target & { action: 'start' | 'reset' | 'done' | 'rm' | 'restore'; state: string }; result: Mutation };
  tag: { params: Target & { tag: string | null }; result: Mutation };
  agent: { params: Target & { fields: Record<string, string | null> }; result: Mutation };
  schedule: { params: Target & { when: string }; result: Mutation };
  create_tag: { params: { name: string; folder: string | null; id?: number; revision?: string }; result: Mutation };
  rename_tag: { params: { name: string; newName: string }; result: Mutation };
  delete_tag: { params: { name: string }; result: Mutation };
  tag_folder: { params: { name: string; folder: string | null }; result: Mutation };
  completions: { params: { ids: number[] }; result: number[] };
  kitty: { params: Target & { directory: string; tabTitle?: string }; result: Mutation };
};
export type Operation = keyof Operations;
export type Result<T> = { protocol: 1; ok: true; result: T; warning?: string } | { protocol: 1; ok: false; error: { code: 'invalid' | 'conflict' | 'busy' | 'internal' | 'unknown'; message: string } };
export const TASK_ACTION_IDS = ['kitty','copy','start','done','archive','edit','schedule','tag','preview'] as const;
export type TaskActionId = typeof TASK_ACTION_IDS[number] | 'unmark';
export type TaskRowElementId = TaskActionId | 'task-tag' | 'task-text' | 'actions';
export const TASK_ACTION_STATES = ['active','in_progress','marked'] as const;
export type TaskActionState = typeof TASK_ACTION_STATES[number];
export type TaskActionPreferences = { order: TaskActionId[]; hidden: TaskActionId[]; row: TaskRowElementId[] };
export type TaskActionSettings = Record<TaskActionState, TaskActionPreferences>;
export type LegacyTaskActionId = Exclude<TaskActionId, 'preview'>;
export type LegacyTaskActionPreferences = { order: LegacyTaskActionId[]; hidden: LegacyTaskActionId[]; primary: LegacyTaskActionId };
export type LegacyPerStateTaskActionSettings = Record<TaskActionState, LegacyTaskActionPreferences>;
export type LegacyTaskActionSettings = { order: Exclude<LegacyTaskActionId, 'unmark'>[]; hidden: Exclude<LegacyTaskActionId, 'unmark'>[]; primary: Exclude<LegacyTaskActionId, 'unmark'> };
export const taskActionIds = (state: TaskActionState): TaskActionId[] => state === 'marked' ? [...TASK_ACTION_IDS.filter(id => id !== 'preview'), 'unmark', 'preview'] : [...TASK_ACTION_IDS];
const defaultTaskRow = (primary: TaskActionId): TaskRowElementId[] => [primary, 'task-tag', 'task-text', 'preview', 'actions'];
export const defaultTaskActions = (): TaskActionSettings => ({
  active: { order: taskActionIds('active'), hidden: [], row: defaultTaskRow('start') },
  in_progress: { order: taskActionIds('in_progress'), hidden: [], row: defaultTaskRow('done') },
  marked: { order: taskActionIds('marked'), hidden: [], row: defaultTaskRow('unmark') },
});
export function normalizeTaskActions(value?: TaskActionSettings | LegacyPerStateTaskActionSettings | LegacyTaskActionSettings): TaskActionSettings {
  if (!value) return defaultTaskActions();
  if ('order' in value) return {
    active: { order: [...value.order, 'preview'], hidden: [...value.hidden], row: defaultTaskRow(value.primary) },
    in_progress: { order: [...value.order, 'preview'], hidden: [...value.hidden], row: defaultTaskRow(value.primary === 'start' ? 'done' : value.primary) },
    marked: { order: [...value.order, 'unmark', 'preview'], hidden: [...value.hidden], row: defaultTaskRow('unmark') },
  };
  const clone = (preferences: TaskActionPreferences | LegacyTaskActionPreferences): TaskActionPreferences => ({
    order: 'row' in preferences ? [...preferences.order] : [...preferences.order, 'preview'],
    hidden: [...preferences.hidden],
    row: 'row' in preferences ? [...preferences.row] : defaultTaskRow(preferences.primary),
  });
  return { active: clone(value.active), in_progress: clone(value.in_progress), marked: clone(value.marked) };
}
// fields holds unsaved agent field values by name; an empty value removes the field.
export type EditDraft = { text: string; revision: string; pendingTag?: string | null; pendingTagFolder?: string | null; fields?: Record<string, string> };
export type UIState = {
  draft: string; filters: string[] | null; read: Record<string, number>;
  creationTag?: string | null; collapsed?: boolean; composerStartAsMarkdown?: boolean; kittyTabTitle?: string; tagBaseFolder?: string; scroll?: { ordinary: number; pinned: number };
  edits: Record<string, EditDraft>; warning: string; taskActions?: TaskActionSettings | LegacyPerStateTaskActionSettings | LegacyTaskActionSettings;
};
export const initialState = (): UIState => ({ draft: '', filters: [''], read: {}, edits: {}, warning: '' });
export type BackendApi = { [K in Exclude<Operation, 'handshake'>]: (params: Operations[K]['params']) => Promise<Result<Operations[K]['result']>> };
export type MenuPoint = { x: number; y: number };
export type MenuRequest = MenuPoint & { kind: 'app' };
export type MenuAction = 'archive' | 'scheduled' | 'manage-tags' | 'task-actions' | 'composer-settings' | 'watchers' | 'kitty-tabs' | 'window-settings' | 'backend-settings' | 'drafts' | 'close';
export const TASK_EVENTS = ['created', 'edited', 'tagged', 'started', 'completed', 'removed', 'restored', 'scheduled'] as const;
export const FIELD_EVENTS = ['added', 'changed', 'removed'] as const;
export type WatcherValue = string | number | boolean | Record<string, string>[];
export type WatcherParam = { key: string; label: string; type: 'string' | 'number' | 'boolean' | 'select' | 'directory' | 'list';
  options?: string[]; columns?: { key: string; label: string }[]; required?: boolean; help?: string;
  /** The value is one shared setting: every watcher declaring the same key shows and saves the same value. */
  configKey?: string };
export type WatcherEntry = { path: string; enabled: boolean; taskEvents: string[]; fieldEvents: string[]; fields: string[]; params: Record<string, WatcherValue> };
/** A script with its effective settings; `spec` is what its parameter file declares. */
export type Watcher = WatcherEntry & { id: string; name: string; bundled: boolean; spec: WatcherParam[]; description?: string; problem?: string };
export type WatcherSettings = { raw: string | null; watchers: Watcher[]; fieldNames: string[] };
export type KittyTabSettings = { raw: string | null; oneTaskPerTab: boolean };
/** Start in Kitty's tab name when none is saved; the backend expands the placeholders. */
export const DEFAULT_KITTY_TAB_TITLE = '{tag}{title:30}';
export const validKittyTabTitle = (value: string) => !!value.trim() && Array.from(value).length <= 256 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
export const validTagBaseFolder = (value: string) => value.length <= 4096 && value.startsWith('/') && !/[\p{Cc}\p{Cs}]/u.test(value);
/** The name the backend saves for a new tag (its validate_tag: Python strip, NFC, 64 code points); null if rejected. */
export function savedTagName(tag: string): string | null {
  if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(tag)) return null;
  const name = tag.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '').normalize('NFC');
  return name && Array.from(name).length <= 64 ? name : null;
}
/** A new tag's default folder inside the base folder, named after the tag ("/" becomes "-"); null when the name cannot be a tag or folder. */
export function tagFolderPath(base: string, tag: string): string | null {
  const name = savedTagName(tag)?.replaceAll('/', '-');
  return name && name !== '.' && name !== '..' ? `${base.replace(/\/+$/, '')}/${name}` : null;
}
/** Fixed start-up geometry in desktop coordinates; an omitted part restores the last one. */
export type WindowStartup = { position?: { x: number; y: number }; size?: { width: number; height: number } };
export type WindowSettings = { startup: WindowStartup; current: { x: number; y: number; width: number; height: number } };
export type BackendSettings = { switched: boolean; canSwitch: boolean; detail: string; version: string };
export type PreviewData = { task: Task; markdown: boolean; unread: boolean };
export type PreviewRequest = { token: number; data: PreviewData; point: MenuPoint };
export type PreviewApi = {
  load(): Promise<PreviewData>; ready(height: number): Promise<void>;
  action(action: 'copy' | 'edit' | 'close'): Promise<void>; openLink(url: string): Promise<void>;
  onUpdate(callback: (data: PreviewData) => void): void;
};
export type PinoteApi = BackendApi & {
  agentFields(): Promise<string[]>;
  backendSettings(): Promise<BackendSettings>;
  switchBackend(): Promise<boolean>;
  onBackendSwitchProgress(callback: (text: string) => void): void;
  openPreview(request: PreviewRequest): Promise<boolean>;
  updatePreview(token: number, data: PreviewData | null): Promise<void>;
  onPreviewClosed(callback: (token: number, edit: boolean) => void): void;
  popupMenu(request: MenuRequest): Promise<MenuAction | null>;
  loadState(): Promise<UIState>; saveState(state: UIState): Promise<void>; acknowledgeWarning(): Promise<boolean>;
  watcherSettings(): Promise<WatcherSettings>; chooseWatcher(): Promise<Watcher | null>;
  saveWatchers(watchers: WatcherEntry[], raw: string | null): Promise<boolean>;
  kittyTabSettings(): Promise<KittyTabSettings>; saveKittyTabSettings(oneTaskPerTab: boolean, raw: string | null): Promise<void>;
  windowSettings(): Promise<WindowSettings>; saveWindowSettings(startup: WindowStartup): Promise<void>;
  chooseFolder(): Promise<string | null>; createTagFolder(tag: string): Promise<string>; copy(text: string): Promise<void>; openLink(url: string): Promise<void>;
  collapse(collapsed: boolean): Promise<void>; fit(height: number): Promise<void>;
  onCloseRequested(callback: () => void): void; finishClose(): Promise<void>; cancelClose(): Promise<void>;
};
declare global { interface Window { pinote: PinoteApi; pinotePreview: PreviewApi } }
