import { TASK_ACTION_IDS, TASK_ACTION_STATES, taskActionIds, validKittyStartPrompt, validKittyTabTitle, validTagBaseFolder } from './protocol.ts';
import type { MenuRequest, Operation, PreviewData, PreviewRequest, UIState, WindowStartup } from './protocol.ts';

export const MAX_STATE_PAYLOAD_BYTES = 1024 * 1024;
// JSON escaping can use six bytes per warning code unit; reserve it separately from drafts.
export const MAX_STATE_FILE_BYTES = MAX_STATE_PAYLOAD_BYTES + 4096 * 6;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const id = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const str = (v: unknown, max = 16384) => typeof v === 'string' && v.length <= max;
const nullable = (v: unknown) => v === null || str(v);
/** Base64 of at most 4 MiB, the backend's stored image limit. */
export const MAX_IMAGE_BASE64 = Math.ceil(4 * 1024 * 1024 / 3) * 4;
export const imageHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const base64 = (v: unknown, max = MAX_IMAGE_BASE64) => typeof v === 'string' && v.length > 0 && v.length <= max && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
const imageMime = (v: unknown) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(v));
const fieldValue = (v: unknown) => str(v) || Array.isArray(v) && v.length <= 256 && [...v].every(item => str(item));
const agentFields = (v: unknown, removable = false) => record(v) && Object.keys(v).length <= 64 && Object.entries(v).every(([k, value]) => str(k, 256) && (removable && value === null || fieldValue(value)));
const specs: Record<Operation, Record<string, (v: unknown) => boolean>> = {
  handshake: {}, snapshot: { view: v => ['active', 'archive', 'scheduled'].includes(String(v)) },
  add: { text: str, tag: nullable }, edit: { id, revision: str, text: str },
  transition: { id, revision: str, state: v => ['active','in_progress','done','removed','scheduled'].includes(String(v)), action: v => ['start','reset','done','rm','restore'].includes(String(v)) },
  tag: { id, revision: str, tag: nullable }, agent: { id, revision: str, fields: v => agentFields(v, true) }, schedule: { id, revision: str, when: str },
  create_tag: { name: str, folder: nullable, folderIfNew: v => v === undefined || nullable(v), id: v => v === undefined || id(v), revision: v => v === undefined || str(v) },
  rename_tag: { name: str, newName: str }, delete_tag: { name: str }, tag_folder: { name: str, folder: nullable },
  completions: { ids: v => Array.isArray(v) && v.length <= 1000 && v.every(id) },
  kitty: { id, revision: str, directory: str, tabTitle: v => v === undefined || typeof v === 'string' && validKittyTabTitle(v),
    prompt: v => v === undefined || typeof v === 'string' && validKittyStartPrompt(v) },
  image_add: { data: v => base64(v) }, image: { hash: imageHash },
  image_prune: { keep: v => Array.isArray(v) && v.length <= 10000 && v.every(imageHash) },
};
export function validParams(op: unknown, value: unknown): op is Operation {
  if (typeof op !== 'string' || !Object.hasOwn(specs, op) || !record(value)) return false;
  const spec = specs[op as Operation];
  return Object.keys(value).every(k => Object.hasOwn(spec, k)) && Object.entries(spec).every(([k, check]) => check(value[k]));
}
export function validMenuRequest(value: unknown): value is MenuRequest {
  if (!record(value) || !['x', 'y'].every(k => typeof value[k] === 'number' && Number.isSafeInteger(value[k]) && value[k] >= 0 && value[k] <= 100000)) return false;
  return value.kind === 'app' && Object.keys(value).every(k => ['kind', 'x', 'y'].includes(k));
}
// Fixed start-up geometry: desktop coordinates and a size no smaller than the window minimum.
export const MIN_WINDOW = { width: 280, height: 120 };
export function validWindowStartup(value: unknown): value is WindowStartup {
  const ints = (v: unknown, keys: string[], min: (k: string) => number) => record(v) && Object.keys(v).length === keys.length &&
    keys.every(k => typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && v[k] >= min(k) && v[k] <= 100000);
  return record(value) && Object.keys(value).every(k => ['position', 'size'].includes(k)) &&
    (value.position === undefined || ints(value.position, ['x', 'y'], () => -100000)) &&
    (value.size === undefined || ints(value.size, ['width', 'height'], k => MIN_WINDOW[k as 'width' | 'height']));
}
export function validPreviewData(value: unknown): value is PreviewData {
  return record(value) && Object.keys(value).every(k => ['task','markdown','unread','fields'].includes(k)) &&
    validTask(value.task) && typeof value.markdown === 'boolean' && typeof value.unread === 'boolean' &&
    (value.fields === undefined || Array.isArray(value.fields) && value.fields.length <= 128 && [...value.fields].every(field => record(field) &&
      Object.keys(field).length === 3 && str(field.name, 256) && typeof field.link === 'boolean' && str(field.format, 4096))) &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_STATE_PAYLOAD_BYTES;
}
export function validPreviewRequest(value: unknown): value is PreviewRequest {
  return record(value) && Object.keys(value).every(k => ['token','data','point'].includes(k)) &&
    id(value.token) && validPreviewData(value.data) && record(value.point) && Object.keys(value.point).every(k => ['x','y'].includes(k)) &&
    validMenuRequest({ ...value.point, kind: 'app' });
}
export const mutating = (op: string) => !['handshake','snapshot','completions','image'].includes(op);
function validTaskActionPreferences(value: unknown, ids: readonly string[], legacy: boolean): boolean {
  const action = (v: unknown) => typeof v === 'string' && ids.includes(v);
  const uniqueList = (v: unknown, allowed: readonly string[]): v is string[] => Array.isArray(v) && v.length <= allowed.length &&
    [...v].every((entry, index) => Object.hasOwn(v, index) && typeof entry === 'string' && allowed.includes(entry)) && new Set(v).size === v.length;
  if (!record(value) || Object.keys(value).length !== 3 || !['order','hidden',legacy ? 'primary' : 'row'].every(k => Object.hasOwn(value, k))) return false;
  if (!uniqueList(value.order, ids) || value.order.length !== ids.length || !uniqueList(value.hidden, ids)) return false;
  return legacy ? action(value.primary) : uniqueList(value.row, [...ids, 'task-tag', 'task-text', 'actions']) &&
    value.row.includes('task-tag') && value.row.includes('task-text');
}
function validTaskActions(value: unknown): boolean {
  if (!record(value)) return false;
  if (Object.hasOwn(value, 'order')) return validTaskActionPreferences(value, TASK_ACTION_IDS.filter(id => id !== 'preview'), true);
  const active = value.active;
  const legacy = record(active) && Object.hasOwn(active, 'primary');
  return Object.keys(value).length === TASK_ACTION_STATES.length && TASK_ACTION_STATES.every(state =>
    Object.hasOwn(value, state) && validTaskActionPreferences(value[state], taskActionIds(state).filter(id => !legacy || id !== 'preview'), legacy));
}
export function validState(value: unknown): value is UIState {
  if (!record(value) || Object.keys(value).some(k => !['draft','filters','read','edits','warning','taskActions','creationTag','collapsed','scroll','composerStartAsMarkdown','kittyTabTitle','kittyStartPrompt','tagBaseFolder'].includes(k))) return false;
  if (Object.hasOwn(value, 'creationTag') && value.creationTag !== null && (typeof value.creationTag !== 'string' || !str(value.creationTag, 256) || !value.creationTag.length)) return false;
  if (Object.hasOwn(value, 'collapsed') && typeof value.collapsed !== 'boolean') return false;
  if (Object.hasOwn(value, 'composerStartAsMarkdown') && typeof value.composerStartAsMarkdown !== 'boolean') return false;
  if (Object.hasOwn(value, 'kittyTabTitle') && (typeof value.kittyTabTitle !== 'string' || !validKittyTabTitle(value.kittyTabTitle))) return false;
  if (Object.hasOwn(value, 'kittyStartPrompt') && (typeof value.kittyStartPrompt !== 'string' || !validKittyStartPrompt(value.kittyStartPrompt))) return false;
  if (Object.hasOwn(value, 'tagBaseFolder') && (typeof value.tagBaseFolder !== 'string' || !validTagBaseFolder(value.tagBaseFolder))) return false;
  const scroll = value.scroll;
  if (Object.hasOwn(value, 'scroll') && (!record(scroll) || Object.keys(scroll).length !== 2 ||
    !['ordinary','pinned'].every(k => typeof scroll[k] === 'number' && Number.isFinite(scroll[k]) && scroll[k] >= 0 && scroll[k] <= 100000000))) return false;
  if (Object.hasOwn(value, 'taskActions') && !validTaskActions(value.taskActions)) return false;
  if (!str(value.draft, 65536) || !str(value.warning, 4096)) return false;
  if (value.filters !== null && (!Array.isArray(value.filters) || value.filters.length > 10000 || !value.filters.every(v => str(v, 256)))) return false;
  if (!record(value.read) || !Object.entries(value.read).every(([k,v]) => /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return false;
  return record(value.edits) && Object.keys(value.edits).length <= 1000 && Object.entries(value.edits).every(([k,v]) => /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && record(v) && Object.keys(v).every(x => ['text','revision','pendingTag','pendingTagFolder','pendingTagFolderIfNew','fields'].includes(x)) && (!Object.hasOwn(v, 'fields') || agentFields(v.fields)) && str(v.text,65536) && str(v.revision,128) && (!Object.hasOwn(v, 'pendingTag') || v.pendingTag === null || str(v.pendingTag,256)) && (!Object.hasOwn(v, 'pendingTagFolder') || typeof v.pendingTag === 'string' && (v.pendingTagFolder === null || str(v.pendingTagFolder))) && (!Object.hasOwn(v, 'pendingTagFolderIfNew') || typeof v.pendingTag === 'string' && str(v.pendingTagFolderIfNew))) && Buffer.byteLength(JSON.stringify({ ...value, warning: '' })) <= MAX_STATE_PAYLOAD_BYTES;
}
export function safeLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return false;
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); } catch { return false; }
}
function validTask(value: unknown): boolean {
  if (!record(value) || !id(value.id) || !str(value.text) || !['active','in_progress','scheduled','done','removed'].includes(String(value.state))) return false;
  if (!str(value.created_at,128) || !str(value.updated_at,128) || !value.updated_at || !nullable(value.tag)) return false;
  if (!['remind_at','reminder_due_at','archived_at'].every(k => nullable(value[k]))) return false;
  if (!Array.isArray(value.pi_sessions) ||
    ![...value.pi_sessions].every(session => str(session,256) && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(session as string))) return false;
  return typeof value.agent_event_id === 'number' && Number.isSafeInteger(value.agent_event_id) && value.agent_event_id >= 0 && record(value.agent_notes) && Object.entries(value.agent_notes).every(([k,v]) => str(k,256) && fieldValue(v));
}
export function validEnvelope(operation: Operation, value: unknown): boolean {
  if (!record(value) || value.protocol !== 1 || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return record(value.error) && ['invalid','conflict','busy','internal','unknown'].includes(String(value.error.code)) && str(value.error.message,16384);
  const result = value.result;
  if (operation === 'completions') return Array.isArray(result) && result.every(id);
  if (!record(result)) return false;
  if (operation === 'image') return result.found === false ? Object.keys(result).length === 1 : result.found === true && imageMime(result.mime) && base64(result.data);
  if (operation === 'image_add') return typeof result.changed === 'boolean' && imageHash(result.hash) && imageMime(result.mime) && [result.width, result.height].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
  if (operation === 'image_prune') return typeof result.changed === 'boolean' && Array.isArray(result.removed) && result.removed.every(imageHash);
  if (operation === 'handshake') return result.protocol === 1 && str(result.version,128) && typeof result.database === 'string' && result.database.startsWith('/') && !/[\p{Cs}\x00]/u.test(result.database) && str(result.database);
  if (operation === 'snapshot') {
    return Array.isArray(result.notes) && result.notes.every(validTask) && Array.isArray(result.tags) && result.tags.every(tag => record(tag) && str(tag.name,256) && nullable(tag.folder) && (tag.available === undefined || typeof tag.available === 'boolean')) && record(result.config) && typeof result.config.maxVisibleNotes === 'number' && Number.isSafeInteger(result.config.maxVisibleNotes) && result.config.maxVisibleNotes > 0 && typeof result.config.markdownPreview === 'boolean';
  }
  if (typeof result.changed !== 'boolean' || (result.id !== undefined && !id(result.id)) || (result.tag !== undefined && !str(result.tag,256))) return false;
  if (Object.hasOwn(result, 'revision') && (typeof result.revision !== 'string' || !str(result.revision,128) || !result.revision || /[\p{C}\p{Z}]/u.test(result.revision.replaceAll(' ', '')))) return false;
  if (result.agentEvent !== undefined && !(typeof result.agentEvent === 'number' && Number.isSafeInteger(result.agentEvent) && result.agentEvent >= 0)) return false;
  // The editor needs the event to keep its own field edit from showing as unread.
  if (operation === 'agent') return id(result.id) && typeof result.revision === 'string' && typeof result.agentEvent === 'number';
  if (operation === 'add') return result.changed && id(result.id);
  return operation !== 'create_tag' || (typeof result.tag === 'string' && result.tag.length > 0);
}
