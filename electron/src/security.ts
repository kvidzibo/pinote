import { TASK_ACTION_IDS, TASK_ACTION_STATES, taskActionIds } from './protocol.ts';
import type { MenuRequest, Operation, UIState } from './protocol.ts';

export const MAX_STATE_PAYLOAD_BYTES = 1024 * 1024;
// JSON escaping can use six bytes per warning code unit; reserve it separately from drafts.
export const MAX_STATE_FILE_BYTES = MAX_STATE_PAYLOAD_BYTES + 4096 * 6;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const id = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const str = (v: unknown, max = 16384) => typeof v === 'string' && v.length <= max;
const nullable = (v: unknown) => v === null || str(v);
const specs: Record<Operation, Record<string, (v: unknown) => boolean>> = {
  handshake: {}, snapshot: { view: v => ['active', 'archive', 'scheduled'].includes(String(v)) },
  add: { text: str, tag: nullable }, edit: { id, revision: str, text: str },
  transition: { id, revision: str, state: v => ['active','in_progress','done','removed','scheduled'].includes(String(v)), action: v => ['start','reset','done','rm','restore'].includes(String(v)) },
  tag: { id, revision: str, tag: nullable }, schedule: { id, revision: str, when: str },
  create_tag: { name: str, folder: nullable, id: v => v === undefined || id(v), revision: v => v === undefined || str(v) },
  rename_tag: { name: str, newName: str }, delete_tag: { name: str }, tag_folder: { name: str, folder: nullable },
  completions: { ids: v => Array.isArray(v) && v.length <= 1000 && v.every(id) },
  kitty: { id, revision: str, directory: str },
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
export const mutating = (op: string) => !['handshake','snapshot','completions'].includes(op);
function validTaskActionPreferences(value: unknown, ids: readonly string[]): boolean {
  const action = (v: unknown) => typeof v === 'string' && ids.includes(v);
  const actions = (v: unknown): v is unknown[] => Array.isArray(v) && v.length <= ids.length &&
    [...v].every((entry, index) => Object.hasOwn(v, index) && action(entry)) && new Set(v).size === v.length;
  return record(value) && Object.keys(value).length === 3 && ['order','hidden','primary'].every(k => Object.hasOwn(value, k)) &&
    actions(value.order) && value.order.length === ids.length && actions(value.hidden) && action(value.primary);
}
function validTaskActions(value: unknown): boolean {
  if (!record(value)) return false;
  if (Object.hasOwn(value, 'order')) return validTaskActionPreferences(value, TASK_ACTION_IDS);
  return Object.keys(value).length === TASK_ACTION_STATES.length && TASK_ACTION_STATES.every(state =>
    Object.hasOwn(value, state) && validTaskActionPreferences(value[state], taskActionIds(state)));
}
export function validState(value: unknown): value is UIState {
  if (!record(value) || Object.keys(value).some(k => !['draft','filters','read','edits','warning','taskActions'].includes(k))) return false;
  if (Object.hasOwn(value, 'taskActions') && !validTaskActions(value.taskActions)) return false;
  if (!str(value.draft, 65536) || !str(value.warning, 4096)) return false;
  if (value.filters !== null && (!Array.isArray(value.filters) || value.filters.length > 10000 || !value.filters.every(v => str(v, 256)))) return false;
  if (!record(value.read) || !Object.entries(value.read).every(([k,v]) => /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return false;
  return record(value.edits) && Object.keys(value.edits).length <= 1000 && Object.entries(value.edits).every(([k,v]) => /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && record(v) && Object.keys(v).every(x => ['text','revision'].includes(x)) && str(v.text,65536) && str(v.revision,128)) && Buffer.byteLength(JSON.stringify({ ...value, warning: '' })) <= MAX_STATE_PAYLOAD_BYTES;
}
export function safeLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return false;
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); } catch { return false; }
}
function validTask(value: unknown): boolean {
  if (!record(value) || !id(value.id) || !str(value.text) || !['active','in_progress','scheduled','done','removed'].includes(String(value.state))) return false;
  if (!str(value.created_at,128) || !str(value.updated_at,128) || !value.updated_at || !nullable(value.tag)) return false;
  if (!['remind_at','reminder_due_at','archived_at'].every(k => nullable(value[k]))) return false;
  return typeof value.agent_event_id === 'number' && Number.isSafeInteger(value.agent_event_id) && value.agent_event_id >= 0 && record(value.agent_notes) && Object.entries(value.agent_notes).every(([k,v]) => str(k,256) && str(v));
}
export function validEnvelope(operation: Operation, value: unknown): boolean {
  if (!record(value) || value.protocol !== 1 || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return record(value.error) && ['invalid','conflict','busy','internal','unknown'].includes(String(value.error.code)) && str(value.error.message,16384);
  const result = value.result;
  if (operation === 'completions') return Array.isArray(result) && result.every(id);
  if (!record(result)) return false;
  if (operation === 'handshake') return result.protocol === 1 && str(result.version,128) && typeof result.database === 'string' && result.database.startsWith('/') && str(result.database);
  if (operation === 'snapshot') {
    return Array.isArray(result.notes) && result.notes.every(validTask) && Array.isArray(result.tags) && result.tags.every(tag => record(tag) && str(tag.name,256) && nullable(tag.folder) && (tag.available === undefined || typeof tag.available === 'boolean')) && record(result.config) && typeof result.config.maxVisibleNotes === 'number' && Number.isSafeInteger(result.config.maxVisibleNotes) && result.config.maxVisibleNotes > 0 && typeof result.config.markdownPreview === 'boolean' && str(result.config.kittyStartPrompt);
  }
  if (typeof result.changed !== 'boolean' || (result.id !== undefined && !id(result.id)) || (result.tag !== undefined && !str(result.tag,256))) return false;
  if (operation === 'add') return result.changed && id(result.id);
  return operation !== 'create_tag' || (typeof result.tag === 'string' && result.tag.length > 0);
}
