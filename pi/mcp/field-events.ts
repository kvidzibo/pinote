import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { readConfigDocument } from '../footer-config.ts';
import { discoverFieldWatchers, type FieldWatcher } from '../field-watchers.ts';
import { parsePullRequests } from '../pull-requests.ts';

const exec = promisify(execFile);
const integer = z.number().int().nonnegative().safe();
const field = z.string().min(1).max(128);
const value = z.string().max(8192).nullable();
const Event = z.object({ id: integer, taskId: integer.positive(), field,
  event: z.enum(['added', 'changed', 'removed']), value, previousValue: value }).strict();
const Batch = z.object({ cursor: integer, events: z.array(Event).max(3200) }).strict();
const SingleFieldResult = z.object({
  state: z.string().min(1).max(64).optional(), summary: z.string().max(1000).optional(),
  display: z.object({ strikethrough: z.boolean().optional(), color: z.enum(['accent', 'muted', 'text', 'warning', 'error', 'success']).optional() }).strict().optional(),
  notification: z.object({ key: z.string().min(1).max(256), message: z.string().min(1).max(1000) }).strict().optional(),
  recheckAfterSeconds: z.number().int().min(10).max(86400).nullable().optional(),
}).strict();
export const FieldResult = SingleFieldResult.extend({
  items: z.array(SingleFieldResult.extend({ url: z.string().url().max(2048) }).strict()).max(64).optional(),
}).strict();
export type FieldResult = z.infer<typeof FieldResult>;
type FieldEvent = z.infer<typeof Event>;
type Job = { watcherId: string; event: FieldEvent; result?: FieldResult; due: number | null; attempts: number; checkedAt?: string; stale?: boolean };
export type WatcherFailureLog = { watcher: string; watcherId: string; taskId: number; field: string; reason: string; lastSuccess: string | null; retryAt: string };
class FieldHandlerFailure extends Error {}
export type FieldStatus = { watcherId: string; field: string; value: string; result: FieldResult; checkedAt?: string; stale: boolean };
export type FieldNotice = { id: string; taskId: number; field: string; message: string; receiptIds?: string[] };
type Task = { id: number; state: string; updated_at: string; agent_notes: Record<string, string> };
type Row = { job: string };
type PRNoticeRow = { url: string; notification_key: string; id: string; message: string };
const builtinPR = (watcher: FieldWatcher) => watcher.bundled && ['GitHub PR', 'Forgejo PR'].includes(watcher.name);
function prResults(watcher: FieldWatcher, field: string, value: string, result: FieldResult): FieldResult['items'] {
  if (field === 'PRs' && result.items) {
    const urls = new Set(parsePullRequests(value).map((item) => item.url));
    return result.items.filter((item) => urls.has(item.url));
  }
  if (field === 'PR' && builtinPR(watcher) && !result.items) {
    const urls = parsePullRequests(value);
    if (urls.length === 1) return [{ url: urls[0].url, ...result }];
  }
}
// Released GitHub keys preserved owner/repository casing; GitHub treats it as insignificant.
const prKey = (watcher: FieldWatcher, key: string) => watcher.bundled && watcher.name === 'GitHub PR'
  ? key.replace(/^pr:([^:]+):/, (_, repository: string) => `pr:${repository.toLowerCase()}:`) : key;
const prMessage = (url: string, message: string) => `PR #${url.split('/').at(-1)} ${url}: ${message}`;

