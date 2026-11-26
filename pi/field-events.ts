import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { readConfigDocument } from './footer-config.ts';
import { discoverFieldWatchers, TASK_EVENTS, type FieldWatcher } from './field-watchers.ts';
import { parsePullRequests } from './pull-requests.js';
import { notesVersion, RECHECK_MS } from './notes-version.ts';

const exec = promisify(execFile);
const integer = z.number().int().nonnegative().safe();
const field = z.string().min(1).max(128);
const value = z.string().max(8192).nullable();
const Event = z.object({ id: integer, taskId: integer.positive(), field,
  event: z.enum(['added', 'changed', 'removed']), value, previousValue: value }).strict();
const Batch = z.object({ cursor: integer, events: z.array(Event).max(3200) }).strict();
const TaskEventSchema = z.object({ id: integer, taskId: integer.positive(), event: z.enum(TASK_EVENTS), fields: z.record(z.string(), z.string()) }).strict();
const TaskBatch = z.object({ cursor: integer, events: z.array(TaskEventSchema).max(1000) }).strict();
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
/** `field` is `task:<event>` for a task event and `app:startup` (without a task) for the startup event; neither is retried. */
export type WatcherFailureLog = { watcher: string; watcherId: string; taskId: number | null; field: string; reason: string; lastSuccess: string | null; retryAt: string | null };
class FieldHandlerFailure extends Error {}
export type FieldStatus = { watcherId: string; field: string; value: string; result: FieldResult; checkedAt?: string; stale: boolean };
export type FieldNotice = { id: string; taskId: number; field: string; message: string; receiptIds?: string[] };
type Task = { id: number; state: string; updated_at: string; agent_notes: Record<string, string> };
type Row = { job: string };
type PRNoticeRow = { url: string; notification_key: string; id: string; message: string };
// By name, not install location: the desktop's bundled copy and a package checkout are the same watcher.
const builtinPR = (watcher: FieldWatcher) => ['GitHub PR', 'Forgejo PR'].includes(watcher.name);
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
const prKey = (watcher: FieldWatcher, key: string) => watcher.name === 'GitHub PR'
  ? key.replace(/^pr:([^:]+):/, (_, repository: string) => `pr:${repository.toLowerCase()}:`) : key;
