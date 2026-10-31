import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const exec = promisify(execFile);
const LIMIT = 256;
type Page = { cursor: number; events: { id: number; task_id: number; timestamp: string }[] };
type Subscriber = { res: ServerResponse; cursor: number | undefined; ready: boolean; heartbeat: number };
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** One bounded CLI scan per tick, shared by all subscribers; no in-memory replay queue. */
export function completionEvents(log: () => void) {
  const subscribers = new Set<Subscriber>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  const reject = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(`${message}\n`);
  };
  const drop = (sub: Subscriber) => {
    subscribers.delete(sub);
    if (!subscribers.size) { clearTimeout(timer); timer = undefined; controller?.abort(); }
  };
  const write = (sub: Subscriber, frame: string) => {
    // Disconnect rather than queue unbounded data. Resume from the last persisted ID.
    if (!sub.res.write(frame)) { drop(sub); sub.res.destroy(); }
  };
  const checkpoint = (sub: Subscriber, id: number) => {
    write(sub, `id: ${id}\nevent: checkpoint\ndata: {}\n\n`);
    sub.cursor = id;
  };
  const read = async (after?: number): Promise<Page> => {
    const { stdout } = await exec(process.env.PINOTE_NOTE_COMMAND || 'note',
      ['--no-notify', 'events', '--limit', String(LIMIT), ...(after === undefined ? [] : ['--after', String(after)])],
      { signal: controller!.signal, timeout: 10_000, maxBuffer: 256 * 1024 });
    const page: Page = JSON.parse(stdout);
    if (!safe(page.cursor) || after !== undefined && page.cursor < after || !Array.isArray(page.events) || page.events.length > LIMIT) throw new Error('Invalid event page');
    let previous = after ?? 0;
    for (const event of page.events) {
      if (!safe(event.id) || event.id <= previous || event.id > page.cursor || !safe(event.task_id) || !event.task_id || typeof event.timestamp !== 'string' || event.timestamp.length > 128 || /[\r\n]/.test(event.timestamp)) throw new Error('Invalid completion');
      previous = event.id;
    }
    return page;
  };
  const tick = async () => {
    controller = new AbortController();
    try {
      const pending = [...subscribers].filter((sub) => !sub.ready);
      if (pending.length) {
        const tail = (await read()).cursor;
        // New arrivals must not be validated against a tail captured before they joined.
        for (const sub of pending) {
          if (!subscribers.has(sub)) continue;
          if (sub.cursor !== undefined && sub.cursor > tail) {
            drop(sub); reject(sub.res, 400, 'Last-Event-ID is ahead of current event history'); continue;
          }
          sub.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
          sub.ready = true;
          checkpoint(sub, sub.cursor ?? tail);
        }
      }
      if (!subscribers.size || stopped) return;
      const ready = [...subscribers].filter((sub) => sub.ready);
      if (!ready.length) return;
      const after = Math.min(...ready.map((sub) => sub.cursor!));
      const page = await read(after);
      for (const sub of ready) {
        if (!subscribers.has(sub)) continue;
        for (const event of page.events) {
          if (event.id <= sub.cursor!) continue;
          write(sub, `id: ${event.id}\nevent: task.completed\ndata: ${JSON.stringify({ task_id: event.task_id, timestamp: event.timestamp })}\n\n`);
          sub.cursor = event.id;
          if (!subscribers.has(sub)) break;
        }
        if (!subscribers.has(sub)) continue;
        if (page.cursor > sub.cursor!) checkpoint(sub, page.cursor);
        if (!subscribers.has(sub)) continue;
        if (Date.now() - sub.heartbeat >= 15_000) { write(sub, ': heartbeat\n\n'); sub.heartbeat = Date.now(); }
      }
    } catch {
      if (subscribers.size && !stopped) log();
      for (const sub of subscribers) {
        if (!sub.res.headersSent) reject(sub.res, 503, 'Event history unavailable'); else sub.res.end();
      }
      subscribers.clear();
    } finally { controller = undefined; }
  };
  const schedule = () => {
    if (stopped || running || !subscribers.size) return;
    running = tick().finally(() => {
      running = undefined;
      if (!stopped && subscribers.size) timer = setTimeout(() => { timer = undefined; schedule(); }, 1000);
    });
  };
  return {
    handle(req: IncomingMessage, res: ServerResponse) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reject(res, 405, 'GET required'); }
      const raw = req.headers['last-event-id'];
      if (raw !== undefined && (typeof raw !== 'string' || !/^[0-9]{1,16}$/.test(raw) || !safe(Number(raw)))) return reject(res, 400, 'Last-Event-ID must be a nonnegative safe integer');
      if (stopped || subscribers.size >= 64) return reject(res, 503, 'Event stream limit reached');
      const sub: Subscriber = { res, cursor: raw === undefined ? undefined : Number(raw), ready: false, heartbeat: Date.now() };
      subscribers.add(sub);
      res.once('close', () => drop(sub));
      if (!timer) schedule();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      for (const sub of subscribers) sub.res.end();
      subscribers.clear();
      await running;
    },
  };
}
