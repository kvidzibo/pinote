import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FieldAutomation, runFieldHandler, type WatcherFailureLog } from '../mcp/field-events.ts';
import { discoverFieldWatchers } from '../field-watchers.ts';
import { ViewSchema } from '../remote/protocol.ts';

const exec = promisify(execFile);
test('durable field lifecycle: checks, restart, scoped notices, styles, stale results and bounded scripts', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-fields-'));
  const names = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR', 'PINOTE_NOTE_COMMAND'];
  const previous = names.map((n) => process.env[n]);
  const command = fileURLToPath(new URL('../../backend/bin/note', import.meta.url));
  Object.assign(process.env, { XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: pathToFileURL(dir).href, PINOTE_NOTE_COMMAND: command });
  const path = join(dir, 'state.db'), handler = join(dir, 'handler.mjs'), mode = join(dir, 'mode.json'), calls = join(dir, 'calls.jsonl');
  await writeFile(handler, `#!/usr/bin/env node
import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(calls)},JSON.stringify(input)+'\\n');
const result=JSON.parse(readFileSync(${JSON.stringify(mode)},'utf8'));
if(result.wait) { while(!existsSync(${JSON.stringify(join(dir, 'release'))})) await new Promise(r=>setTimeout(r,10)); }
if(result.invalid) console.log('not json');
else if(result.large) console.log('x'.repeat(100000));
else {delete result.wait; console.log(JSON.stringify(result));}
`, { mode: 0o700 });
  const note = async (...args: string[]) => JSON.parse((await exec(command, ['--no-notify', ...args])).stdout);
  const setMode = (value: unknown) => writeFile(mode, JSON.stringify(value));
  const callLog = async () => (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  let automation: FieldAutomation | undefined, client: Client | undefined, server: ReturnType<typeof import('../mcp/core.ts')['createPinoteServer']> | undefined;
  let changes = 0, errors = 0;
  const diagnostics: WatcherFailureLog[] = [];
  const open = () => FieldAutomation.open({ watchers: () => discoverFieldWatchers({ fieldWatchers: [{ path: handler, enabled: true }] }), path, noteCommand: command, changed: () => changes++, log: (failure) => { errors++; if (failure) diagnostics.push(failure); } });
  const forceDue = () => {
    const db = new DatabaseSync(path);
    try { db.exec("UPDATE fw_jobs SET job=json_set(job, '$.due', 0)"); } finally { db.close(); }
  };
  try {
    await writeFile(join(dir, 'pi-note.json'), JSON.stringify({ fieldWatchers: [{ path: handler, enabled: true }], footer: { fields: [{ name: 'PR', format: '#<number>' }] } }));
    let task = await note('agent', 'add', '--text=Watch PR');
    const update = async (fields: Record<string, string>, remove: string[] = []) => {
      task = await note('agent', 'get', String(task.id));
      task = await note('agent', 'update', String(task.id), '--expected-updated-at', task.updated_at, '--set-json', JSON.stringify(fields), ...remove.map((field) => `--remove=${field}`));
    };
    const pr = 'https://github.com/example/repo/pull/42';
    await update({ PR: pr });
    automation = await open();
    await setMode({ state: 'pending', recheckAfterSeconds: 10 });
    await automation.tick(); // Durable event intake.
    await automation.tick(); // First invocation.
    assert.equal((await callLog())[0].event, 'added');
    assert.equal(automation.statuses(task)[0].result.state, 'pending');
    await automation.close(); automation = await open();
    await automation.tick();
    assert.equal((await callLog()).length, 1, 'restart retains the future deadline');

    await setMode({ state: 'failed', display: { color: 'error' }, notification: { key: 'head:failed', message: 'CI failed' }, recheckAfterSeconds: 10 });
    forceDue(); await automation.tick();
    assert.equal((await callLog()).at(-1).event, 'check');
    const notices = automation.notices(task, 'session-a');
    assert.equal(notices.length, 1);
    assert.deepEqual(automation.notices(task, 'session-b'), []);
    forceDue(); await automation.tick();
    assert.deepEqual(automation.notices(task, 'session-a'), notices, 'identical failure has a stable receipt ID');

    // Actual MCP resources use the same durable status, without changing the URL/task revision.
    const { createPinoteServer } = await import('../mcp/core.ts');
    server = createPinoteServer({ fieldAutomation: automation, watcherLogPath: join(dir, 'app.log') });
    client = new Client({ name: 'field-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    const meta = (feature = true, selectedId: number | null = task.id) => ({ 'native-ui/context': { conversationId: 'session-a', state: { selectedId } }, 'native-ui/features': { fieldEvents: feature, watcherDiagnostics: feature, footerNativeActions: true } });
    const view = async (feature = true, selectedId: number | null = task.id) => {
      const resource = await client!.readResource({ uri: 'pinote://ui', _meta: meta(feature, selectedId) });
      return ViewSchema.parse(JSON.parse((resource.contents[0] as { text: string }).text));
    };
    assert.equal((await view()).fieldNotifications?.length, 1);
    const acknowledged = await client.readResource({ uri: 'pinote://ui', _meta: {
      ...meta(), 'native-ui/context': { ...meta()['native-ui/context'], fieldReceipts: notices.map((notice) => notice.id) },
    } });
    assert.deepEqual(ViewSchema.parse(JSON.parse((acknowledged.contents[0] as { text: string }).text)).fieldNotifications, []);
    assert.deepEqual((await view(true, null)).fieldNotifications, []);
    const legacy = await view(false);
    assert.equal(legacy.fieldNotifications, undefined);
    assert.equal(legacy.watcherDiagnostics, undefined);
    assert.ok(legacy.footer!.every((item) => !item.style));

    // Invalid output and reported errors retain the last known result, marked stale.
    await setMode({ invalid: true }); forceDue(); await automation.tick();
    assert.equal(errors, 1);
    assert.equal(automation.statuses(task)[0].stale, true);
    assert.equal(automation.statuses(task)[0].result.state, 'failed');
    assert.equal(diagnostics[0].reason, 'Invalid watcher JSON or result schema');
    assert.equal(diagnostics[0].taskId, task.id);
    assert.equal(diagnostics[0].field, 'PR');
    assert.ok(diagnostics[0].lastSuccess);
    assert.ok(Date.parse(diagnostics[0].retryAt) > Date.now());
    assert.ok(!JSON.stringify(diagnostics).includes(pr), 'No field values or script output in diagnostics');
    const failureView = await view();
    assert.equal(failureView.watcherDiagnostics?.logPath, join(dir, 'app.log'));
    assert.deepEqual(failureView.watcherDiagnostics?.failures[0].fields, ['PR']);
    const staleContext = await client.readResource({ uri: 'pinote://agent-context', _meta: meta() });
    assert.doesNotMatch((staleContext.contents[0] as { text: string }).text, /Field automation results|Invalid watcher|app\.log/);
    assert.deepEqual(automation.notices(task, 'session-a'), []);
    await setMode({ state: 'error' }); forceDue(); await automation.tick();
    assert.equal(automation.statuses(task)[0].stale, true);

    await setMode({ state: 'merged', display: { strikethrough: true, color: 'muted' }, recheckAfterSeconds: null });
    forceDue(); await automation.tick();
    const merged = await view();
    assert.deepEqual(merged.watcherDiagnostics?.failures, []);
    assert.ok(merged.footer!.some((item) => item.text.includes('#42') && item.style?.color === 'accent' && item.style.strikethrough === false),
      'Previously cached merged PRs use the theme accent without strikethrough');
    assert.ok(merged.footer!.some((item) => item.url === pr), 'link stays clickable');
    assert.deepEqual(merged.fieldNotifications, []);
    const context = await client.readResource({ uri: 'pinote://agent-context', _meta: meta() });
    assert.match((context.contents[0] as { text: string }).text, /merged/);
    const unchanged = await note('agent', 'get', String(task.id));
    assert.equal(unchanged.updated_at, task.updated_at);
    assert.equal(unchanged.agent_notes.PR, pr);
    const count = (await callLog()).length;
    await automation.tick(); assert.equal((await callLog()).length, count, 'terminal result stops scheduling');

    // Remove/re-add the same URL while the subprocess runs: revision fencing rejects it.
    await setMode({ state: 'passing', wait: true, recheckAfterSeconds: 10 });
    forceDue();
    const running = automation.tick();
    for (let i = 0; i < 200 && (await callLog()).length === count; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await callLog()).length, count + 1);
    await update({}, ['PR']); await update({ PR: pr });
    await writeFile(join(dir, 'release'), ''); await running;
    assert.equal(automation.statuses(task)[0].result.state, 'merged', 'stale output is never applied');
    await automation.tick(); // Intake invalidates old results even with the same URL.
    assert.deepEqual(automation.statuses(task), []);
    await setMode({ state: 'pending', recheckAfterSeconds: 10 }); await automation.tick();
    await update({}, ['PR']); await automation.tick(); await automation.tick();
    assert.equal((await callLog()).at(-1).event, 'removed');
    assert.deepEqual(automation.statuses(task), []);

    // A competing process cannot execute while the durable lease is held.
    await update({ PR: pr }); await automation.tick();
    const db = new DatabaseSync(path);
    db.prepare('UPDATE fw_scheduler SET owner=?,lease_until=?').run('another-process', Date.now() + 60_000);
    const beforeLease = (await callLog()).length;
    await automation.tick(); assert.equal((await callLog()).length, beforeLease);
    db.exec('UPDATE fw_scheduler SET lease_until=0'); db.close();
    await automation.tick();
    assert.ok(changes > 0);

    // Valid large fields/results must not break otherwise-readable task context.
    await update(Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`Field${index}`, 'v'.repeat(900)])), ['PR']);
    await setMode({ state: 'passing', summary: 's'.repeat(1000), notification: { key: 'large', message: 'n'.repeat(1000) } });
    await automation.tick();
    for (let index = 0; index < 33; index++) await automation.tick();
    const largeResource = await client.readResource({ uri: 'pinote://agent-context', _meta: meta() });
    const largeContext = JSON.parse((largeResource.contents[0] as { text: string }).text).text;
    assert.ok(largeContext.length <= 64_000);
    assert.match(largeContext, /"omitted":[1-9]/);
    assert.ok(largeContext.includes('v'.repeat(900)), 'complete field values remain in task context');

    await setMode({ large: true });
    await assert.rejects(runFieldHandler(handler, {}, new AbortController().signal));
    const sleeper = join(dir, 'sleep.mjs');
    await writeFile(sleeper, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n', { mode: 0o700 });
    await assert.rejects(runFieldHandler(sleeper, {}, new AbortController().signal, 50));
  } finally {
    await client?.close(); await server?.close(); await automation?.close();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(dir, { recursive: true, force: true });
  }
});
