import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createPinoteServer } from './core.ts';
import { pinoteToken } from '../token.ts';

export interface PinoteHttpOptions {
  token?: string;
  host?: string;
  port?: number;
  /** Exact URL authorities, including port. Required for DNS names other than localhost. */
  allowedHosts?: string[];
  /** Exact browser origins. Omitted means all browser Origin headers are rejected. No CORS is enabled. */
  allowedOrigins?: string[];
  maxSessions?: number;
  maxBodyBytes?: number;
  idleTtlMs?: number;
  logPath?: string;
}

function diagnostic(path: string, event: string): void {
  const line = `${new Date().toISOString()} Pinote HTTP ${event}\n`;
  process.stdout.write(line);
  try { appendFileSync(path, line, { mode: 0o600 }); }
  catch { process.stdout.write('Pinote HTTP log write failed\n'); }
}

/** Remote deployments MUST use a private VPN or trusted TLS reverse proxy.
 * Forward Host unchanged or explicitly allow the proxy authority; never expose this plaintext listener publicly.
 * PINOTE_TOKEN is mandatory; PINOTE_HOST/PORT and PINOTE_LOG_PATH configure the CLI.
 * No request arguments, results, tokens, or exception messages are logged.
 */
export async function startPinoteHttpServer(options: PinoteHttpOptions = {}) {
  const token = options.token === undefined ? pinoteToken() : pinoteToken({ PINOTE_TOKEN: options.token });
  const host = options.host ?? process.env.PINOTE_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PINOTE_PORT ?? 8765);
  const maxSessions = options.maxSessions ?? 64;
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const ttl = options.idleTtlMs ?? 30 * 60_000;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || ![maxSessions, maxBody, ttl].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid HTTP limits or port');
  const logPath = resolve(options.logPath ?? process.env.PINOTE_LOG_PATH ?? 'app.log');
  mkdirSync(dirname(logPath), { recursive: true });
  // Fail startup if the configured log is not writable.
  appendFileSync(logPath, '', { mode: 0o600 });
  const log = (event: string) => diagnostic(logPath, event);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${token}`);
  type Session = { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createPinoteServer>; busy: number; streams: number; touched: number };
  const sessions = new Map<string, Session>();
  const all = new Set<Session>();
  let stopping = false;
  const configuredHosts = options.allowedHosts ?? process.env.PINOTE_ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);
  if (configuredHosts?.some((value) => !/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]+)?$/.test(value))) throw new Error('Invalid allowed HTTP authority');
  let allowedHosts = new Set(configuredHosts);
  const reject = (res: ServerResponse, status: number) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(`${status}\n`); };
  const single = (req: IncomingMessage, name: string) => {
    const values = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name);
    return values.length <= 1;
  };
  const listener = createServer(async (req, res) => {
    let created: Session | undefined;
    try {
      for (const name of ['authorization', 'host', 'origin', 'mcp-session-id', 'mcp-protocol-version', 'content-type', 'content-length', 'accept', 'last-event-id']) {
        if (!single(req, name)) return reject(res, 400);
      }
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return reject(res, 401);
      }
      if (!allowedHosts.has(req.headers.host ?? '')) return reject(res, 403);
      if (req.headers.origin !== undefined && !options.allowedOrigins?.includes(req.headers.origin)) return reject(res, 403);
      if (req.url !== '/mcp') return reject(res, 404);
      if (stopping) return reject(res, 503);
      if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { res.setHeader('Allow', 'GET, POST, DELETE'); return reject(res, 405); }
      const id = req.headers['mcp-session-id'];
      if (id !== undefined && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) return reject(res, 400);
      let session = typeof id === 'string' ? sessions.get(id) : undefined;
      if (id && !session) return reject(res, 404);
      const track = (current: Session) => {
        current.streams++;
        current.touched = Date.now();
        let released = false;
        const release = () => { if (!released) { released = true; current.streams--; current.touched = Date.now(); } };
        res.once('close', release);
        res.once('finish', release);
      };
      if (session) track(session);
      let body: unknown;
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reject(res, 415);
        if (Number(req.headers['content-length'] ?? 0) > maxBody) return reject(res, 413);
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBody) return reject(res, 413);
          chunks.push(Buffer.from(chunk));
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(res, 400); }
      }
      if (stopping) return reject(res, 503);
      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(body) || Array.isArray(body)) return reject(res, 400);
        if (all.size >= maxSessions) return reject(res, 503);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => { sessions.set(sessionId, entry); },
        });
        const entry: Session = { transport, server: undefined!, busy: 0, streams: 0, touched: Date.now() };
        entry.server = createPinoteServer({
          onError: () => log('protocol or notification failed'),
          onBusy: (delta) => { entry.busy += delta; entry.touched = Date.now(); },
          onClose: () => { all.delete(entry); if (transport.sessionId) sessions.delete(transport.sessionId); log('session closed'); },
        });
        all.add(entry);
        created = entry;
        session = entry;
        track(entry);
        await entry.server.connect(transport);
        log('session opened');
      } else if (isInitializeRequest(body)) return reject(res, 400);
      const current = session;
      await current.transport.handleRequest(req, res, body);
      if (current.transport.sessionId && all.has(current)) sessions.set(current.transport.sessionId, current);
      else await current.server.close();
    } catch {
      if (created) await created.server.close().catch(() => {});
      log('request failed');
      if (!res.headersSent) reject(res, 500); else res.end();
    }
  });
  listener.requestTimeout = 30_000;
  listener.headersTimeout = 10_000;
  await new Promise<void>((ok, fail) => { listener.once('error', fail); listener.listen(port, host, () => { listener.off('error', fail); ok(); }); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${address.port}`;
  if (!configuredHosts) {
    // Never trust arbitrary DNS names or wildcard listen addresses by default.
    if (host === 'localhost' || isIP(host) && host !== '0.0.0.0' && host !== '::') allowedHosts = new Set([authority]);
  }
  const timer = setInterval(() => {
    for (const session of all) {
      if (!session.busy && !session.streams && Date.now() - session.touched >= ttl) {
        session.touched = Infinity;
        void session.server.close().catch(() => log('session cleanup failed'));
      }
    }
  }, Math.min(ttl, 30_000));
  timer.unref();
  log('listening; remote access requires private VPN or TLS reverse proxy');
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    stopping = true;
    clearInterval(timer);
    const closed = new Promise<void>((ok) => listener.close(() => ok()));
    const force = setTimeout(() => listener.closeAllConnections(), 3000);
    try {
      await Promise.allSettled([...all].map((session) => session.server.close()));
      await closed;
    } finally { clearTimeout(force); log('stopped'); }
  })();
  return { listener, url: `http://${authority}/mcp`, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const service = await startPinoteHttpServer();
    const stop = (code = 0) => {
      const deadline = setTimeout(() => process.exit(1), 5000);
      service.close().then(() => { clearTimeout(deadline); process.exit(code); }, () => process.exit(1));
    };
    const fatal = () => { diagnostic(resolve(process.env.PINOTE_LOG_PATH ?? 'app.log'), 'fatal runtime error'); stop(1); };
    process.once('uncaughtException', fatal);
    process.once('unhandledRejection', fatal);
    process.on('warning', () => diagnostic(resolve(process.env.PINOTE_LOG_PATH ?? 'app.log'), 'runtime warning'));
    process.once('SIGTERM', () => stop());
    process.once('SIGINT', () => stop());
  } catch {
    // Startup exceptions can contain paths or third-party data: do not print them.
    const line = 'Pinote HTTP startup failed; check token, listener and writable log configuration\n';
    process.stdout.write(line);
    try { appendFileSync(resolve(process.env.PINOTE_LOG_PATH ?? 'app.log'), line, { mode: 0o600 }); } catch { /* An unwritable log can itself be the startup failure. */ }
    process.exitCode = 1;
  }
}
