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
  execFileSync('git', ['init', '--quiet', temp]);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args], { encoding: 'utf8' }));
  const open = async (request: unknown, entries: any[] = [], reason = 'startup', draft = '', mode = 'tui', sessionId = `client-${clients.length}`) => {
    const previous = clients.at(-1);
    if (previous) await previous.handlers.get('session_shutdown')!({ reason: reason === 'reload' ? 'reload' : 'quit' }, previous.ctx);
    if (request === undefined) delete process.env.PINOTE_LAUNCH_TASK;
    else process.env.PINOTE_LAUNCH_TASK = typeof request === 'string' ? request : JSON.stringify(request);
    const handlers = new Map<string, Function>(), commands = new Map<string, any>(), notices: string[] = [];
    const choices: unknown[] = [];
    let shutdowns = 0, idle = true, pullCode = 0;
    const pulls: any[][] = [];
    const pi: any = {
      exec: async (...args: any[]) => {
        pulls.push(args);
        assert.equal(entries.at(-1).data.state.selectedId, null, 'pull only after acknowledged completion');
        assert.equal(shutdowns, 0, 'pull must finish before shutdown');
        return { code: pullCode, killed: false, stdout: '', stderr: '' };
      },
      on: (name: string, handler: Function) => {
        const previous = handlers.get(name);
        handlers.set(name, async (...args: any[]) => { await previous?.(...args); return handler(...args); });
      },
      events: { on() {} }, registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command), registerShortcut() {}, registerEntryRenderer() {},
      appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    };
    pinoteRemote(pi);
    assert.equal(process.env.PINOTE_LAUNCH_TASK, undefined);
    const editor = { text: draft, writes: [] as string[] };
    const ctx: any = { cwd: temp, mode, hasUI: mode === 'tui', isIdle: () => idle, shutdown: () => { shutdowns++; },
      sessionManager: { getBranch: () => entries, getSessionId: () => sessionId, getLeafId: () => 'leaf', getSessionFile: () => join(temp, `${sessionId}.jsonl`) },
      ui: { setWidget() {}, setStatus() {}, getEditorComponent() {}, setEditorComponent() {},
        notify: (message: string) => notices.push(message),
        custom: async () => choices.shift(), select: async () => 'Confirm',
        getEditorText: () => editor.text,
        setEditorText: (text: string) => { editor.text = text; editor.writes.push(text); } } };
    const client = { handlers, ctx, entries, notices, editor,
      pulls, setPullCode: (code: number) => { pullCode = code; },
      get shutdowns() { return shutdowns; }, setIdle: (value: boolean) => { idle = value; },
      choose: async (...values: unknown[]) => { choices.push(...values); await commands.get('pinote').handler('', ctx); } };
    clients.push(client);
    await handlers.get('session_start')!({ reason }, ctx);
    return client;
  };
  try {
    const { startPinoteHttpServer } = await import('../mcp/http.ts');
    service = await startPinoteHttpServer({ port: 0, logPath: join(temp, 'app.log') });
    process.env.PINOTE_URL = service.url;
    const task = cli('agent', 'add', '--text=Kitty launch target');
    const request = { task_id: task.id, updated_at: task.updated_at, prompt: 'is task clear?' };
    const stale = await open({ ...request, updated_at: 'stale-revision' });
    assert.ok(stale.notices.length);
    assert.deepEqual(stale.editor.writes, []);
    assert.equal(stale.entries.at(-1).data.state.selectedId, null);
    assert.equal(cli('agent', 'get', String(task.id)).state, 'active');
    const malformed = await open('not-json');
    assert.ok(malformed.notices.some((notice) => notice.includes('invalid request')));
    const launched = await open(request, [{ type: 'thinking_level_change', thinkingLevel: 'off' }]);
    assert.deepEqual(launched.notices, []);
    assert.equal(launched.editor.text, 'is task clear?');
    assert.deepEqual(launched.editor.writes, ['is task clear?']);
    assert.equal(cli('agent', 'get', String(task.id)).state, 'in_progress');
    assert.equal(launched.entries.at(-1).data.state.selectedId, task.id);
    assert.equal(launched.entries.at(-1).data.state.launch, undefined);
    const revision = cli('agent', 'get', String(task.id)).updated_at;
    await launched.handlers.get('session_start')!({ reason: 'reload' }, launched.ctx);
    assert.equal(launched.entries.at(-1).data.state.selectedId, task.id);
    assert.equal(cli('agent', 'get', String(task.id)).updated_at, revision);
    assert.deepEqual(launched.editor.writes, ['is task clear?']); // Never refill on reload.
    const current = { ...request, updated_at: revision };
    const custom = await open({ ...current, prompt: 'Clarify scope\nthen wait 日本語' });
    assert.equal(custom.editor.text, 'Clarify scope\nthen wait 日本語');
    const occupied = await open(current, [], 'startup', 'Keep my draft');
    assert.equal(occupied.editor.text, 'Keep my draft');
    assert.deepEqual(occupied.editor.writes, []);
    assert.ok(occupied.notices.some((notice) => notice.includes('already contains a draft')));
    for (const prompt of ['', undefined]) {
      const disabled = await open({ ...current, prompt });
      assert.deepEqual(disabled.editor.writes, []);
      assert.equal(disabled.entries.at(-1).data.state.selectedId, task.id);
    }
    const rpc = await open(current, [], 'startup', '', 'rpc');
    assert.deepEqual(rpc.editor.writes, []);
    for (const prompt of [42, 'x'.repeat(4001), '\x1b[31m']) {
      const invalid = await open({ ...current, prompt });
      assert.ok(invalid.notices.some((notice) => notice.includes('invalid request')));
      assert.equal(invalid.entries.at(-1).data.state.selectedId, null);
      assert.deepEqual(invalid.editor.writes, []);
    }
    const other = cli('agent', 'add', '--text=Do not replace the resumed selection');
    const resumed = await open({ task_id: other.id, updated_at: other.updated_at }, [...launched.entries], 'resume');
    assert.equal(resumed.entries.at(-1).data.state.selectedId, task.id);
    assert.deepEqual(resumed.editor.writes, []);
    assert.equal(cli('agent', 'get', String(other.id)).state, 'active');
    // Only acknowledged completion of the launch task closes its dedicated session.
    const closingTask = cli('agent', 'add', '--text=Close dedicated Kitty tab');
    const dedicated = await open({ task_id: closingTask.id, updated_at: closingTask.updated_at });
    dedicated.setIdle(false);
    await dedicated.choose({ id: 'done' });
    dedicated.setIdle(true);
    await dedicated.choose(undefined); // Cancel the task menu.
    assert.equal(dedicated.shutdowns, 0);
    assert.equal(cli('agent', 'get', String(closingTask.id)).state, 'in_progress');
    const reloaded = await open(undefined, [...dedicated.entries], 'reload', '', 'tui', dedicated.ctx.sessionManager.getSessionId());
    await reloaded.choose({ id: 'done' });
    assert.equal(reloaded.shutdowns, 1);
    assert.equal(reloaded.pulls.length, 1);
    assert.deepEqual(reloaded.pulls[0].slice(0, 2), ['git', ['pull', '--ff-only', '--no-rebase', '--no-autostash']]);
    assert.equal(reloaded.pulls[0][2].cwd, temp);
    assert.equal(cli('agent', 'get', String(closingTask.id)).state, 'done');
    assert.equal(reloaded.entries.at(-1).data.state.selectedId, null);

    const next = cli('agent', 'add', '--text=Normal Pi completion stays open');
    const normal = await open(undefined);
    await normal.choose({ id: `select:${next.id}` });
    await normal.choose({ id: 'done' });
    assert.equal(normal.shutdowns, 0);
    assert.equal(normal.pulls.length, 0);
    assert.equal(cli('agent', 'get', String(next.id)).state, 'done');

    const originalTask = cli('agent', 'add', '--text=Launch ownership does not follow other tasks');
    const switched = await open({ task_id: originalTask.id, updated_at: originalTask.updated_at });
    const replacement = cli('agent', 'add', '--text=Replacement task');
    await switched.choose({ id: 'clear' });
    await switched.choose({ id: `select:${replacement.id}` });
    await switched.choose({ id: 'done' });
    assert.equal(switched.shutdowns, 0);
    assert.equal(switched.pulls.length, 0);
    assert.equal(cli('agent', 'get', String(originalTask.id)).state, 'in_progress');
    assert.equal(cli('agent', 'get', String(replacement.id)).state, 'done');

    const failedTask = cli('agent', 'add', '--text=Failed pull keeps completed session open');
    const failed = await open({ task_id: failedTask.id, updated_at: failedTask.updated_at });
    failed.setPullCode(1);
    await failed.choose({ id: 'done' });
    assert.equal(failed.shutdowns, 0);
    assert.equal(failed.pulls.length, 1);
    assert.equal(cli('agent', 'get', String(failedTask.id)).state, 'done');
    assert.ok(failed.notices.some((notice) => notice.includes('git pull failed')));
    await failed.choose({ id: 'done' }); // Completion cannot be replayed after a pull failure.
    assert.equal(failed.pulls.length, 1);

    const saved = JSON.stringify(clients.map((client) => client.entries));
    assert.ok(!saved.includes(process.env.PINOTE_TOKEN!));
    assert.ok(!saved.includes('is task clear?') && !saved.includes('Clarify scope'));
  } finally {
    for (const client of clients) await client.handlers.get('session_shutdown')!({}, client.ctx);
    await service?.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