const prMessage = (url: string, message: string) => `PR #${url.split('/').at(-1)} ${url}: ${message}`;
/** Saved results depend on these settings: changing them checks the watcher's fields afresh. */
const settings = (watcher: FieldWatcher) => JSON.stringify([watcher.fieldEvents, watcher.fields, watcher.params]);
/** A task watcher's enablement with its current settings; each starts at the history tail read once it appears. */
const subscription = (watcher: FieldWatcher) => JSON.stringify([watcher.id, watcher.taskEvents, settings(watcher)]);
/** What an invocation in flight depends on: it is cancelled when that changes. Other settings apply to the next one. */
const startupInput = (watcher: FieldWatcher) => JSON.stringify([watcher.path, watcher.params]);
const taskInput = (watcher: FieldWatcher) => JSON.stringify([watcher.path, subscription(watcher)]);
const checkInput = (watcher: FieldWatcher) => JSON.stringify([watcher.path, settings(watcher)]);
/** Watchers invoked at once; each watcher runs one invocation at a time. */
const CONCURRENCY = 4;
type Run = { input: (watcher: FieldWatcher) => string; key: string; controller: AbortController; promise: Promise<void> };
type TaskEvent = { id: number; taskId: number; event: typeof TASK_EVENTS[number]; fields: Record<string, string> };
const wantsTask = (watcher: FieldWatcher, event: TaskEvent) => watcher.taskEvents.includes(event.event)
  && (!watcher.fields.length || watcher.fields.some((name) => Object.hasOwn(event.fields, name)));

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
      reject(new FieldHandlerFailure(error.code === 'ENOENT' ? 'Watcher executable or interpreter not found; check PATH' :
        error.code === 'EACCES' ? 'Watcher execution denied; check permissions' : 'Watcher could not be started'));
    });
    child.on('close', (code) => {
      cleanup();
      if (failure || code !== 0 || signal.aborted) return reject(new FieldHandlerFailure(failure ??
        (code === 127 ? 'Watcher exited with code 127; check interpreter and PATH' : 'Watcher exited unsuccessfully')));
      try { resolve(FieldResult.parse(JSON.parse(output))); } catch { reject(new FieldHandlerFailure('Invalid watcher JSON or result schema')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Durable watcher state. start() runs the scheduler; a SQLite lease fences competing processes.
 * Without start() this is a reader of the results another process saves. */
export class FieldAutomation {
  private db: DatabaseSync;
  private owner = randomUUID();
  private lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private watchers: () => FieldWatcher[];
  private enabled: FieldWatcher[] = [];
  private signature = '';
  private stored?: string;
  private generation = 0;
  private running = new Map<string, Run>();
  private poll?: ReturnType<typeof setInterval>;
  // In memory: cooldowns count from this process's own invocations.
  private started = new Map<string, number>();
  // The scan for free slots resumes after the watcher admitted last.
  private admitted?: string;
  // Watchers selected for the startup event when the scheduler started.
  private startup?: Set<string>;
  private ticking = false;
  private notes = notesVersion();
  private drained?: string;
  private drainDue = 0;
  // In memory only: task events run once, for changes made while this scheduler is running.
  // Each subscription reads history from its own position: a full queue (a watcher cooling down) delays only itself.
  private taskCursors = new Map<string, number>();
  // Subscriptions whose full queue stopped their reads: intake resumes once there is room.
  private taskBacklog = new Set<string>();
  private taskQueue: { subscription: string; event: TaskEvent }[] = [];
  // Watchers whose last invocation was a task event: field work goes next, so neither backlog starves the other.
  private taskTurn = new Set<string>();
  private taskEventsFailed = false;
  private noteCommand: string;
  private changed: () => void;
  private log: (failure?: WatcherFailureLog) => void;
  readonly path: string;
  /** Touched by the scheduler's host whenever saved results change; lease renewals do not count. */
  readonly changes: string;
  private constructor(db: DatabaseSync, path: string, watchers: () => FieldWatcher[], noteCommand: string, changed: () => void, log: (failure?: WatcherFailureLog) => void) {
    this.db = db; this.path = path; this.changes = join(dirname(path), 'changed'); this.watchers = watchers; this.noteCommand = noteCommand; this.changed = changed; this.log = log;
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const migrate = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fw_pr_notices'").get();
      db.exec(`
      CREATE TABLE IF NOT EXISTS fw_scheduler (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fw_watchers (id TEXT PRIMARY KEY, path TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS fw_jobs (watcher_id TEXT NOT NULL, task_id INTEGER NOT NULL, field TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY(watcher_id,task_id,field));
      CREATE TABLE IF NOT EXISTS owners (task_id INTEGER PRIMARY KEY, context_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fw_notices (watcher_id TEXT NOT NULL, task_id INTEGER NOT NULL, field TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(watcher_id,task_id,field));
      CREATE TABLE IF NOT EXISTS fw_pr_notices (watcher_id TEXT NOT NULL, task_id INTEGER NOT NULL, url TEXT NOT NULL, notification_key TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(watcher_id,task_id,url));
      INSERT OR IGNORE INTO fw_scheduler(id) VALUES (1);`);
      if (!db.prepare("SELECT 1 FROM pragma_table_info('fw_watchers') WHERE name='config'").get()) db.exec("ALTER TABLE fw_watchers ADD COLUMN config TEXT NOT NULL DEFAULT ''");
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
    try { return new FieldAutomation(db, path, options.watchers ?? (() => discoverFieldWatchers(readConfigDocument().value)), options.noteCommand ?? process.env.PINOTE_NOTE_COMMAND ?? 'note', options.changed ?? (() => {}), options.log ?? (() => {})); }
    catch (error) { db.close(); throw error; }
  }
  private async note(args: string[]): Promise<unknown> {
    const { stdout } = await exec(this.noteCommand, ['--no-notify', ...args], { signal: this.lifetime.signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  private leased(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM fw_scheduler WHERE id=1 AND owner=? AND lease_until>?').get(this.owner, Date.now()));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.leased()) throw new Error('Field scheduler lease expired');
      const result = work(); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private release(): void {
    this.db.prepare('UPDATE fw_scheduler SET lease_until=0 WHERE id=1 AND owner=?').run(this.owner);
  }
  /** Readers only filter by their enabled watchers. Saved state is cleaned up by the
   * scheduler alone (durable): a reader with another configuration must not erase it. */
  private reconcile(durable = false): void {
    const enabled = this.watchers().filter((watcher) => watcher.enabled && !watcher.problem);
    if (enabled.length > 32 || new Set(enabled.map((w) => w.id)).size !== enabled.length) throw new Error('Invalid enabled watchers');
    const signature = JSON.stringify(enabled.map((w) => [w.id, w.path, w.appEvents, w.taskEvents, settings(w), w.timeoutSeconds, w.cooldownSeconds]));
    if (signature !== this.signature) {
      this.generation++;
      for (const [id, run] of this.running) {
        const watcher = enabled.find((w) => w.id === id);
        if (!watcher || run.input(watcher) !== run.key) run.controller.abort();
      }
      this.enabled = enabled; this.signature = signature; this.changed();
      // A subscription that ended takes its queued events with it: enabling it again starts afresh.
      const current = new Set(enabled.filter((watcher) => watcher.taskEvents.length).map(subscription));
      for (const key of this.taskCursors.keys()) if (!current.has(key)) { this.taskCursors.delete(key); this.taskBacklog.delete(key); }
      this.taskQueue = this.taskQueue.filter((queued) => current.has(queued.subscription));
    }
    if (!durable || signature === this.stored) return;
    this.db.exec('BEGIN IMMEDIATE');
    // Only the lease owner cleans up: a former owner's settings must not erase the current scheduler's state.
    if (!this.leased()) { this.db.exec('ROLLBACK'); return; }
    try {
      for (const row of this.db.prepare('SELECT id,path,config FROM fw_watchers').all()) {
        const watcher = enabled.find((w) => w.id === row.id && w.path === row.path);
        // Rows saved before watcher settings existed keep their results.
        if (watcher && row.config === '') this.db.prepare('UPDATE fw_watchers SET config=? WHERE id=?').run(settings(watcher), row.id);
        else if (!watcher || row.config !== settings(watcher)) {
          this.db.prepare('DELETE FROM fw_jobs WHERE watcher_id=?').run(row.id);
          this.db.prepare('DELETE FROM fw_notices WHERE watcher_id=?').run(row.id);
          this.db.prepare('DELETE FROM fw_pr_notices WHERE watcher_id=?').run(row.id);
          this.db.prepare('DELETE FROM fw_watchers WHERE id=?').run(row.id);
        }
      }
      for (const watcher of enabled) this.db.prepare('INSERT OR IGNORE INTO fw_watchers(id,path,config) VALUES (?,?,?)').run(watcher.id, watcher.path, settings(watcher));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.stored = signature; this.drained = undefined; this.changed();
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
  /** The user disabled or removed this watcher in settings: forget its saved state now, so
   * enabling it again checks afresh even if no scheduler tick saw it disabled. */
  reset(watcherId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['fw_jobs', 'fw_notices', 'fw_pr_notices']) this.db.prepare(`DELETE FROM ${table} WHERE watcher_id=?`).run(watcherId);
      this.db.prepare('DELETE FROM fw_watchers WHERE id=?').run(watcherId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
  /** Scheduler-wide health, separate from task results and worker alerts. */
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
    // Eligibility is fixed when the desktop starts, whenever this process first holds the lease.
    try { this.reconcile(); this.startup ??= this.startupWatchers(); } catch { this.startup ??= new Set(); }
    const schedule = () => {
      if (this.lifetime.signal.aborted) return;
      let delay = 1000;
      this.work = this.step().catch(() => {
        if (this.lifetime.signal.aborted) return; // Closing cancels the tick in flight; that is not a failed check.
        delay = 30_000; this.log();
      }).finally(() => {
        this.work = undefined;
        if (!this.lifetime.signal.aborted) { this.timer = setTimeout(schedule, delay); this.timer.unref(); }
      });
    };
    schedule();
  }
  /** One scheduler step, then the invocations it or an earlier step started. */
  async tick(): Promise<void> {
    await this.step();
    await this.idle();
  }
  private step(): Promise<void> {
    if (this.ticking) return this.work ?? Promise.resolve();
    this.ticking = true;
    const work = this.performTick().finally(() => { this.ticking = false; if (this.work === work) this.work = undefined; });
    this.work = work;
    return work;
  }
  private async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((run) => run.promise));
  }
  private async performTick(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const acquired = this.db.prepare('UPDATE fw_scheduler SET owner=?, lease_until=? WHERE id=1 AND (lease_until<=? OR owner=?)')
      .run(this.owner, Date.now() + 90_000, Date.now(), this.owner).changes;
    if (!acquired) return;
    try {
      this.reconcile(true);
      // Without start() (tick() alone), the first step is the start.
      this.startup ??= this.startupWatchers();
      const generation = this.generation;
      const valid = () => {
        this.reconcile(true);
        if (!this.leased() || generation !== this.generation || this.lifetime.signal.aborted) return false;
        // Many watchers can make intake longer than one lease; each bounded operation renews it.
        this.db.prepare('UPDATE fw_scheduler SET lease_until=? WHERE id=1 AND owner=?').run(Date.now() + 90_000, this.owner);
        return true;
      }
      let drained = false;
      // Read event history only after notes.db or the watcher set (see reconcile) changed.
      const subscribed = new Map(this.enabled.filter((watcher) => watcher.taskEvents.length).map((watcher) => [subscription(watcher), watcher]));
      let more = false;
      if (!this.enabled.length) { this.notes.close(); return; }
      const version = this.notes.read();
      const room = (key: string) => 64 - this.taskQueue.filter((item) => item.subscription === key).length;
      let intake = version === undefined || version !== this.drained || Date.now() >= this.drainDue || [...this.taskBacklog].some((key) => room(key) > 0);
      // A settings reset removes a watcher's row: start it again from durable history.
      for (const watcher of this.enabled) if (this.db.prepare('INSERT OR IGNORE INTO fw_watchers(id,path,config) VALUES (?,?,?)').run(watcher.id, watcher.path, settings(watcher)).changes) { intake = true; this.drained = undefined; }
      if (intake && subscribed.size) {
        try {
          // Without a cursor the CLI returns the current tail: history from before this start never runs.
          const read = async (after?: number, limit = 25) => TaskBatch.parse(await this.note(['task-events', ...(after === undefined ? [] : ['--after', String(after)]), '--limit', String(limit)]));
          if ([...subscribed.keys()].some((key) => !this.taskCursors.has(key))) {
            const tail = (await read()).cursor;
            if (!valid()) return;
            for (const key of subscribed.keys()) if (!this.taskCursors.has(key)) this.taskCursors.set(key, tail);
          }
          // At most 64 queued events per subscription: a full queue is dispatched first; its cursor keeps the rest.
          // Subscriptions at one position share a read, bounded by the least room among them.
          const positions = new Map<number, string[]>();
          for (const key of subscribed.keys()) {
            if (room(key) <= 0) { this.taskBacklog.add(key); continue; }
            this.taskBacklog.delete(key);
            const cursor = this.taskCursors.get(key)!;
            positions.set(cursor, [...positions.get(cursor) ?? [], key]);
          }
          for (const [cursor, keys] of positions) {
            const batch = await read(cursor, Math.min(25, ...keys.map(room)));
            if (!valid()) return;
            if (batch.cursor < cursor || batch.events.some((e) => e.id <= cursor || e.id > batch.cursor)) throw new Error('Invalid task event cursor');
            for (const event of batch.events) {
              for (const key of keys) if (wantsTask(subscribed.get(key)!, event)) this.taskQueue.push({ subscription: key, event });
            }
            if (batch.cursor !== cursor) more = true;
            for (const key of keys) this.taskCursors.set(key, batch.cursor);
          }
          this.taskEventsFailed = false;
        } catch (error) {
          if (this.lifetime.signal.aborted) throw error;
          // A passing failure keeps the cursor, so changes made meanwhile still run. History that no longer
          // reaches it (a replaced database) starts again from the tail rather than replaying.
          if (/Invalid task event cursor|Cursor is ahead/.test(`${(error as Error).message} ${(error as { stderr?: unknown }).stderr ?? ''}`)) { this.taskCursors.clear(); this.taskBacklog.clear(); this.taskQueue = []; }
          if (!this.taskEventsFailed) { this.taskEventsFailed = true; this.log(); }
        }
      }
      try {
        // A watcher without field events has no field history to read.
        for (const watcher of intake ? this.enabled.filter((w) => w.fieldEvents.length) : []) {
          const state = this.db.prepare('SELECT cursor FROM fw_watchers WHERE id=?').get(watcher.id) as { cursor: number };
          const batch = Batch.parse(await this.note(['field-events', '--after', String(state.cursor), '--limit', '25']));
          if (!valid()) return;
          if (batch.cursor < state.cursor || batch.events.some((e) => e.id <= state.cursor || e.id > batch.cursor)) throw new Error('Invalid field event cursor');
          if (batch.cursor !== state.cursor) {
            this.transaction(() => {
              for (const event of batch.events) {
                this.clear(watcher.id, event.taskId, event.field);
                if (watcher.fieldEvents.includes(event.event) && (!watcher.fields.length || watcher.fields.includes(event.field))) this.save({ watcherId: watcher.id, event, due: Date.now(), attempts: 0 });
              }
              for (const taskId of new Set(batch.events.map((event) => event.taskId))) this.prunePRNotices(watcher.id, taskId);
              this.db.prepare('UPDATE fw_watchers SET cursor=? WHERE id=?').run(batch.cursor, watcher.id);
            });
            drained = true;
          }
        }
      } catch (error) {
        // Startup and task events do not depend on field history; unchanged settings still allow them.
        try { if (valid()) this.dispatch(false); } catch { /* Reported below. */ }
        throw error;
      }
      if (drained) this.changed();
      else if (intake && !more) { this.drained = version; this.drainDue = Date.now() + RECHECK_MS; }
      // Superseded pending changes are coalesced before any field check runs; startup and task events need not wait.
      this.dispatch(!drained);
    } finally {
      // Invocations in flight keep the lease; the last one to finish releases it.
      if (!this.running.size) this.release();
    }
  }
  private startupWatchers(): Set<string> {
    return new Set(this.enabled.filter((watcher) => watcher.appEvents.includes('startup')).map((watcher) => watcher.id));
  }
  /** Start the next invocation of each idle watcher outside its cooldown, up to CONCURRENCY at once.
   * Startup goes first; task events and field checks take turns. Without `fieldChecks`, only events start. */
  private dispatch(fieldChecks: boolean): void {
    const due = (this.db.prepare('SELECT job FROM fw_jobs').all() as Row[]).map(({ job }) => ({ raw: job, job: JSON.parse(job) as Job }))
      .filter(({ job }) => job.due !== null && job.due <= Date.now()).sort((a, b) => a.job.due! - b.job.due!);
    // Round robin: the first watchers cannot hold every slot.
    const offset = this.enabled.findIndex((watcher) => watcher.id === this.admitted) + 1;
    for (const watcher of [...this.enabled.slice(offset), ...this.enabled.slice(0, offset)]) {
      if (this.running.size >= CONCURRENCY) return;
      const last = this.started.get(watcher.id);
      if (this.running.has(watcher.id) || last !== undefined && Date.now() < last + watcher.cooldownSeconds * 1000) continue;
      let work: ((signal: AbortSignal) => Promise<void>) | undefined, input = checkInput;
      if (this.startup?.has(watcher.id)) {
        this.startup.delete(watcher.id);
        if (watcher.appEvents.includes('startup')) { work = (signal) => this.runStartup(watcher, signal); input = startupInput; }
      }
      if (!work) {
        const queued = this.taskQueue.findIndex((item) => item.subscription === subscription(watcher));
        const job = due.find((item) => item.job.watcherId === watcher.id);
        if (queued >= 0 && (!job || !fieldChecks || !this.taskTurn.has(watcher.id))) {
          const { event } = this.taskQueue.splice(queued, 1)[0];
          this.taskTurn.add(watcher.id); work = (signal) => this.runTask(watcher, event, signal); input = taskInput;
        } else if (job && fieldChecks) {
          this.taskTurn.delete(watcher.id); work = (signal) => this.runCheck(watcher, job.raw, job.job, signal);
        }
      }
      if (!work) continue;
      this.admitted = watcher.id;
      const controller = new AbortController(), start = work;
      const promise = (async () => { await start(controller.signal); })().catch(() => {
        if (!controller.signal.aborted && !this.lifetime.signal.aborted) this.log();
      }).finally(() => {
        this.running.delete(watcher.id);
        if (this.running.size) return;
        clearInterval(this.poll); this.poll = undefined;
        if (!this.ticking && this.db.isOpen) this.release();
      });
      this.running.set(watcher.id, { input, key: input(watcher), controller, promise });
      // Settings changes cancel affected invocations; the lease is renewed while any run.
      this.poll ??= setInterval(() => {
        try {
          // Another process may have taken an expired lease: its scheduler runs these watchers now.
          if (!this.db.prepare('UPDATE fw_scheduler SET lease_until=? WHERE id=1 AND owner=? AND lease_until>?').run(Date.now() + 90_000, this.owner, Date.now()).changes) throw new Error('Field scheduler lease lost');
          this.reconcile(true);
        } catch { for (const run of this.running.values()) run.controller.abort(); }
      }, 100);
    }
  }
  /** After each await: still the same watcher settings, scheduler and lease. */
  private current(signal: AbortSignal): boolean {
    this.reconcile(true);
    return !signal.aborted && !this.lifetime.signal.aborted && this.leased();
  }
  private failure(run: { result: FieldResult } | { error: unknown }): string {
    return 'error' in run && run.error instanceof FieldHandlerFailure ? run.error.message : 'Watcher check failed';
  }
  private async runStartup(watcher: FieldWatcher, signal: AbortSignal): Promise<void> {
    const run = await this.invoke(watcher, { version: 1, scope: 'app', eventId: `startup:${this.owner}`, event: 'startup' }, signal);
    if (run && ('error' in run || run.result.state === 'error')) this.log({ watcher: watcher.name, watcherId: watcher.id, taskId: null, field: 'app:startup',
      reason: this.failure(run), lastSuccess: null, retryAt: null });
  }
  private async runTask(watcher: FieldWatcher, queued: TaskEvent, signal: AbortSignal): Promise<void> {
    const { id, taskId, event, fields } = queued;
    const run = await this.invoke(watcher, { version: 1, scope: 'task', eventId: String(id), event, taskId, fields }, signal);
    if (run && ('error' in run || run.result.state === 'error')) this.log({ watcher: watcher.name, watcherId: watcher.id, taskId, field: `task:${event}`,
      reason: this.failure(run), lastSuccess: null, retryAt: null });
  }
  /** `raw` is the saved job this check started from: intake or a reset meanwhile supersedes its outcome. */
  private async runCheck(watcher: FieldWatcher, raw: string, job: Job, signal: AbortSignal): Promise<void> {
    const event = job.event;
    const unchanged = () => (this.db.prepare('SELECT job FROM fw_jobs WHERE watcher_id=? AND task_id=? AND field=?')
      .get(job.watcherId, event.taskId, event.field) as Row | undefined)?.job === raw;
    const task = await this.note(['agent', 'get', String(event.taskId)]) as Task;
    // Intake or a reset meanwhile replaced this job: the newer one runs instead.
    if (!this.current(signal) || !unchanged()) return;
    const currentValue = task && ['active', 'in_progress'].includes(task.state) ? task.agent_notes[event.field] ?? null : null;
    if (event.value !== currentValue) {
      if (this.transaction(() => unchanged() && (this.clear(job.watcherId, event.taskId, event.field), this.prunePRNotices(job.watcherId, event.taskId), true))) this.changed();
      return;
    }
    const run = await this.invoke(watcher, {
      version: 1, eventId: `${event.id}:${event.field}`, taskId: event.taskId, field: event.field,
      event: job.checkedAt ? 'check' : event.event, value: event.value, previousValue: event.previousValue,
      ...(job.result ? { previousResult: job.result } : {}),
    }, signal);
    // Reconciled first: a cancellation by disabling also clears the watcher's saved state now.
    if (!this.current(signal) || !run) return;
    if ('error' in run || run.result.state === 'error') {
      const retryAfterSeconds = 'result' in run ? run.result.recheckAfterSeconds ?? 0 : 0;
      job.attempts++; job.stale = true;
      job.result ??= { state: 'error', summary: 'Field handler unavailable', display: { color: 'muted' } };
      job.due = Date.now() + Math.max(retryAfterSeconds, Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7))) * 1000;
      if (!this.transaction(() => unchanged() && (this.save(job), true))) return;
      this.changed();
      this.log({ watcher: watcher.name, watcherId: watcher.id, taskId: event.taskId, field: event.field,
        reason: 'result' in run ? 'Watcher reported unavailable data; check dependencies, authentication and connectivity' : this.failure(run),
        lastSuccess: job.checkedAt ?? null, retryAt: new Date(job.due).toISOString() });
      return;
    }
    const result = run.result;
    const latest = await this.note(['agent', 'get', String(event.taskId)]) as Task;
    if (!this.current(signal)) return;
    if (latest?.updated_at !== task?.updated_at) return; // Includes remove/re-add (ABA); next tick drains new events.
    const saved = this.transaction(() => {
      if (!unchanged()) return false;
      if (event.value === null) { this.clear(job.watcherId, event.taskId, event.field); this.prunePRNotices(job.watcherId, event.taskId); return true; }
      const managed = this.recordPRNotices(watcher, job, latest, result);
      const notification = result.notification;
      if (managed || !notification) this.db.prepare('DELETE FROM fw_notices WHERE watcher_id=? AND task_id=? AND field=?').run(job.watcherId, event.taskId, event.field);
      else if (notification.key !== job.result?.notification?.key || notification.message !== job.result?.notification?.message) {
        this.db.prepare('INSERT INTO fw_notices(watcher_id,task_id,field,id,message) VALUES (?,?,?,?,?) ON CONFLICT(watcher_id,task_id,field) DO UPDATE SET id=excluded.id,message=excluded.message')
          .run(job.watcherId, event.taskId, event.field, randomUUID(), notification.message);
      }
      this.save({ watcherId: job.watcherId, event, result, due: result.recheckAfterSeconds ? Date.now() + result.recheckAfterSeconds * 1000 : null,
        attempts: 0, checkedAt: new Date().toISOString(), stale: false });
      return true;
    });
    if (!saved) return;
    if (result.items?.some((item) => item.state === 'error')) {
      this.log({ watcher: watcher.name, watcherId: watcher.id, taskId: event.taskId, field: event.field,
        reason: 'Watcher reported unavailable data for some items', lastSuccess: job.checkedAt ?? null,
        retryAt: new Date(Date.now() + (result.recheckAfterSeconds ?? 60) * 1000).toISOString() });
    }
    this.changed();
  }
  /** One invocation with the watcher's parameters and time limit; undefined when cancelled meanwhile. */
  private async invoke(watcher: FieldWatcher, input: Record<string, unknown>, signal: AbortSignal): Promise<{ result: FieldResult } | { error: unknown } | undefined> {
    // The cooldown counts from launching the script, not from preparing the check.
    this.started.set(watcher.id, Date.now());
    let outcome: { result: FieldResult } | { error: unknown };
    try { outcome = { result: await runFieldHandler(watcher.path, { ...input, params: watcher.params }, signal, watcher.timeoutSeconds * 1000) }; }
    catch (error) { outcome = { error }; }
    return signal.aborted ? undefined : outcome;
  }
  async close(): Promise<void> {
    this.lifetime.abort(); clearTimeout(this.timer);
    for (const run of this.running.values()) run.controller.abort();
    await this.work; await this.idle();
    this.notes.close();
    try { this.release(); } catch { /* Expires by itself. */ }
    this.db.close();
  }
}