/** One bounded invocation, no shell. Kill the process group on cancellation/overflow. */
export function runFieldHandler(handler: string, input: unknown, signal: AbortSignal, timeoutMs = 30_000): Promise<FieldResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(handler, [], { cwd: dirname(handler), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '', bytes = 0, failure: string | undefined;
    const kill = (reason = 'Watcher cancelled') => {
      failure ??= reason;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => kill('Watcher timed out'), timeoutMs);
    const abort = () => kill();
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 64 * 1024) kill('Watcher output exceeded 64 KiB'); else output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) kill('Watcher output exceeded 64 KiB'); });
    child.stdin.on('error', () => kill('Watcher input could not be delivered'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(new FieldHandlerFailure(error.code === 'ENOENT' ? 'Watcher executable or interpreter not found; check service PATH' :
        error.code === 'EACCES' ? 'Watcher execution denied; check permissions' : 'Watcher could not be started'));
    });
    child.on('close', (code) => {
      cleanup();
      if (failure || code !== 0 || signal.aborted) return reject(new FieldHandlerFailure(failure ??
        (code === 127 ? 'Watcher exited with code 127; check interpreter and service PATH' : 'Watcher exited unsuccessfully')));
      try { resolve(FieldResult.parse(JSON.parse(output))); } catch { reject(new FieldHandlerFailure('Invalid watcher JSON or result schema')); }
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
  private watchers: () => FieldWatcher[];
  private enabled: FieldWatcher[] = [];
  private signature = '';
  private generation = 0;
  private invocation?: AbortController;
  private ticking = false;
  private noteCommand: string;
  private changed: () => void;
  private log: (failure?: WatcherFailureLog) => void;
  private constructor(db: DatabaseSync, watchers: () => FieldWatcher[], noteCommand: string, changed: () => void, log: (failure?: WatcherFailureLog) => void) {
    this.db = db; this.watchers = watchers; this.noteCommand = noteCommand; this.changed = changed; this.log = log;
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const migrate = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fw_pr_notices'").get();
      db.exec(`
      CREATE TABLE IF NOT EXISTS fw_scheduler (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fw_watchers (id TEXT PRIMARY KEY, path TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fw_jobs (watcher_id TEXT NOT NULL, task_id INTEGER NOT NULL, field TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY(watcher_id,task_id,field));
      CREATE TABLE IF NOT EXISTS owners (task_id INTEGER PRIMARY KEY, context_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fw_notices (watcher_id TEXT NOT NULL, task_id INTEGER NOT NULL, field TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(watcher_id,task_id,field));
      CREATE TABLE IF NOT EXISTS fw_pr_notices (watcher_id TEXT NOT NULL, task_id INTEGER NOT NULL, url TEXT NOT NULL, notification_key TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(watcher_id,task_id,url));
      INSERT OR IGNORE INTO fw_scheduler(id) VALUES (1);`);
      if (migrate) {
        const builtins = new Map(watchers().filter(builtinPR).map((watcher) => [watcher.id, watcher]));
        for (const row of db.prepare("SELECT job FROM fw_jobs WHERE field='PR'").all() as Row[]) {
          const job = JSON.parse(row.job) as Job, notification = job.result?.notification;
          const urls = parsePullRequests(job.event.value ?? undefined);
          const receipt = db.prepare("SELECT id FROM fw_notices WHERE watcher_id=? AND task_id=? AND field='PR'")
            .get(job.watcherId, job.event.taskId) as { id: string } | undefined;
          const watcher = builtins.get(job.watcherId);
          if (watcher && !job.result?.items && notification && urls.length === 1 && receipt) {
            db.prepare('INSERT OR IGNORE INTO fw_pr_notices(watcher_id,task_id,url,notification_key,id,message) VALUES (?,?,?,?,?,?)')
              .run(job.watcherId, job.event.taskId, urls[0].url, prKey(watcher, notification.key), receipt.id, notification.message);
          }
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  static async open(options: { watchers?: () => FieldWatcher[]; path?: string; noteCommand?: string; changed?: () => void; log?: (failure?: WatcherFailureLog) => void } = {}): Promise<FieldAutomation> {
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
    try { return new FieldAutomation(db, options.watchers ?? (() => discoverFieldWatchers(readConfigDocument().value)), options.noteCommand ?? process.env.PINOTE_NOTE_COMMAND ?? 'note', options.changed ?? (() => {}), options.log ?? (() => {})); }
    catch (error) { db.close(); throw error; }
  }
  private async note(args: string[]): Promise<unknown> {
    const { stdout } = await exec(this.noteCommand, ['--no-notify', ...args], { signal: this.lifetime.signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  private leased(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM fw_scheduler WHERE id=1 AND owner=? AND lease_until>?').get(this.owner, Date.now()));
  }
  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.leased()) throw new Error('Field scheduler lease expired');
      work(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private reconcile(): void {
    const enabled = this.watchers().filter((watcher) => watcher.enabled);
    if (enabled.length > 32 || new Set(enabled.map((w) => w.id)).size !== enabled.length) throw new Error('Invalid enabled watchers');
    const signature = JSON.stringify(enabled.map((w) => [w.id, w.path]));
    if (signature === this.signature) return;
    this.generation++; this.invocation?.abort();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare('SELECT id,path FROM fw_watchers').all()) {
        if (!enabled.some((w) => w.id === row.id && w.path === row.path)) {
          this.db.prepare('DELETE FROM fw_jobs WHERE watcher_id=?').run(row.id);
          this.db.prepare('DELETE FROM fw_notices WHERE watcher_id=?').run(row.id);
          this.db.prepare('DELETE FROM fw_pr_notices WHERE watcher_id=?').run(row.id);
          this.db.prepare('DELETE FROM fw_watchers WHERE id=?').run(row.id);
        }
      }
      for (const watcher of enabled) this.db.prepare('INSERT OR IGNORE INTO fw_watchers(id,path) VALUES (?,?)').run(watcher.id, watcher.path);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.enabled = enabled; this.signature = signature; this.changed();
  }
  private save(job: Job): void {
    this.db.prepare('INSERT INTO fw_jobs(watcher_id,task_id,field,job) VALUES (?,?,?,?) ON CONFLICT(watcher_id,task_id,field) DO UPDATE SET job=excluded.job')
      .run(job.watcherId, job.event.taskId, job.event.field, JSON.stringify(job));
  }
  private clear(watcherId: string, taskId: number, name: string): void {
    this.db.prepare('DELETE FROM fw_jobs WHERE watcher_id=? AND task_id=? AND field=?').run(watcherId, taskId, name);
    this.db.prepare('DELETE FROM fw_notices WHERE watcher_id=? AND task_id=? AND field=?').run(watcherId, taskId, name);
  }
  /** Keep identity per PR, never per changing batch. Error items preserve identity without becoming actionable. */
  private recordPRNotices(watcher: FieldWatcher, job: Job, task: Task, result: FieldResult): boolean {
    const items = prResults(watcher, job.event.field, job.event.value ?? '', result);
    if (!items) return false;
    for (const item of items) {
      if (item.state === 'error') continue;
      if (item.notification) {
        const key = prKey(watcher, item.notification.key);
        const existing = this.db.prepare('SELECT notification_key,id FROM fw_pr_notices WHERE watcher_id=? AND task_id=? AND url=?')
          .get(watcher.id, task.id, item.url) as { notification_key: string; id: string } | undefined;
        const id = existing?.notification_key === key ? existing.id : randomUUID();
        this.db.prepare('INSERT INTO fw_pr_notices(watcher_id,task_id,url,notification_key,id,message) VALUES (?,?,?,?,?,?) ON CONFLICT(watcher_id,task_id,url) DO UPDATE SET notification_key=excluded.notification_key,id=excluded.id,message=excluded.message')
          .run(watcher.id, task.id, item.url, key, id, item.notification.message);
      } else if (['passing', 'pending', 'merged', 'closed'].includes(item.state ?? '')) {
        this.db.prepare('DELETE FROM fw_pr_notices WHERE watcher_id=? AND task_id=? AND url=?').run(watcher.id, task.id, item.url);
      }
    }
    return true;
  }
  private prunePRNotices(watcherId: string, taskId: number): void {
    const rows = this.db.prepare("SELECT job FROM fw_jobs WHERE watcher_id=? AND task_id=? AND field IN ('PR','PRs')").all(watcherId, taskId) as Row[];
    const urls = rows.flatMap(({ job }) => parsePullRequests((JSON.parse(job) as Job).event.value ?? undefined).map((item) => item.url));
    this.db.prepare('DELETE FROM fw_pr_notices WHERE watcher_id=? AND task_id=? AND url NOT IN (SELECT value FROM json_each(?))')
      .run(watcherId, taskId, JSON.stringify(urls));
  }
  /** Explicit selection/write owns alerts; background reads can only claim unowned tasks. */
  claim(taskId: number, contextId: string, replace = false): void {
    this.db.prepare(replace
      ? 'INSERT INTO owners(task_id,context_id) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET context_id=excluded.context_id'
      : 'INSERT OR IGNORE INTO owners(task_id,context_id) VALUES (?,?)').run(taskId, contextId);
  }
  statuses(task: Task): FieldStatus[] {
    this.reconcile();
    return this.enabled.flatMap((watcher) => (this.db.prepare('SELECT job FROM fw_jobs WHERE watcher_id=? AND task_id=?').all(watcher.id, task.id) as Row[]).flatMap(({ job: raw }) => {
      const job = JSON.parse(raw) as Job;
      if (job.event.value === null || job.event.value !== task.agent_notes[job.event.field] || !job.result || Object.keys(job.result).length === 0) return [];
      return [{ watcherId: watcher.id, field: job.event.field, value: job.event.value, result: job.result, checkedAt: job.checkedAt, stale: job.stale ?? false }];
    }));
  }
  /** Service-wide health, separate from task results and worker alerts. */
  failures() {
    this.reconcile();
    return this.enabled.flatMap((watcher) => {
      const fields = [...new Set((this.db.prepare('SELECT job FROM fw_jobs WHERE watcher_id=?').all(watcher.id) as Row[])
        .map(({ job }) => JSON.parse(job) as Job).filter((job) => (job.stale || job.result?.items?.some((item) => item.state === 'error')) && job.event.value !== null).map((job) => job.event.field))].sort();
      return fields.length ? [{ watcherId: watcher.id, name: watcher.name.slice(0, 256), fields: fields.slice(0, 8), moreFields: Math.max(0, fields.length - 8) }] : [];
    });
  }
  notices(task: Task, contextId: string, receipts: readonly string[] = [], grouped = false): FieldNotice[] {
    this.claim(task.id, contextId);
    const owner = this.db.prepare('SELECT context_id FROM owners WHERE task_id=?').get(task.id);
    if (owner?.context_id !== contextId) return [];
    const received = new Set(receipts), statuses = this.statuses(task);
    const managed = new Set<string>(), result: FieldNotice[] = [];
    for (const watcher of this.enabled) {
      const observations = new Map<string, { field: string; item: NonNullable<FieldResult['items']>[number] }>();
      const ordered = statuses.filter((status) => status.watcherId === watcher.id && !status.stale)
        .sort((a, b) => (b.checkedAt ?? '').localeCompare(a.checkedAt ?? '') || Number(b.field === 'PRs') - Number(a.field === 'PRs'));
      for (const status of ordered) {
        const items = prResults(watcher, status.field, status.value, status.result);
        if (!items) continue;
        managed.add(watcher.id + ':' + status.field);
        for (const item of items) if (item.state !== 'error' && !observations.has(item.url)) observations.set(item.url, { field: status.field, item });
      }
      const active = (this.db.prepare('SELECT url,notification_key,id,message FROM fw_pr_notices WHERE watcher_id=? AND task_id=? ORDER BY rowid')
        .all(watcher.id, task.id) as PRNoticeRow[]).flatMap((row) => {
        const observation = observations.get(row.url);
        if (received.has(row.id) || !observation?.item.notification || prKey(watcher, observation.item.notification.key) !== row.notification_key) return [];
        return [{ ...row, field: observation.field }];
      }).slice(0, 64);
      let group: typeof active = [], length = 0;
      const flush = () => {
        if (!group.length) return;
        if (group.length > 1) result.push({ id: group[0].id, taskId: task.id, field: 'PRs', receiptIds: group.map((row) => row.id),
          message: group.map((row) => prMessage(row.url, row.message).slice(0, 1000)).join('\n') });
        else result.push({ id: group[0].id, taskId: task.id, field: group[0].field,
          message: group[0].field === 'PR' ? group[0].message : prMessage(group[0].url, group[0].message).slice(0, 1000) });
        group = []; length = 0;
      };
      for (const row of active) {
        const size = prMessage(row.url, row.message).slice(0, 1000).length;
        if (!grouped || length && length + 1 + size > 1000) flush();
        length += (length ? 1 : 0) + size; group.push(row);
      }
      flush();
    }
    const fields = new Set(statuses.filter((s) => !s.stale && s.result.notification
      && (!s.result.items || s.result.items.some((item) => item.state !== 'error' && item.notification)))
      .map((s) => s.watcherId + ':' + s.field));
    const rows = this.db.prepare('SELECT watcher_id,id,field,message FROM fw_notices WHERE task_id=? ORDER BY rowid')
      .all(task.id) as { watcher_id: string; id: string; field: string; message: string }[];
    for (const row of rows) {
      const field = row.watcher_id + ':' + row.field;
      if (!managed.has(field) && fields.has(field) && !received.has(row.id)) result.push({ id: row.id, taskId: task.id, field: row.field, message: row.message });
    }
    return result.slice(0, 64);
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
  tick(): Promise<void> {
    if (this.ticking) return this.work ?? Promise.resolve();
    this.ticking = true;
    const work = this.performTick().finally(() => { this.ticking = false; if (this.work === work) this.work = undefined; });
    this.work = work;
    return work;
  }
  private async performTick(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const acquired = this.db.prepare('UPDATE fw_scheduler SET owner=?, lease_until=? WHERE id=1 AND (lease_until<=? OR owner=?)')
      .run(this.owner, Date.now() + 90_000, Date.now(), this.owner).changes;
    if (!acquired) return;
    try {
      this.reconcile();
      const generation = this.generation;
      const valid = () => {
        this.reconcile();
        if (!this.leased() || generation !== this.generation || this.lifetime.signal.aborted) return false;
        // Many watchers can make intake longer than one lease; each bounded operation renews it.
        this.db.prepare('UPDATE fw_scheduler SET lease_until=? WHERE id=1 AND owner=?').run(Date.now() + 90_000, this.owner);
        return true;
      }
      let drained = false;
      for (const watcher of this.enabled) {
        const state = this.db.prepare('SELECT cursor FROM fw_watchers WHERE id=?').get(watcher.id) as { cursor: number };
        const batch = Batch.parse(await this.note(['field-events', '--after', String(state.cursor), '--limit', '25']));
        if (!valid()) return;
        if (batch.cursor < state.cursor || batch.events.some((e) => e.id <= state.cursor || e.id > batch.cursor)) throw new Error('Invalid field event cursor');
        if (batch.cursor !== state.cursor) {
          this.transaction(() => {
            for (const event of batch.events) {
              this.clear(watcher.id, event.taskId, event.field);
              this.save({ watcherId: watcher.id, event, due: Date.now(), attempts: 0 });
            }
            for (const taskId of new Set(batch.events.map((event) => event.taskId))) this.prunePRNotices(watcher.id, taskId);
            this.db.prepare('UPDATE fw_watchers SET cursor=? WHERE id=?').run(batch.cursor, watcher.id);
          });
          drained = true;
        }
      }
      if (drained) { this.changed(); return; }
      const jobs = (this.db.prepare('SELECT job FROM fw_jobs').all() as Row[]).map(({ job }) => JSON.parse(job) as Job);
      const job = jobs.filter((j) => j.due !== null && j.due <= Date.now()).sort((a, b) => a.due! - b.due!)[0];
      if (!job) return;
      const event = job.event;
      const watcher = this.enabled.find((w) => w.id === job.watcherId);
      if (!watcher) return;
      const task = await this.note(['agent', 'get', String(event.taskId)]) as Task;
      if (!valid()) return;
      const currentValue = task && ['active', 'in_progress'].includes(task.state) ? task.agent_notes[event.field] ?? null : null;
      if (event.value !== currentValue) { this.transaction(() => { this.clear(job.watcherId, event.taskId, event.field); this.prunePRNotices(job.watcherId, event.taskId); }); this.changed(); return; }
      let result: FieldResult, retryAfterSeconds = 0;
      const invocation = new AbortController();
      this.invocation = invocation;
      const abort = () => invocation.abort();
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      const poll = setInterval(() => { try { this.reconcile(); } catch { invocation.abort(); } }, 100);
      try {
        result = await runFieldHandler(watcher.path, {
          version: 1, eventId: `${event.id}:${event.field}`, taskId: event.taskId, field: event.field,
          event: job.checkedAt ? 'check' : event.event, value: event.value, previousValue: event.previousValue,
          ...(job.result ? { previousResult: job.result } : {}),
        }, invocation.signal);
        if (result.state === 'error') {
          retryAfterSeconds = result.recheckAfterSeconds ?? 0;
          throw new FieldHandlerFailure('Watcher reported unavailable data; check dependencies, authentication and connectivity');
        }
      } catch (error) {
        if (!valid() || invocation.signal.aborted) return;
        job.attempts++; job.stale = true;
        job.result ??= { state: 'error', summary: 'Field handler unavailable', display: { color: 'muted' } };
        job.due = Date.now() + Math.max(retryAfterSeconds, Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7))) * 1000;
        this.transaction(() => this.save(job)); this.changed();
        this.log({ watcher: watcher.name, watcherId: watcher.id, taskId: event.taskId, field: event.field,
          reason: error instanceof FieldHandlerFailure ? error.message : 'Watcher check failed',
          lastSuccess: job.checkedAt ?? null, retryAt: new Date(job.due).toISOString() });
        return;
      }
      finally {
        clearInterval(poll); this.lifetime.signal.removeEventListener('abort', abort);
        if (this.invocation === invocation) this.invocation = undefined;
      }
      if (!valid() || invocation.signal.aborted) return;
      const latest = await this.note(['agent', 'get', String(event.taskId)]) as Task;
      if (!valid()) return;
      if (latest?.updated_at !== task?.updated_at) return; // Includes remove/re-add (ABA); next tick drains new events.
      this.transaction(() => {
        if (event.value === null) { this.clear(job.watcherId, event.taskId, event.field); this.prunePRNotices(job.watcherId, event.taskId); }
        else {
          const managed = this.recordPRNotices(watcher, job, latest, result);
          const notification = result.notification;
          if (managed || !notification) this.db.prepare('DELETE FROM fw_notices WHERE watcher_id=? AND task_id=? AND field=?').run(job.watcherId, event.taskId, event.field);
          else if (notification.key !== job.result?.notification?.key || notification.message !== job.result?.notification?.message) {
            this.db.prepare('INSERT INTO fw_notices(watcher_id,task_id,field,id,message) VALUES (?,?,?,?,?) ON CONFLICT(watcher_id,task_id,field) DO UPDATE SET id=excluded.id,message=excluded.message')
              .run(job.watcherId, event.taskId, event.field, randomUUID(), notification.message);
          }
          this.save({ watcherId: job.watcherId, event, result, due: result.recheckAfterSeconds ? Date.now() + result.recheckAfterSeconds * 1000 : null,
            attempts: 0, checkedAt: new Date().toISOString(), stale: false });
        }
      });
      if (result.items?.some((item) => item.state === 'error')) {
        this.log({ watcher: watcher.name, watcherId: watcher.id, taskId: event.taskId, field: event.field,
          reason: 'Watcher reported unavailable data for some items', lastSuccess: job.checkedAt ?? null,
          retryAt: new Date(Date.now() + (result.recheckAfterSeconds ?? 60) * 1000).toISOString() });
      }
      this.changed();
    } finally {
      this.db.prepare('UPDATE fw_scheduler SET lease_until=0 WHERE id=1 AND owner=?').run(this.owner);
    }
  }
  async close(): Promise<void> {
    this.lifetime.abort(); clearTimeout(this.timer);
    await this.work;
    this.db.close();
  }
}
