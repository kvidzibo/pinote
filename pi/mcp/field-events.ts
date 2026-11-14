import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { readConfigDocument } from '../footer-config.ts';

const exec = promisify(execFile);
const integer = z.number().int().nonnegative().safe();
const field = z.string().min(1).max(128);
const value = z.string().max(8192).nullable();
const Event = z.object({ id: integer, taskId: integer.positive(), field,
  event: z.enum(['added', 'changed', 'removed']), value, previousValue: value }).strict();
const Batch = z.object({ cursor: integer, events: z.array(Event).max(3200) }).strict();
export const FieldResult = z.object({
  state: z.string().min(1).max(64).optional(), summary: z.string().max(1000).optional(),
  display: z.object({ strikethrough: z.boolean().optional(), color: z.enum(['accent', 'muted', 'text', 'warning', 'error', 'success']).optional() }).strict().optional(),
  notification: z.object({ key: z.string().min(1).max(256), message: z.string().min(1).max(1000) }).strict().optional(),
  recheckAfterSeconds: z.number().int().min(10).max(86400).nullable().optional(),
}).strict();
export type FieldResult = z.infer<typeof FieldResult>;
type FieldEvent = z.infer<typeof Event>;
type Job = { event: FieldEvent; result?: FieldResult; due: number | null; attempts: number; checkedAt?: string; stale?: boolean };
export type FieldStatus = { field: string; value: string; result: FieldResult; checkedAt?: string; stale: boolean };
export type FieldNotice = { id: string; taskId: number; field: string; message: string };
type Task = { id: number; state: string; updated_at: string; agent_notes: Record<string, string> };
type Row = { job: string };

export function configuredFieldHandler(): string | undefined {
  const { value: config } = readConfigDocument();
  const handler = config.fieldHandler;
  if (handler === undefined || handler === null) return undefined;
  if (typeof handler !== 'string' || !isAbsolute(handler) || /[\u0000-\u001f\u007f]/u.test(handler)) throw new Error('fieldHandler must be an absolute executable file path');
  return handler;
}

