import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { remoteConfig } from './remote/client.ts';
import { ENTRY_TYPE } from './remote/session.ts';
import { createEventBus } from '@earendil-works/pi-coding-agent';

const root = dirname(fileURLToPath(import.meta.url));
test('default package loads through Pi and uses real standalone HTTP notes without a local client CLI', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pinote-http-load-'));
  const original = { ...process.env };
  const entries: any[] = [], otherEntries: any[] = [];
  const notices: string[] = [];
  const extensions: any[] = [];
  const buses = new Map<any, ReturnType<typeof createEventBus>>();
  let service: any;
  Object.assign(process.env, { PINOTE_TOKEN: 'isolated-test-token-01234567890123456789',
    PINOTE_NOTE_COMMAND: resolve(root, '../.venv/bin/note'), PI_CODING_AGENT_DIR: join(temp, 'agent'),
    XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state') });
  mkdirSync(join(temp, 'agent'));
  const event = async (extension: any, name: string, ctx: any, data = {}) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(data, ctx);
  };
  const context = (branch: any[], id: string) => ({ cwd: temp, mode: 'rpc', hasUI: false, isIdle: () => true,
    sessionManager: { getSessionFile: () => join(temp, `${id}.jsonl`), getSessionId: () => id, getBranch: () => branch },
    ui: { notify: (message: string) => notices.push(message) } });
  const ctx = context(entries, 'host'), otherCtx = context(otherEntries, 'vm');
  try {
    const { startPinoteHttpServer } = await import(pathToFileURL(join(root, 'dist-mcp/mcp/http.js')).href);
    service = await startPinoteHttpServer({ port: 0, logPath: join(temp, 'app.log') });
    process.env.PINOTE_URL = service.url;
    const task = JSON.parse(execFileSync(process.env.PINOTE_NOTE_COMMAND!, ['--no-notify', 'agent', 'add', '--text=Shared host/VM task'], { encoding: 'utf8' }));
    entries.push({ type: 'custom', customType: ENTRY_TYPE, data: { scope: remoteConfig().scope, contextId: 'accepted-host-selection', state: { selectedId: task.id } } });
    const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const { loadExtensions } = await import(pathToFileURL(join(dirname(piEntry), 'core/extensions/loader.js')).href);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi.extensions, ['./remote.ts']);
    const load = async (branch: any[]) => {
      const bus = createEventBus();
      const loaded = await loadExtensions(manifest.pi.extensions.map((path: string) => join(root, path)), temp, bus);
      assert.deepEqual(loaded.errors, []);
      loaded.runtime.appendEntry = (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data });
      // An extension running on the VM must not execute its local `note` command.
      loaded.runtime.exec = () => { throw new Error('Client attempted local CLI execution'); };
      const extension = loaded.extensions[0]; extensions.push(extension); buses.set(extension, bus); return extension;
    };
    const host = await load(entries), vm = await load(otherEntries);
    await event(host, 'session_start', ctx); await event(vm, 'session_start', otherCtx);
    assert.deepEqual([...host.commands.keys()], ['pinote', 'pi-note']);
    assert.equal(host.tools.size, 7);
    const call = (extension: any, name: string, args: any, context: any) => extension.tools.get(`pinote_${name}`).definition.execute(name, args, undefined, undefined, context);
    const parsed = (result: any) => JSON.parse(result.content[0].text);
    assert.equal(parsed(await call(host, 'get_current', {}, ctx)).id, task.id);
    let queried: Promise<unknown> | undefined;
    buses.get(host)!.emit('pinote:query-current', { signal: new AbortController().signal, respond: (reply: any) => { queried = reply.result; } });
    assert.ok(queried, 'PR watch can query the dedicated extension without gateway or CLI');
    assert.equal(parsed(await queried).id, task.id);
    assert.equal(parsed(await call(vm, 'get_current', {}, otherCtx)), null);
    assert.equal(parsed(await call(vm, 'get_task', { task_id: task.id }, otherCtx)).text, task.text);
    const updated = parsed(await call(host, 'update_current', { expected_updated_at: task.updated_at, set: { Next: 'Continue in VM' } }, ctx));
    assert.equal(updated.agent_notes.Next, 'Continue in VM');
    assert.equal(parsed(await call(vm, 'get_task', { task_id: task.id }, otherCtx)).agent_notes.Next, 'Continue in VM');
    await assert.rejects(call(host, 'update_current', { expected_updated_at: task.updated_at, set: { Next: 'Stale' } }, ctx));
    const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await event(host, 'before_agent_start', ctx, prompt);
    assert.match(prompt.systemPromptOptions.sections.pinote_remote, /Continue in VM/);
    assert.ok(!JSON.stringify(entries).includes(process.env.PINOTE_TOKEN!));
    assert.ok(!JSON.stringify(notices).includes(process.env.PINOTE_TOKEN!));
    await service.close();
    await event(host, 'before_agent_start', ctx, prompt);
    assert.match(prompt.systemPromptOptions.sections.pinote_remote, /UNAVAILABLE/);
    assert.doesNotMatch(prompt.systemPromptOptions.sections.pinote_remote, /Continue in VM/);
  } finally {
    for (let i = 0; i < extensions.length; i++) await event(extensions[i], 'session_shutdown', i === 0 ? ctx : otherCtx);
    await service?.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
