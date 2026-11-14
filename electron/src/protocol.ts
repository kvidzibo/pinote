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
export type Mutation = { changed: boolean; id?: number; tag?: string; revision?: string };
export type Operations = {
  handshake: { params: Record<string, never>; result: { version: string; protocol: number; database: string } };
  snapshot: { params: { view: View }; result: Snapshot };
  add: { params: { text: string; tag: string | null }; result: Mutation };
  edit: { params: Target & { text: string }; result: Mutation };
  transition: { params: Target & { action: 'start' | 'reset' | 'done' | 'rm' | 'restore'; state: string }; result: Mutation };
  tag: { params: Target & { tag: string | null }; result: Mutation };
  schedule: { params: Target & { when: string }; result: Mutation };
  create_tag: { params: { name: string; folder: string | null; id?: number; revision?: string }; result: Mutation };
  rename_tag: { params: { name: string; newName: string }; result: Mutation };
  delete_tag: { params: { name: string }; result: Mutation };
  tag_folder: { params: { name: string; folder: string | null }; result: Mutation };
  completions: { params: { ids: number[] }; result: number[] };
  kitty: { params: Target & { directory: string }; result: Mutation };
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
export type EditDraft = { text: string; revision: string; pendingTag?: string | null; pendingTagFolder?: string | null };
export type UIState = {
  draft: string; filters: string[] | null; read: Record<string, number>;
  creationTag?: string | null; collapsed?: boolean; composerStartAsMarkdown?: boolean; scroll?: { ordinary: number; pinned: number };
  edits: Record<string, EditDraft>; warning: string; taskActions?: TaskActionSettings | LegacyPerStateTaskActionSettings | LegacyTaskActionSettings;
};
export const initialState = (): UIState => ({ draft: '', filters: [''], read: {}, edits: {}, warning: '' });
export type BackendApi = { [K in Exclude<Operation, 'handshake'>]: (params: Operations[K]['params']) => Promise<Result<Operations[K]['result']>> };
export type MenuPoint = { x: number; y: number };
export type MenuRequest = MenuPoint & { kind: 'app' };
export type MenuAction = 'archive' | 'filter' | 'scheduled' | 'manage-tags' | 'task-actions' | 'composer-settings' | 'drafts' | 'close';
export type PreviewData = { task: Task; markdown: boolean; unread: boolean };
export type PreviewRequest = { token: number; data: PreviewData; point: MenuPoint };
export type PreviewApi = {
  load(): Promise<PreviewData>; ready(height: number): Promise<void>;
  action(action: 'copy' | 'edit' | 'close'): Promise<void>; openLink(url: string): Promise<void>;
  onUpdate(callback: (data: PreviewData) => void): void;
};
export type PinoteApi = BackendApi & {
  openPreview(request: PreviewRequest): Promise<boolean>;
  updatePreview(token: number, data: PreviewData | null): Promise<void>;
  onPreviewClosed(callback: (token: number, edit: boolean) => void): void;
  popupMenu(request: MenuRequest): Promise<MenuAction | null>;
  loadState(): Promise<UIState>; saveState(state: UIState): Promise<void>; acknowledgeWarning(): Promise<boolean>;
  chooseFolder(): Promise<string | null>; copy(text: string): Promise<void>; openLink(url: string): Promise<void>;
  collapse(collapsed: boolean): Promise<void>; fit(height: number): Promise<void>;
  onCloseRequested(callback: () => void): void; finishClose(): Promise<void>; cancelClose(): Promise<void>;
};
declare global { interface Window { pinote: PinoteApi; pinotePreview: PreviewApi } }
