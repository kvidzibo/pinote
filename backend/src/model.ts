import { accessSync, constants, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Store, NoteError, type Note, type Id } from './store.ts';
import { validate_tag } from './compat.ts';
import { caseFold } from 'unicode-case-folding';
import { resolvePath, withDisplayLock, type Paths } from './runtime.ts';

export function folder_available(folder: string | null | undefined): boolean {
  try { if (!folder || !statSync(folder).isDirectory()) return false; accessSync(folder, constants.R_OK | constants.X_OK); return true; }
  catch { return false; }
}
const compare = (a: string, b: string): number => {
  const aa = Array.from(a, c => c.codePointAt(0)!); const bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};
export interface TransitionResult { notes: Note[]; changed: boolean; completed_ids: Set<Id> }
export class ReminderModel {
  readonly paths: Paths;
  constructor(paths: Paths) { this.paths = paths; }
  private read<T>(action: (store: Store) => T): T { const store = new Store(this.paths.database); try { return action(store); } finally { store.close(); } }
  private write<T>(action: (store: Store) => T): Promise<T> { return withDisplayLock(this.paths, false, () => this.read(action)); }
  async notes(): Promise<Note[]> {
    const store = new Store(this.paths.database);
    try { if (store.has_due()) await withDisplayLock(this.paths, false, () => store.activate_due()); return store.notes(); }
    finally { store.close(); }
  }
  completed_ids(ids: Set<Id>): Set<Id> {
    if (!ids.size) return new Set();
    return this.read(s => new Set(s.query(`SELECT id FROM notes WHERE state = 'done' AND id IN (${[...ids].map(() => '?').join(',')})`, ...ids).map(r => r.id)));
  }
  reminders(): Note[] { return this.read(s => s.scheduled_notes()); }
  schedule(note: Note, when: string): Promise<boolean> { return this.write(s => s.schedule(note.id, when, { expected_updated_at: note.updated_at })); }
  release(note: Note): Promise<boolean> {
    if (note.state !== 'scheduled') throw new NoteError('Only scheduled reminders can be moved back early.');
    return this.write(s => s.transition(note.id, 'restore', { expected_states: new Set(['scheduled']), expected_updated_at: note.updated_at }));
  }
  tags(): string[] {
    return this.read(s => {
      const latest = new Map(s.query('SELECT tag, MAX(created_at) AS latest FROM notes WHERE tag IS NOT NULL GROUP BY tag').map(r => [r.tag, r.latest]));
      return s.tags().sort((a, b) => compare(latest.get(a) ?? '', latest.get(b) ?? '') || compare(caseFold(a), caseFold(b)) || compare(a, b));
    });
  }
  tag_folders(): Record<string, string | null> { return this.read(s => s.tag_folders()); }
  tag_folder(tag: string | null): string | null { const folders = this.tag_folders(); const folder = tag !== null && Object.hasOwn(folders, tag) ? folders[tag] : null; return folder_available(folder) ? folder : null; }
  set_tag_folder(name: string, folder: string | null): Promise<boolean> { return this.write(s => s.set_tag_folder(name, folder)); }
  create_tag(name: string, options: { folder?: string | null; note?: Note } = {}): Promise<string> {
    const validated = validate_tag(name); if (validated === null) throw new NoteError('Tag name cannot be empty.');
    return this.write(s => { if (!options.note) return s.create_tag(validated, { folder: options.folder });
      s.set_tag(options.note.id, validated, { expected_updated_at: options.note.updated_at, folder: options.folder }); return s.get(options.note.id).tag!; });
  }
  rename_tag(old: string, name: string): Promise<boolean> { return this.write(s => s.rename_tag(old, name)); }
  delete_tag(name: string): Promise<boolean> { return this.write(s => s.delete_tag(name)); }
  add(text: string, options: { tag?: string | null } = {}): Promise<Id> { return this.write(s => s.add(text, options)); }
  edit(note: Note, text: string): Promise<boolean> { return this.write(s => s.edit(note.id, text, { expected_updated_at: note.updated_at })); }
  set_tag(note: Note, tag: string | null): Promise<boolean> { return this.write(s => s.set_tag(note.id, tag, { expected_updated_at: note.updated_at })); }
  transition(id: Id, action: string, options: { expected_state?: string } = {}): Promise<TransitionResult> {
    const states: Record<string, Set<string>> = { start: new Set(['active']), reset: new Set(['in_progress']), done: new Set(['in_progress']), rm: new Set(['active', 'in_progress']) };
    if (!Object.hasOwn(states, action)) throw new NoteError('The checklist only supports Start, Reset, Done, and Remove.');
    if (options.expected_state !== undefined) {
      if (!states[action].has(options.expected_state) && !(action === 'done' && options.expected_state === 'active')) throw new NoteError('This action is not available for the displayed task state.');
      states[action] = new Set([options.expected_state]);
    }
    return this.write(s => { const changed = s.transition(id, action, { expected_states: states[action] }); return { notes: s.notes(), changed, completed_ids: new Set() }; });
  }
  archive(): Note[] { return this.read(s => s.archived_notes()); }
  restore(note: Note): Promise<boolean> {
    if (!['done', 'removed'].includes(note.state)) throw new NoteError('Only completed or removed tasks can be restored from the archive.');
    return this.write(s => s.transition(note.id, 'restore', { expected_states: new Set([note.state]), expected_updated_at: note.updated_at }));
  }
}
export function application_id(paths: Paths): string { return 'io.github.kvidzibo.pinote.g' + createHash('sha256').update(resolvePath(paths.database)).digest('hex').slice(0, 32); }
