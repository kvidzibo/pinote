import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";

// No note data travels through the socket or hyperlink; both identify a local selection.
export function createPreviewBridge() {
  const uid = process.getuid?.();
  const capability = randomBytes(16).toString("hex");
  let server: Server | undefined;
  let socketPath: string | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let closed = false;
  let ready = false;
  let taskId: number | null = null;
  let callback: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  let nonce: string | undefined;
  let suggestionCallback: ((choice: "yes" | "no") => Promise<boolean>) | undefined;
  let suggestionNonce: string | undefined;
  const clients = new Set<Socket>();
  const invalidate = () => { taskId = null; callback = undefined; nonce = undefined; };
  const invalidateSuggestion = () => { suggestionCallback = undefined; suggestionNonce = undefined; };
  const cleanup = async () => {
    ready = false;
    for (const client of clients) client.destroy();
    const instance = server;
    server = undefined;
    if (instance) await new Promise<void>((resolve) => instance.close(() => resolve()));
    const file = socketPath;
    socketPath = undefined;
    if (file) {
      try {
        const st = await fs.lstat(file);
        if (st.isSocket() && st.uid === uid) await fs.unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  const api = {
    async start(): Promise<void> {
      if (closed || uid === undefined) throw new Error("Preview bridge unavailable");
      if (starting) return starting;
      starting = (async () => {
        const dir = `/tmp/pi-note-preview-${uid}`;
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const st = await fs.lstat(dir);
        if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o777) !== 0o700 || closed) {
          throw new Error("Preview bridge unavailable");
        }
        socketPath = join(dir, `${process.pid}-${randomBytes(4).toString("hex")}.sock`);
        const instance = createServer((client) => {
          clients.add(client);
          const request = new AbortController();
          client.on("error", () => client.destroy());
          client.on("close", () => { request.abort(); clients.delete(client); });
          client.setTimeout(5000, () => { request.abort(); client.destroy(); });
          let data = Buffer.alloc(0);
          let dispatched = false;
          client.on("data", (chunk) => {
            if (dispatched || closed) return;
            data = Buffer.concat([data, chunk]);
            if (data.length > 128) { client.destroy(); return; }
            if (!data.includes(10)) return;
            dispatched = true;
            const input = data.toString("utf8");
            const previewMatch = /^preview ([0-9a-f]{32}) ([1-9][0-9]*) ([0-9a-f]{32})\n$/u.exec(input);
            const suggestionMatch = /^(yes|no) ([0-9a-f]{32}) 1 ([0-9a-f]{32})\n$/u.exec(input);
            const id = previewMatch ? Number(previewMatch[2]) : NaN;
            if (previewMatch && previewMatch[0] === input && previewMatch[1] === capability && Number.isSafeInteger(id) &&
                id === taskId && previewMatch[3] === nonce && callback) {
              const invoke = callback;
              const requestNonce = nonce;
              Promise.resolve().then(() => !closed && !request.signal.aborted && taskId === id && nonce === requestNonce && callback === invoke
                ? invoke(request.signal) : false)
                .then((accepted) => { if (!client.destroyed) client.end(accepted === true ? "accepted\n" : "rejected\n"); },
                  () => { if (!client.destroyed) client.end("rejected\n"); });
              return;
            }
            if (suggestionMatch && suggestionMatch[0] === input && suggestionMatch[2] === capability && suggestionMatch[3] === suggestionNonce && suggestionCallback) {
              client.setTimeout(65000);
              const invoke = suggestionCallback;
              const requestNonce = suggestionNonce;
              const choice = suggestionMatch[1] as "yes" | "no";
              // Add/start/select and refresh can run eleven 5s CLI calls; accepted mutations drain on disconnect.
              Promise.resolve().then(() => !closed && suggestionNonce === requestNonce && suggestionCallback === invoke
                ? invoke(choice) : false)
                .then((accepted) => { if (!client.destroyed) client.end(accepted === true ? "accepted\n" : "rejected\n"); },
                  () => { if (!client.destroyed) client.end("rejected\n"); });
              return;
            }
            client.end("rejected\n");
          });
        });
        server = instance;
        try {
          await new Promise<void>((resolve, reject) => {
            instance.once("error", reject);
            instance.listen(socketPath!, resolve);
          });
          await fs.chmod(socketPath, 0o600);
          if (closed) throw new Error("Preview bridge unavailable");
          instance.on("error", () => { void api.stop().catch(() => {}); });
          instance.unref();
          ready = true;
        } catch {
          await cleanup();
          throw new Error("Preview bridge unavailable");
        }
      })();
      return starting;
    },
    setTask(id: number | null, preview: (signal: AbortSignal) => Promise<boolean>): void {
      if (closed) return;
      if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid preview task");
      if (id !== taskId) nonce = id === null ? undefined : randomBytes(16).toString("hex");
      taskId = id;
      callback = id === null ? undefined : preview;
    },
    invalidate,
    url(): string | undefined {
      if (!ready || closed || !socketPath || taskId === null || !nonce) return;
      return `pi-note-preview://${basename(socketPath, ".sock")}/${capability}/${taskId}/${nonce}`;
    },
    setSuggestion(suggestion: (choice: "yes" | "no") => Promise<boolean>): void {
      if (closed) return;
      suggestionCallback = suggestion;
      suggestionNonce = randomBytes(16).toString("hex");
    },
    clearSuggestion(): void { invalidateSuggestion(); },
    suggestionUrl(choice: "yes" | "no"): string | undefined {
      if ((choice !== "yes" && choice !== "no") || !ready || closed || !socketPath || !suggestionNonce || !suggestionCallback) return;
      return `pi-note-preview://${basename(socketPath, ".sock")}/${capability}/1/${suggestionNonce}/${choice}`;
    },
    async stop(): Promise<void> {
      closed = true;
      invalidate();
      invalidateSuggestion();
      if (!stopping) stopping = (async () => { await starting?.catch(() => {}); await cleanup(); })();
      return stopping;
    },
  };
  return api;
}
