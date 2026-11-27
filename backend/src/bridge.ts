import { statSync } from 'node:fs';
import { Store, NoteError } from './store.ts';
import { validate_tag, validate_text, validate_folder, validate_new_folder, validateAgentPatch, timestamp, type AgentNotes, type AgentValue } from './compat.ts';
import { caseFold } from 'unicode-case-folding';
import { parse_reminder_time } from './reminders.ts';
import { VERSION, discoverPaths, resolvePath, withDisplayLock, BusyError, jsonStringify, configureLogging, log, checkCancelled, checkProfileIdentity, checkedEnv, type Paths } from './runtime.ts';
import { GuiConfig, ConfigError, guiConfigPath } from './config.ts';
import { decodeImage, imageInfo, validImageHash } from './images.ts';
import { ReminderModel, folder_available } from './model.ts';
import { start_in_kitty, validate_directory, kittyAddressEnv, UncertainLaunch, tab_title, validate_tab_title, validate_start_prompt, DEFAULT_START_PROMPT } from './kitty.ts';
// Requests hold at most one base64 image (4 MiB of bytes).
export const PROTOCOL = 1, MAX_REQUEST = 6 * 1024 * 1024, MAX_ID = 9007199254740991;
export class BridgeError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
const invalid = (): never => { throw new BridgeError('invalid', 'Invalid bridge request.'); };
const conflict = (): never => { throw new BridgeError('conflict', 'This task changed elsewhere. Refresh before trying again.'); };
export const safe_id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const sources: Record<string, string[]> = { start: ['active'], reset: ['in_progress'], done: ['active', 'in_progress'], rm: ['active', 'in_progress'], restore: ['done', 'removed', 'scheduled'] };
const fields: Record<string, string[]> = { handshake: [], snapshot: ['view'], add: ['text', 'tag'], edit: ['id', 'revision', 'text'], transition: ['id', 'revision', 'state', 'action'], tag: ['id', 'revision', 'tag'], agent: ['id', 'revision', 'fields'], schedule: ['id', 'revision', 'when'], create_tag: ['name', 'folder'], rename_tag: ['name', 'newName'], delete_tag: ['name'], tag_folder: ['name', 'folder'], completions: ['ids'], kitty: ['id', 'revision', 'directory'], image_add: ['data'], image: ['hash'], image_prune: ['keep'], stats: [] };
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
  if (op === 'kitty') allowed = [...allowed, ...['tabTitle', 'prompt'].filter(key => Object.hasOwn(p, key))];
  if (op === 'create_tag' && Object.hasOwn(p, 'folderIfNew')) allowed = [...allowed, 'folderIfNew'];
  if (!exact(p, allowed)) invalid();
  for (const [key, v] of Object.entries(p)) {
    if (key === 'id') { if (!safe_id(v)) invalid(); }
    else if (key === 'ids') { if (!Array.isArray(v) || v.length > 1000 || !v.every(safe_id)) invalid(); }
    else if (key === 'keep') { if (!Array.isArray(v) || v.length > 10000 || !v.every(validImageHash)) invalid(); }
    else if (v === null && ['tag', 'folder', 'folderIfNew'].includes(key)) continue;
    // A null field value removes that field; labels and values are validated below.
    else if (key === 'fields') { if (!isObject(v) || Object.keys(v).length > 64 || !Object.values(v).every(value => value === null || wellFormed(value) || Array.isArray(value) && value.length <= 256 && value.every(wellFormed))) invalid(); }
    else if (typeof v !== 'string' || /[\uD800-\uDFFF]/u.test(v)) invalid();
  }
  if (Object.hasOwn(p, 'revision') && (!p.revision || Array.from(p.revision).length > 128 || /[\p{C}\p{Zl}\p{Zp}]|[^\S\x20]/u.test(p.revision) || /[\p{Zs}]/u.test(p.revision.replaceAll(' ', '')))) invalid();
  if (op === 'snapshot' && !['active', 'archive', 'scheduled'].includes(p.view)) invalid();
  if (op === 'transition' && (!Object.hasOwn(sources, p.action) || !sources[p.action].includes(p.state))) invalid();
  // Domain validation is also read-only: malformed input must not initialize
  // logging, the display lock, or SQLite, even on a fresh profile.
  if (op === 'add' || op === 'edit') validate_text(p.text);
  if (op === 'image_add') imageInfo(decodeImage(p.data));
  if (op === 'image' && !validImageHash(p.hash)) invalid();
  if (Object.hasOwn(p, 'tag')) validate_tag(p.tag);
  if (op === 'agent') validateAgentPatch(...agentPatch(p.fields));
  if (['create_tag', 'rename_tag', 'delete_tag', 'tag_folder'].includes(op)) {
    if (validate_tag(p.name) === null) throw new NoteError('Tag name cannot be empty.');
    if (op === 'rename_tag' && validate_tag(p.newName) === null) throw new NoteError('Tag name cannot be empty.');
  }
  if (Object.hasOwn(p, 'folder')) validate_folder(p.folder);
  if (Object.hasOwn(p, 'folderIfNew')) validate_new_folder(p.folderIfNew);
  if (op === 'kitty') validate_directory(p.directory);
  if (Object.hasOwn(p, 'tabTitle')) validate_tab_title(p.tabTitle);
  if (Object.hasOwn(p, 'prompt')) validate_start_prompt(p.prompt);
  if (op === 'schedule' && parse_reminder_time(p.when) <= timestamp()) throw new NoteError('Choose a reminder time in the future.');
  return [op, p];
}
const wellFormed = (value: unknown) => typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value);
const agentPatch = (fields: Record<string, AgentValue | null>): [AgentNotes, string[]] => {
  const entries = Object.entries(fields);
  return [Object.fromEntries(entries.filter(([, v]) => v !== null)) as AgentNotes, entries.filter(([, v]) => v === null).map(([k]) => k)];
};
export async function dispatch(op: string, p: Record<string, any>, paths: Paths): Promise<any> {
  checkCancelled();
  if (op === 'handshake') return { version: VERSION, protocol: PROTOCOL, database: resolvePath(paths.database) };
  const model = new ReminderModel(paths);
  if (op === 'snapshot') {
    const config = GuiConfig.load();
    const notes = p.view === 'active' ? await model.notes() : p.view === 'archive' ? model.archive() : model.reminders();
    if (notes.some(n => n.id < 1n || n.id > BigInt(MAX_ID) || n.agent_event_id < 0n || n.agent_event_id > BigInt(MAX_ID))) throw new BridgeError('internal', 'Database IDs exceed the supported range.');
    const folders = model.tag_folders();
    return { notes, tags: model.tags().map(name => { const folder = Object.hasOwn(folders, name) ? folders[name] : null; return { name, folder, available: folder_available(folder) }; }), config: { maxVisibleNotes: config.max_visible_notes, markdownPreview: config.markdown_preview,
      // Electron 0.23 requires this field; newer releases keep the start prompt in their own settings.
      kittyStartPrompt: DEFAULT_START_PROMPT } };
  }
  if (op === 'completions') return [...model.completed_ids(new Set(p.ids.map((id: number) => BigInt(id))))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (op === 'image') {
    const store = new Store(paths.database, { timeout: 0.1 });
    try { const image = store.image(p.hash); return image ? { found: true, mime: image.mime, data: Buffer.from(image.bytes).toString('base64') } : { found: false }; }
    finally { store.close(); }
  }
  if (op === 'stats') {
    const store = new Store(paths.database, { timeout: 0.1 });
    try {
      const file = (path: string) => { try { return statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
      // SQLite keeps WAL sidecars beside the real file; until a checkpoint the newest writes are only in the WAL.
      const path = resolvePath(paths.database), database = statSync(path), wal = file(`${path}-wal`);
      return { database: { path, bytes: database.size + (wal?.size ?? 0) + (file(`${path}-shm`)?.size ?? 0), modified: new Date(Math.max(database.mtimeMs, wal?.mtimeMs ?? 0)).toISOString() },
        log: { path: resolvePath(paths.log), bytes: file(paths.log)?.size ?? null }, ...store.stats() };
    } finally { store.close(); }
  }
  return withDisplayLock(paths, false, async () => {
    const store = new Store(paths.database, { timeout: 0.1 });
    try {
      const id = Object.hasOwn(p, 'id') ? BigInt(p.id) : undefined;
      const target = id === undefined ? {} : { id }; const options = { expected_updated_at: p.revision };
      let changed: boolean;
      if (op === 'add') return { changed: true, id: store.add(p.text, { tag: p.tag }) };
      if (op === 'image_add') { const { changed, hash, mime, width, height } = store.add_image(decodeImage(p.data)); return { changed, hash, mime, width, height }; }
      if (op === 'image_prune') { const removed = store.prune_images(p.keep); return { changed: removed.length > 0, removed }; }
      if (op === 'transition') { changed = store.transition(id!, p.action, { ...options, expected_states: new Set([p.state]) }); if (!changed) conflict(); }
      else if (op === 'edit' || op === 'tag') { const [changed, revision] = op === 'edit' ? store.edit_with_revision(id!, p.text, options) : store.set_tag_with_revision(id!, p.tag, options); return { changed, ...target, revision }; }
      else if (op === 'agent') {
        const note = store.update_agent(id!, ...agentPatch(p.fields), options);
        return { changed: note.updated_at !== p.revision, ...target, revision: note.updated_at, agentEvent: note.agent_event_id };
      }
      else if (op === 'schedule') changed = store.schedule(id!, parse_reminder_time(p.when), options);
      else if (op === 'create_tag') {
        const name = validate_tag(p.name); if (name === null) throw new NoteError('Tag name cannot be empty.');
        if (id === undefined) return { changed: true, tag: store.create_tag(name, { folder: p.folder, folderIfNew: p.folderIfNew }) };
        const tags = store.tags(), saved = tags.includes(name) ? name : tags.find(t => caseFold(t) === caseFold(name)) ?? name;
        const [, revision] = store.set_tag_with_revision(id, name, { ...options, folder: p.folder, folderIfNew: p.folderIfNew });
        return { changed: true, id, tag: saved, revision };
      }
      else if (op === 'rename_tag') changed = store.rename_tag(p.name, p.newName);
      else if (op === 'delete_tag') changed = store.delete_tag(p.name);
      else if (op === 'tag_folder') changed = store.set_tag_folder(p.name, p.folder);
      else if (op === 'kitty') {
        const note = store.get(id!);
        if (note.updated_at !== p.revision || !['active', 'in_progress'].includes(note.state)) conflict();
        const title = tab_title(note, p.tabTitle);
        try { await start_in_kitty(p.directory, note, title, p.prompt ?? DEFAULT_START_PROMPT); }
        catch (error) {
          // NoteError: nothing was launched. Otherwise a tab or window may exist.
          if (error instanceof NoteError) throw error;
          throw new BridgeError('unknown', `Kitty launch outcome is uncertain${error instanceof UncertainLaunch ? ` (${error.message})` : ''}. Check the tab or new window before retrying.`);
        }
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
    if (op !== 'handshake') {
      checkProfileIdentity(paths);
      if (op === 'snapshot' || op === 'kitty') guiConfigPath();
      // Only Kitty launches search PATH; check it before any save.
      if (op === 'kitty') { checkedEnv('PATH'); kittyAddressEnv(); }
      configureLogging(paths, { stderr: true });
    }
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
