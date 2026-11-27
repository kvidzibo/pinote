import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import pinote from '../index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('GUI launch consent selects exactly one revision, persists, and never replaces or replays', async () => {
  initTheme('dark', false);
  const temp = mkdtempSync(join(tmpdir(), 'pinote-kitty-'));
  const original = { ...process.env };
  delete process.env.KITTY_LISTEN_ON; // No live terminal controls in the mocked UI test.
  let exec: (command: string, args: string[]) => Promise<unknown> = async () => assert.fail('completion must not run Git, even with an unavailable upstream');
  const clients: { handlers: Map<string, Function>; ctx: any; entries: any[]; notices: string[] }[] = [];
  Object.assign(process.env, {
    PINOTE_NOTE_COMMAND: join(root, 'backend/bin/note'), PI_CODING_AGENT_DIR: join(temp, 'agent'),
    XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'),
  });
  mkdirSync(join(temp, 'agent'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=completion-test', temp]);
  execFileSync('git', ['-C', temp, 'remote', 'add', 'origin', join(temp, 'upstream')]);
  execFileSync('git', ['-C', temp, 'config', 'branch.completion-test.remote', 'origin']);
  execFileSync('git', ['-C', temp, 'config', 'branch.completion-test.merge', 'refs/heads/main']);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', ...args], { encoding: 'utf8' }));
  const open = async (request: unknown, entries: any[] = [], reason = 'startup', draft = '', mode = 'tui', sessionId = randomUUID()) => {
    const previous = clients.at(-1);
    if (previous) await previous.handlers.get('session_shutdown')!({ reason: reason === 'reload' || reason === 'new' ? reason : 'quit' }, previous.ctx);
    if (request === undefined) delete process.env.PINOTE_LAUNCH_TASK;
    else process.env.PINOTE_LAUNCH_TASK = typeof request === 'string' ? request : JSON.stringify(request);
    const handlers = new Map<string, Function>(), commands = new Map<string, any>(), notices: string[] = [];
    const choices: unknown[] = [];
    let shutdowns = 0, idle = true;
    const pi: any = {
      exec: (command: string, args: string[]) => exec(command, args),
      on: (name: string, handler: Function) => {
        const previous = handlers.get(name);
        handlers.set(name, async (...args: any[]) => { await previous?.(...args); return handler(...args); });
      },
      events: { on() {}, emit() {} }, registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command), registerShortcut() {}, registerEntryRenderer() {},
      appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    };
    pinote(pi);
    assert.equal(process.env.PINOTE_LAUNCH_TASK, undefined);
    const editor = { text: draft, writes: [] as string[] };
    const ctx: any = { cwd: temp, mode, hasUI: mode === 'tui', isIdle: () => idle, shutdown: () => { shutdowns++; },
      sessionManager: { getBranch: () => entries, getSessionId: () => sessionId, getLeafId: () => 'leaf', getSessionFile: () => join(temp, `${sessionId}.jsonl`) },
      ui: { setWidget() {}, setStatus() {}, getEditorComponent() {}, setEditorComponent() {},
        notify: (message: string) => notices.push(message),
        custom: async (factory: any) => {
          let component: any;
          try { return await new Promise((resolve) => {
            component = factory({ terminal: { rows: 40, columns: 120 }, requestRender() {} },
              { fg: (_color: string, text: string) => text }, getKeybindings(), resolve);
            component.render(120);
            if (!component.handleInput) return; // Loader resolves only after real task work.
            const choice = choices.shift() as string | undefined;
            if (choice === undefined) { component.handleInput('\x1b'); return; }
            for (let i = 0; i < 80; i++) {
              if (component.render(120).some((row: string) => row.includes('→') && row.includes(choice))) {
                component.handleInput('\r'); return;
              }
              component.handleInput('\x1b[B');
            }
            assert.fail(`Menu choice not found: ${choice}`);
          }); } finally { component?.dispose(); }
        },
        select: async (_title: string, values: string[]) => {
          assert.equal(values[0], 'Cancel');
          assert.match(values[1], /^Complete task/);
          return values[1];
        },
        getEditorText: () => editor.text,
        setEditorText: (text: string) => { editor.text = text; editor.writes.push(text); } } };
    const client = { handlers, ctx, entries, notices, editor,
      cards: () => entries.filter((entry) => entry.customType === 'pinote-startup-task').map((entry) => entry.data),
      selection: () => entries.filter((entry) => entry.customType === 'pinote-remote-v1').at(-1).data.state,
      get shutdowns() { return shutdowns; }, setIdle: (value: boolean) => { idle = value; },
      choose: async (...values: unknown[]) => { choices.push(...values); await commands.get('pinote').handler('', ctx); } };
    clients.push(client);
    await handlers.get('session_start')!({ reason, previousSessionFile: previous?.ctx.sessionManager.getSessionFile() }, ctx);
    return client;
  };
  try {
    const task = cli('agent', 'add', '--text=Kitty launch target\n\n- A **Markdown** detail beyond the title.\n\n```python\nif ready:\n\tprocess()\n```');
    const request = { task_id: task.id, updated_at: task.updated_at, prompt: 'is task clear?' };
    const stale = await open({ ...request, updated_at: 'stale-revision' });
    assert.ok(stale.notices.length);
    assert.deepEqual(stale.editor.writes, []);
    assert.equal(stale.selection().selectedId, null);
    assert.equal(cli('agent', 'get', String(task.id)).state, 'active');
    assert.deepEqual(cli('agent', 'get', String(task.id))['pi-sessions'], [], 'Stale launches never record sessions');
    const malformed = await open('not-json');
    assert.ok(malformed.notices.some((notice) => notice.includes('invalid request')));
    const launched = await open(request, [{ type: 'thinking_level_change', thinkingLevel: 'off' }]);
    assert.deepEqual(launched.notices, []);
    const card = { id: task.id, text: task.text };
    assert.deepEqual(launched.cards(), [card]);
    assert.equal(launched.editor.text, 'is task clear?');
    assert.deepEqual(launched.editor.writes, ['is task clear?']);
    assert.equal(cli('agent', 'get', String(task.id)).state, 'in_progress');
    assert.equal(launched.selection().selectedId, task.id);
    assert.equal(launched.selection().launch, undefined);
    const revision = cli('agent', 'get', String(task.id)).updated_at;
    await launched.handlers.get('session_start')!({ reason: 'reload' }, launched.ctx);
    assert.equal(launched.selection().selectedId, task.id);
    assert.equal(cli('agent', 'get', String(task.id)).updated_at, revision);
    assert.deepEqual(launched.cards(), [card], 'Reload does not duplicate the display entry');
    assert.deepEqual(launched.editor.writes, ['is task clear?']); // Never refill on reload.
    const launchSession = launched.ctx.sessionManager.getSessionId();
    assert.deepEqual(cli('agent', 'get', String(task.id))['pi-sessions'], [launchSession]);
    await launched.choose('Clear');
    await launched.choose('Kitty launch target');
    assert.deepEqual(cli('agent', 'get', String(task.id))['pi-sessions'], [launchSession], 'Reselection deduplicates the actual Pi ID');
    assert.equal(cli('agent', 'get', String(task.id)).updated_at, revision);
    const current = { ...request, updated_at: revision };
    const custom = await open({ ...current, prompt: 'Clarify scope\nthen wait 日本語' });
    assert.equal(custom.editor.text, 'Clarify scope\nthen wait 日本語');
    const sessions = [launchSession, custom.ctx.sessionManager.getSessionId()];
    assert.deepEqual(cli('agent', 'get', String(task.id))['pi-sessions'], sessions);
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    const { message } = await custom.handlers.get('before_agent_start')!(event, custom.ctx);
    assert.equal(message.customType, 'pinote-context');
    assert.equal(message.display, false);
    const { service: contextService, text } = JSON.parse(message.content);
    assert.equal(contextService, 'pinote');
    assert.ok(text.includes('pi-sessions'));
    for (const id of sessions) {
      assert.ok(text.includes(id));
      assert.ok(!event.systemPromptOptions.sections.pinote_remote.includes(id));
    }
    const occupied = await open(current, [], 'startup', 'Keep my draft');
    assert.equal(occupied.editor.text, 'Keep my draft');
    assert.deepEqual(occupied.editor.writes, []);
    assert.ok(occupied.notices.some((notice) => notice.includes('already contains a draft')));
    for (const prompt of ['', undefined]) {
      const disabled = await open({ ...current, prompt });
      assert.deepEqual(disabled.editor.writes, []);
      assert.equal(disabled.selection().selectedId, task.id);
    }
    const rpc = await open(current, [], 'startup', '', 'rpc');
    assert.deepEqual(rpc.editor.writes, []);
    assert.deepEqual(rpc.cards(), []);
    for (const prompt of [42, 'x'.repeat(4001), '\x1b[31m']) {
      const invalid = await open({ ...current, prompt });
      assert.ok(invalid.notices.some((notice) => notice.includes('invalid request')));
      assert.equal(invalid.selection().selectedId, null);
      assert.deepEqual(invalid.editor.writes, []);
    }
    const other = cli('agent', 'add', '--text=Do not replace the resumed selection');
    const resumed = await open({ task_id: other.id, updated_at: other.updated_at }, [...launched.entries], 'resume');
    assert.equal(resumed.selection().selectedId, task.id);
    assert.deepEqual(resumed.editor.writes, []);
    assert.equal(cli('agent', 'get', String(other.id)).state, 'active');
    const retained = await open(undefined, [], 'new');
    assert.deepEqual(retained.cards(), [card], 'A retained selection is displayed in the new transcript');
    await retained.choose('Clear');
    assert.deepEqual((await open(undefined, [], 'new')).cards(), []);
    // By default, acknowledged completion exits Pi, so Kitty closes a launched tab.
    const closingTask = cli('agent', 'add', '--text=Close dedicated Kitty tab');
    const dedicated = await open({ task_id: closingTask.id, updated_at: closingTask.updated_at });
    dedicated.setIdle(false);
    await dedicated.choose('Complete');
    dedicated.setIdle(true);
    await dedicated.choose(undefined); // Cancel the task menu.
    assert.equal(dedicated.shutdowns, 0);
    assert.equal(cli('agent', 'get', String(closingTask.id)).state, 'in_progress');
    dedicated.notices.length = 0;
    await dedicated.choose('Complete');
    assert.equal(dedicated.shutdowns, 1);
    assert.deepEqual(dedicated.notices, [], 'completion exits without Git warnings');
    assert.equal(cli('agent', 'get', String(closingTask.id)).state, 'done');
    assert.equal(dedicated.selection().selectedId, null);

    // The setting applies to every Pi session, launched or not.
    const next = cli('agent', 'add', '--text=Normal Pi completion exits too');
    const normal = await open(undefined);
    await normal.choose('Normal Pi completion exits too');
    await normal.choose('Complete');
    assert.equal(normal.shutdowns, 1);
    assert.equal(cli('agent', 'get', String(next.id)).state, 'done');

    writeFileSync(join(temp, 'agent', 'pi-note.json'), JSON.stringify({ onTaskComplete: 'keep-open' }));
    const keptTask = cli('agent', 'add', '--text=Launched Pi stays open');
    const kept = await open({ task_id: keptTask.id, updated_at: keptTask.updated_at });
    await kept.choose('Complete');
    assert.equal(kept.shutdowns, 0);
    assert.equal(cli('agent', 'get', String(keptTask.id)).state, 'done');

    // A Kitty tab keeps the task it was opened for: a new conversation there continues it, one agent per task.
    const tabTask = cli('agent', 'add', '--text=Continue in this Kitty tab');
    let holder: string | undefined;
    Object.assign(process.env, { KITTY_WINDOW_ID: '42', KITTY_LISTEN_ON: 'unix:/tmp/isolated-kitty-test', KITTY_PID: String(process.pid), XDG_RUNTIME_DIR: join(temp, 'run') });
    delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;
    exec = async (_command, args) => ({ code: 0, stderr: '', stdout: args[3] !== 'ls' ? '' : JSON.stringify([{ tabs: [
      { id: 4, windows: [{ id: 41, user_vars: { pinote_task: String(tabTask.id) } }] },
      { id: 5, windows: [{ id: 42, user_vars: {} }, { id: 43, user_vars: holder === undefined ? {} : { pinote_task: holder } }] }] }]) });
    await open({ task_id: tabTask.id, updated_at: tabTask.updated_at });
    assert.equal(readFileSync(join(temp, 'run/pinote/kitty-tabs', `${process.pid}-5`), 'utf8'), String(tabTask.id));
    holder = String(tabTask.id);
    assert.equal((await open(undefined)).selection().selectedId, null, 'Another Pi in the tab already holds the task');
    holder = String(keptTask.id);
    const continued = await open(undefined);
    assert.equal(continued.selection().selectedId, tabTask.id);
    assert.deepEqual(continued.cards(), [{ id: tabTask.id, text: tabTask.text }]);
    assert.deepEqual(continued.notices, [`Pinote: continuing this Kitty tab's task #${tabTask.id}.`]);
    await continued.choose('Clear');
    assert.equal((await open(undefined, [], 'new')).selection().selectedId, tabTask.id, '/new continues the tab task too');
    assert.equal((await open(undefined, [{ type: 'message' }])).selection().selectedId, null, 'A resumed conversation keeps its own state');
    process.env.KITTY_WINDOW_ID = '41';
    assert.equal((await open(undefined)).selection().selectedId, null, 'Other tabs are unaffected');

    const saved = JSON.stringify(clients.map((client) => client.entries));
    assert.ok(!saved.includes('is task clear?') && !saved.includes('Clarify scope'));
  } finally {
    for (const client of clients) await client.handlers.get('session_shutdown')!({}, client.ctx);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