/** One bounded invocation, no shell. Kill the process group on cancellation/overflow. */
export function runFieldHandler(handler: string, input: unknown, signal: AbortSignal, timeoutMs = 30_000): Promise<FieldResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(handler, [], { cwd: dirname(handler), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '', bytes = 0, failed = false;
    const kill = () => {
      failed = true;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 64 * 1024) kill(); else output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) kill(); });
    child.stdin.on('error', kill);
    child.on('error', () => { cleanup(); reject(new Error('Field handler failed')); });
    child.on('close', (code) => {
      cleanup();
      if (failed || code !== 0 || signal.aborted) return reject(new Error('Field handler failed'));
      try { resolve(FieldResult.parse(JSON.parse(output))); } catch { reject(new Error('Invalid field handler result')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Service-owned durable scheduler. A SQLite lease fences competing HTTP processes. */
export class FieldAutomation {
  private db: DatabaseSync;
  private owner = randomUUID();
  private lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private handler: string;
  private noteCommand: string;
  private changed: () => void;
  private log: () => void;
  private constructor(db: DatabaseSync, handler: string, noteCommand: string, changed: () => void, log: () => void) {
    this.db = db; this.handler = handler; this.noteCommand = noteCommand; this.changed = changed; this.log = log;
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scheduler (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL DEFAULT 0, handler TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (task_id INTEGER NOT NULL, field TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY(task_id, field));
      CREATE TABLE IF NOT EXISTS owners (task_id INTEGER PRIMARY KEY, context_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (task_id INTEGER NOT NULL, field TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(task_id, field));`);
    db.prepare('INSERT OR IGNORE INTO scheduler(id, handler) VALUES (1, ?)').run(handler);
  }
  static async open(options: { handler: string; path?: string; noteCommand?: string; changed?: () => void; log?: () => void }): Promise<FieldAutomation> {
    const dataHome = process.env.XDG_DATA_HOME;
    const database = join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local/share'), 'pinote/notes.db');
    const namespace = createHash('sha256').update(database).digest('hex').slice(0, 16);
    const path = options.path ?? join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'pinote/field-events', namespace, 'state.db');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error('Unsafe field automation directory');
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe field automation database');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    try { return new FieldAutomation(db, options.handler, options.noteCommand ?? process.env.PINOTE_NOTE_COMMAND ?? 'note', options.changed ?? (() => {}), options.log ?? (() => {})); }
    catch (error) { db.close(); throw error; }
  }
  private async note(args: string[]): Promise<unknown> {
    const { stdout } = await exec(this.noteCommand, ['--no-notify', ...args], { signal: this.lifetime.signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  private leased(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM scheduler WHERE id=1 AND owner=? AND lease_until>?').get(this.owner, Date.now()));
  }
  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.leased()) throw new Error('Field scheduler lease expired');
      work(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private save(job: Job): void {
    this.db.prepare('INSERT INTO jobs(task_id,field,job) VALUES (?,?,?) ON CONFLICT(task_id,field) DO UPDATE SET job=excluded.job')
      .run(job.event.taskId, job.event.field, JSON.stringify(job));
  }
  private clear(taskId: number, name: string): void {
    this.db.prepare('DELETE FROM jobs WHERE task_id=? AND field=?').run(taskId, name);
    this.db.prepare('DELETE FROM notices WHERE task_id=? AND field=?').run(taskId, name);
  }
  /** Explicit selection/write owns alerts; background reads can only claim unowned tasks. */
  claim(taskId: number, contextId: string, replace = false): void {
    this.db.prepare(replace
      ? 'INSERT INTO owners(task_id,context_id) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET context_id=excluded.context_id'
      : 'INSERT OR IGNORE INTO owners(task_id,context_id) VALUES (?,?)').run(taskId, contextId);
  }
  statuses(task: Task): FieldStatus[] {
    return (this.db.prepare('SELECT job FROM jobs WHERE task_id=?').all(task.id) as Row[]).flatMap(({ job: raw }) => {
      const job = JSON.parse(raw) as Job;
      if (job.event.value === null || job.event.value !== task.agent_notes[job.event.field] || !job.result) return [];
      return [{ field: job.event.field, value: job.event.value, result: job.result, checkedAt: job.checkedAt, stale: job.stale ?? false }];
    });
  }
  notices(task: Task, contextId: string): FieldNotice[] {
    this.claim(task.id, contextId);
    const owner = this.db.prepare('SELECT context_id FROM owners WHERE task_id=?').get(task.id);
    if (owner?.context_id !== contextId) return [];
    const fields = new Set(this.statuses(task).filter((s) => !s.stale && s.result.notification).map((s) => s.field));
    return (this.db.prepare('SELECT id, field, message FROM notices WHERE task_id=?').all(task.id) as { id: string; field: string; message: string }[])
      .filter((n) => fields.has(n.field)).map((n) => ({ ...n, taskId: task.id }));
  }
  start(): void {
    const schedule = () => {
      if (this.lifetime.signal.aborted) return;
      let delay = 1000;
      this.work = this.tick().catch(() => { delay = 30_000; this.log(); }).finally(() => {
        this.work = undefined;
        if (!this.lifetime.signal.aborted) { this.timer = setTimeout(schedule, delay); this.timer.unref(); }
      });
    };
    schedule();
  }
  async tick(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const acquired = this.db.prepare('UPDATE scheduler SET owner=?, lease_until=? WHERE id=1 AND (lease_until<=? OR owner=?)')
      .run(this.owner, Date.now() + 90_000, Date.now(), this.owner).changes;
    if (!acquired) return;
    try {
      let state = this.db.prepare('SELECT cursor, handler FROM scheduler WHERE id=1').get() as { cursor: number; handler: string };
      if (state.handler !== this.handler) {
        this.transaction(() => {
          this.db.exec('DELETE FROM jobs; DELETE FROM notices;');
          this.db.prepare('UPDATE scheduler SET cursor=0, handler=? WHERE id=1').run(this.handler);
        });
        state = { cursor: 0, handler: this.handler }; this.changed();
      }
      const batch = Batch.parse(await this.note(['field-events', '--after', String(state.cursor), '--limit', '25']));
      if (!this.leased()) return;
      if (batch.cursor < state.cursor || batch.events.some((e) => e.id <= state.cursor || e.id > batch.cursor)) throw new Error('Invalid field event cursor');
      if (batch.cursor !== state.cursor) {
        this.transaction(() => {
          for (const event of batch.events) {
            // New input invalidates both old display and pending alerts immediately.
            this.clear(event.taskId, event.field);
            this.save({ event, due: Date.now(), attempts: 0 });
          }
          this.db.prepare('UPDATE scheduler SET cursor=? WHERE id=1').run(batch.cursor);
        });
        this.changed();
        return; // Drain durable history before executing; coalesce superseded values.
      }
      const jobs = (this.db.prepare('SELECT job FROM jobs').all() as Row[]).map(({ job }) => JSON.parse(job) as Job);
      const job = jobs.filter((j) => j.due !== null && j.due <= Date.now()).sort((a, b) => a.due! - b.due!)[0];
      if (!job) return;
      const event = job.event;
      const task = await this.note(['agent', 'get', String(event.taskId)]) as Task;
      if (!this.leased()) return;
      const currentValue = task && ['active', 'in_progress'].includes(task.state) ? task.agent_notes[event.field] ?? null : null;
      if (event.value !== currentValue) { this.transaction(() => this.clear(event.taskId, event.field)); this.changed(); return; }
      let result: FieldResult, retryAfterSeconds = 0;
      try {
        result = await runFieldHandler(this.handler, {
          version: 1, eventId: `${event.id}:${event.field}`, taskId: event.taskId, field: event.field,
          event: job.checkedAt ? 'check' : event.event, value: event.value, previousValue: event.previousValue,
          ...(job.result ? { previousResult: job.result } : {}),
        }, this.lifetime.signal);
        if (result.state === 'error') {
          retryAfterSeconds = result.recheckAfterSeconds ?? 0;
          throw new Error('Handler reported unavailable data');
        }
      } catch {
        if (!this.leased() || this.lifetime.signal.aborted) return;
        job.attempts++; job.stale = true;
        job.result ??= { state: 'error', summary: 'Field handler unavailable', display: { color: 'muted' } };
        job.due = Date.now() + Math.max(retryAfterSeconds, Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7))) * 1000;
        this.transaction(() => this.save(job)); this.changed(); this.log(); return;
      }
      const latest = await this.note(['agent', 'get', String(event.taskId)]) as Task;
      if (!this.leased()) return;
      if (latest?.updated_at !== task?.updated_at) return; // Includes remove/re-add (ABA); next tick drains new events.
      this.transaction(() => {
        if (event.value === null) this.clear(event.taskId, event.field);
        else {
          const notification = result.notification;
          if (!notification) this.db.prepare('DELETE FROM notices WHERE task_id=? AND field=?').run(event.taskId, event.field);
          else if (JSON.stringify(notification) !== JSON.stringify(job.result?.notification)) {
            this.db.prepare('INSERT INTO notices(task_id,field,id,message) VALUES (?,?,?,?) ON CONFLICT(task_id,field) DO UPDATE SET id=excluded.id,message=excluded.message')
              .run(event.taskId, event.field, randomUUID(), notification.message);
          }
          this.save({ event, result, due: result.recheckAfterSeconds ? Date.now() + result.recheckAfterSeconds * 1000 : null,
            attempts: 0, checkedAt: new Date().toISOString(), stale: false });
        }
      });
      this.changed();
    } finally {
      this.db.prepare('UPDATE scheduler SET lease_until=0 WHERE id=1 AND owner=?').run(this.owner);
    }
  }
  async close(): Promise<void> {
    this.lifetime.abort(); clearTimeout(this.timer);
    await this.work;
    this.db.close();
  }
}
