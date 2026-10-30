import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pinoteRemote from '../remote.ts';
import type { startPinoteHttpServer } from '../mcp/http.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('GUI launch consent selects exactly one revision, persists, and never replaces or replays', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pinote-kitty-'));
  const original = { ...process.env };
  const clients: { handlers: Map<string, Function>; ctx: any; entries: any[]; notices: string[] }[] = [];
  let service: Awaited<ReturnType<typeof startPinoteHttpServer>> | undefined;
  Object.assign(process.env, {
    PINOTE_TOKEN: 'isolated-kitty-launch-token-0123456789',
    PINOTE_NOTE_COMMAND: join(root, '.venv/bin/note'), PI_CODING_AGENT_DIR: join(temp, 'agent'),
    XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'),
  });
  mkdirSync(join(temp, 'agent'));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args], { encoding: 'utf8' }));
  const open = async (request: unknown, entries: any[] = [], reason = 'startup') => {
    process.env.PINOTE_LAUNCH_TASK = typeof request === 'string' ? request : JSON.stringify(request);
    const handlers = new Map<string, Function>(), notices: string[] = [];
    const pi: any = {
      on: (name: string, handler: Function) => {
        const previous = handlers.get(name);
        handlers.set(name, async (...args: any[]) => { await previous?.(...args); return handler(...args); });
      },
      events: { on() {} }, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {},
      appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    };
    pinoteRemote(pi);
    assert.equal(process.env.PINOTE_LAUNCH_TASK, undefined);
    const ctx: any = { cwd: temp, mode: 'rpc', hasUI: false, isIdle: () => true,
      sessionManager: { getBranch: () => entries, getSessionId: () => `client-${clients.length}`, getSessionFile: () => join(temp, `${clients.length}.jsonl`) },
      ui: { notify: (message: string) => notices.push(message) } };
    const client = { handlers, ctx, entries, notices }; clients.push(client);
    await handlers.get('session_start')!({ reason }, ctx);
    return client;
  };
  try {
    const { startPinoteHttpServer } = await import('../mcp/http.ts');
    service = await startPinoteHttpServer({ port: 0, logPath: join(temp, 'app.log') });
    process.env.PINOTE_URL = service.url;
    const task = cli('agent', 'add', '--text=Kitty launch target');
    const request = { task_id: task.id, updated_at: task.updated_at };
    const stale = await open({ ...request, updated_at: 'stale-revision' });
    assert.ok(stale.notices.length);
    assert.equal(stale.entries.at(-1).data.state.selectedId, null);
    assert.equal(cli('agent', 'get', String(task.id)).state, 'active');
    const malformed = await open('not-json');
    assert.ok(malformed.notices.some((notice) => notice.includes('invalid request')));
    const launched = await open(request, [{ type: 'thinking_level_change', thinkingLevel: 'off' }]);
    assert.deepEqual(launched.notices, []);
    assert.equal(cli('agent', 'get', String(task.id)).state, 'in_progress');
    assert.equal(launched.entries.at(-1).data.state.selectedId, task.id);
    assert.equal(launched.entries.at(-1).data.state.launch, undefined);
    const revision = cli('agent', 'get', String(task.id)).updated_at;
    await launched.handlers.get('session_start')!({ reason: 'reload' }, launched.ctx);
    assert.equal(launched.entries.at(-1).data.state.selectedId, task.id);
    assert.equal(cli('agent', 'get', String(task.id)).updated_at, revision);
    const other = cli('agent', 'add', '--text=Do not replace the resumed selection');
    const resumed = await open({ task_id: other.id, updated_at: other.updated_at }, [...launched.entries], 'resume');
    assert.equal(resumed.entries.at(-1).data.state.selectedId, task.id);
    assert.equal(cli('agent', 'get', String(other.id)).state, 'active');
    const saved = JSON.stringify(clients.map((client) => client.entries));
    assert.ok(!saved.includes(process.env.PINOTE_TOKEN!));
  } finally {
    for (const client of clients) await client.handlers.get('session_shutdown')!({}, client.ctx);
    await service?.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
