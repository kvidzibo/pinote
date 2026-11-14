import { Store, NoteError } from './store.ts';
import { validate_tag, validate_text, validate_folder, pythonStrip, timestamp } from './compat.ts';
import { caseFold } from 'unicode-case-folding';
import { parse_reminder_time } from './reminders.ts';
import { VERSION, discoverPaths, resolvePath, withDisplayLock, BusyError, jsonStringify, configureLogging, log, checkCancelled, type Paths } from './runtime.ts';
import { GuiConfig, ConfigError } from './config.ts';
import { ReminderModel, folder_available } from './model.ts';
import { start_in_kitty } from './kitty.ts';
export const PROTOCOL = 1, MAX_REQUEST = 1024 * 1024, MAX_ID = 9007199254740991;
export class BridgeError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
const invalid = (): never => { throw new BridgeError('invalid', 'Invalid bridge request.'); };
const conflict = (): never => { throw new BridgeError('conflict', 'This task changed elsewhere. Refresh before trying again.'); };
export const safe_id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const sources: Record<string, string[]> = { start: ['active'], reset: ['in_progress'], done: ['active', 'in_progress'], rm: ['active', 'in_progress'], restore: ['done', 'removed', 'scheduled'] };
const fields: Record<string, string[]> = { handshake: [], snapshot: ['view'], add: ['text', 'tag'], edit: ['id', 'revision', 'text'], transition: ['id', 'revision', 'state', 'action'], tag: ['id', 'revision', 'tag'], schedule: ['id', 'revision', 'when'], create_tag: ['name', 'folder'], rename_tag: ['name', 'newName'], delete_tag: ['name'], tag_folder: ['name', 'folder'], completions: ['ids'], kitty: ['id', 'revision', 'directory'] };
// A bounded recursive-descent decoder retains numeric token types and rejects duplicate
// keys before JSON.parse could silently erase either distinction.
export function decode(data: Uint8Array): unknown {
  if (data.byteLength > MAX_REQUEST) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { return invalid(); }
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '\0')) i++; };
  const string = (): string => {
    const start = i++; let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (!escaped && c === '"') { try { return JSON.parse(text.slice(start, i)); } catch { return invalid(); } }
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    return invalid();
  };
  const value = (depth: number): any => {
    if (depth > 16) invalid(); ws();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      i++; ws(); const object = c === '{'; const out: any = object ? Object.create(null) : [];
      const end = object ? '}' : ']'; if (text[i] === end) { i++; return out; }
      while (true) {
        ws(); let key = '';
        if (object) { if (text[i] !== '"') invalid(); key = string(); ws(); if (text[i++] !== ':' || Object.hasOwn(out, key)) invalid(); }
        const item = value(depth + 1); if (object) out[key] = item; else out.push(item);
        ws(); if (text[i] === end) { i++; return out; } if (text[i++] !== ',') invalid();
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) if (text.startsWith(token, i)) { i += token.length; return result; }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(i));
    if (!match) return invalid(); i += match[0].length;
    if (/[.eE]/.test(text[i] ?? '\0')) invalid();
    const integer = BigInt(match[0]);
    return integer <= BigInt(MAX_ID) && integer >= -BigInt(MAX_ID) ? Number(integer) : integer;
  };
  const result = value(0); ws(); if (i !== text.length) invalid(); return result;
}
const isObject = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function validate(request: any): [string, Record<string, any>] {
  if (!isObject(request) || !exact(request, ['protocol', 'operation', 'params']) || request.protocol !== 1) invalid();
  const op = request.operation, p = request.params;
  if (typeof op !== 'string' || !Object.hasOwn(fields, op) || !isObject(p)) invalid();
  let allowed = fields[op];
  if (op === 'create_tag' && (Object.hasOwn(p, 'id') || Object.hasOwn(p, 'revision'))) allowed = [...allowed, 'id', 'revision'];
  if (!exact(p, allowed)) invalid();
  for (const [key, v] of Object.entries(p)) {
    if (key === 'id') { if (!safe_id(v)) invalid(); }
    else if (key === 'ids') { if (!Array.isArray(v) || v.length > 1000 || !v.every(safe_id)) invalid(); }
    else if (v === null && ['tag', 'folder'].includes(key)) continue;
    else if (typeof v !== 'string' || /[\uD800-\uDFFF]/u.test(v)) invalid();
  }
  if (Object.hasOwn(p, 'revision') && (!p.revision || Array.from(p.revision).length > 128 || /[\p{C}\p{Zl}\p{Zp}]|[^\S\x20]/u.test(p.revision) || /[\p{Zs}]/u.test(p.revision.replaceAll(' ', '')))) invalid();
  if (op === 'snapshot' && !['active', 'archive', 'scheduled'].includes(p.view)) invalid();
  if (op === 'transition' && (!Object.hasOwn(sources, p.action) || !sources[p.action].includes(p.state))) invalid();
  // Domain validation is also read-only: malformed input must not initialize
  // logging, the display lock, or SQLite, even on a fresh profile.
  if (op === 'add' || op === 'edit') validate_text(p.text);
  if (Object.hasOwn(p, 'tag')) validate_tag(p.tag);
  if (['create_tag', 'rename_tag', 'delete_tag', 'tag_folder'].includes(op)) {
    if (validate_tag(p.name) === null) throw new NoteError('Tag name cannot be empty.');
    if (op === 'rename_tag' && validate_tag(p.newName) === null) throw new NoteError('Tag name cannot be empty.');
  }
  if (Object.hasOwn(p, 'folder')) validate_folder(p.folder);
  if (op === 'schedule' && parse_reminder_time(p.when) <= timestamp()) throw new NoteError('Choose a reminder time in the future.');
  return [op, p];
}
export async function dispatch(op: string, p: Record<string, any>, paths: Paths): Promise<any> {
  checkCancelled();
  if (op === 'handshake') return { version: VERSION, protocol: PROTOCOL, database: resolvePath(paths.database) };
  const model = new ReminderModel(paths);
  if (op === 'snapshot') {
    const config = GuiConfig.load();
    const notes = p.view === 'active' ? await model.notes() : p.view === 'archive' ? model.archive() : model.reminders();
    if (notes.some(n => n.id < 1n || n.id > BigInt(MAX_ID) || n.agent_event_id < 0n || n.agent_event_id > BigInt(MAX_ID))) throw new BridgeError('internal', 'Database IDs exceed the supported range.');
    const folders = model.tag_folders();
    return { notes, tags: model.tags().map(name => { const folder = Object.hasOwn(folders, name) ? folders[name] : null; return { name, folder, available: folder_available(folder) }; }), config: { maxVisibleNotes: config.max_visible_notes, markdownPreview: config.markdown_preview, kittyStartPrompt: config.kitty_start_prompt } };
  }
  if (op === 'completions') return [...model.completed_ids(new Set(p.ids.map((id: number) => BigInt(id))))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return withDisplayLock(paths, false, async () => {
    const store = new Store(paths.database, { timeout: 0.1 });
    try {
      const id = Object.hasOwn(p, 'id') ? BigInt(p.id) : undefined;
      const target = id === undefined ? {} : { id }; const options = { expected_updated_at: p.revision };
      let changed: boolean;
      if (op === 'add') return { changed: true, id: store.add(p.text, { tag: p.tag }) };
      if (op === 'transition') { changed = store.transition(id!, p.action, { ...options, expected_states: new Set([p.state]) }); if (!changed) conflict(); }
      else if (op === 'edit' || op === 'tag') { const [changed, revision] = op === 'edit' ? store.edit_with_revision(id!, p.text, options) : store.set_tag_with_revision(id!, p.tag, options); return { changed, ...target, revision }; }
      else if (op === 'schedule') changed = store.schedule(id!, parse_reminder_time(p.when), options);
      else if (op === 'create_tag') {
        const name = validate_tag(p.name); if (name === null) throw new NoteError('Tag name cannot be empty.');
        if (id === undefined) return { changed: true, tag: store.create_tag(name, { folder: p.folder }) };
        const tags = store.tags(), saved = tags.includes(name) ? name : tags.find(t => caseFold(t) === caseFold(name)) ?? name;
        const [, revision] = store.set_tag_with_revision(id, name, { ...options, folder: p.folder });
        return { changed: true, id, tag: saved, revision };
      }
      else if (op === 'rename_tag') changed = store.rename_tag(p.name, p.newName);
      else if (op === 'delete_tag') changed = store.delete_tag(p.name);
      else if (op === 'tag_folder') changed = store.set_tag_folder(p.name, p.folder);
      else if (op === 'kitty') {
        const config = GuiConfig.load(), note = store.get(id!);
        if (note.updated_at !== p.revision || !['active', 'in_progress'].includes(note.state)) conflict();
        const summary = Array.from(note.text.split(/[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)[0].replace(/^ {0,3}#{1,6}[ \t]+/, '')).slice(0, 30).join('');
        const title = pythonStrip(note.tag ? `[${note.tag}] ${summary}` : summary);
        try { await start_in_kitty(p.directory, note, title, config.kitty_start_prompt); }
        catch { throw new BridgeError('unknown', 'Kitty launch outcome is uncertain. Check the tab or new window before retrying.'); }
        changed = true;
      } else return invalid();
      return { changed, ...target };
    } finally { store.close(); }
  });
}
function failure(error: any): any {
  let code = 'internal', message = 'Backend operation failed.';
  if (error instanceof BridgeError) { code = error.code; message = error.message; }
  else if (error instanceof BusyError) { code = 'busy'; message = 'Another frontend is busy. Try again shortly.'; }
  else if (error instanceof NoteError) { code = /^(This task changed|No note with ID)/.test(error.message) ? 'conflict' : 'invalid'; message = error.message; }
  else if (error instanceof ConfigError) { code = 'invalid'; message = 'Invalid GUI configuration. Check config.toml.'; }
  else if (error?.code === 'ERR_SQLITE_ERROR') { code = [5, 6].includes(Number(error.errcode) & 255) ? 'busy' : 'internal'; message = code === 'busy' ? 'Database is busy.' : 'Database operation failed.'; }
  return { protocol: PROTOCOL, ok: false, error: { code, message } };
}
export async function respond(request: unknown, paths?: Paths): Promise<any> {
  try { const [op, params] = validate(request); return { protocol: PROTOCOL, ok: true, result: await dispatch(op, params, paths ?? discoverPaths()) }; }
  catch (error) { return failure(error); }
}
export async function main(argv = process.argv.slice(2), input?: Uint8Array): Promise<number> {
  if (argv.length) {
    if (argv.length === 1 && ['--help', '-h', '--version'].includes(argv[0])) { process.stdout.write(argv[0] === '--version' ? VERSION + '\n' : 'Usage: pinote-electron-backend [--help] [--version]\n\nOne-request JSON boundary for Electron.\n'); return 0; }
    process.stderr.write('Unrecognized bridge arguments.\n'); return 2;
  }
  let response: any;
  try {
    if (input === undefined) {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > MAX_REQUEST) invalid(); chunks.push(bytes); }
      input = Buffer.concat(chunks);
    }
    checkCancelled();
    const request = decode(input); const [op] = validate(request); const paths = discoverPaths();
    if (op !== 'handshake') configureLogging(paths, { stderr: true });
    response = await respond(request, paths);
    checkCancelled();
    if (!response.ok && op !== 'handshake') log('warning', `Electron bridge request failed (${response.error.code}).`);
  } catch (error) {
    response = failure((error as Error).name === 'AbortError'
      ? new BridgeError('unknown', 'Backend interrupted. Check saved state before retrying.') : error);
  }
  process.stdout.write(jsonStringify(response) + '\n');
  // The launcher installs cancellation and records signal exit statuses. Never
  // turn an interrupted/possibly committed request into a clean process exit.
  return process.exitCode === 130 || process.exitCode === 143 ? process.exitCode : 0;
}
