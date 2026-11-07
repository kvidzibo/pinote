import type { Operation, UIState } from './protocol.ts';

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
export const mutating = (op: string) => !['handshake','snapshot','completions'].includes(op);
export function validState(value: unknown): value is UIState {
  if (!record(value) || Object.keys(value).some(k => !['draft','filters','read','edits','warning'].includes(k))) return false;
  if (!str(value.draft, 65536) || !str(value.warning, 4096)) return false;
  if (value.filters !== null && (!Array.isArray(value.filters) || value.filters.length > 10000 || !value.filters.every(v => str(v, 256)))) return false;
  if (!record(value.read) || !Object.entries(value.read).every(([k,v]) => /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return false;
  return record(value.edits) && Object.keys(value.edits).length <= 1000 && Object.entries(value.edits).every(([k,v]) => /^[1-9]\d*$/.test(k) && Number.isSafeInteger(Number(k)) && record(v) && Object.keys(v).every(x => ['text','revision'].includes(x)) && str(v.text,65536) && str(v.revision,128));
}
export function safeLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return false;
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); } catch { return false; }
}
export function validEnvelope(value: unknown): boolean {
  if (!record(value) || value.protocol !== 1 || typeof value.ok !== 'boolean') return false;
  return value.ok ? Object.hasOwn(value, 'result') : record(value.error) && ['invalid','conflict','busy','internal','unknown'].includes(String(value.error.code)) && str(value.error.message,16384);
}
