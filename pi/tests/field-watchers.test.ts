import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RemoteSession } from '../remote/session.ts';
import { remoteConfig } from '../remote/client.ts';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { discoverFieldWatchers, parseFieldWatchers, validateWatcherExecutable } from '../field-watchers.ts';
import { FieldAutomation } from '../mcp/field-events.ts';

test('bounded configuration, inert fixed discovery and disabled legacy migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-config-'));
  try {
    const path = join(dir, 'custom.mjs'), marker = join(dir, 'ran');
    writeFileSync(path, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o700 });
    validateWatcherExecutable(path);
    const watchers = discoverFieldWatchers({ fieldHandler: path });
    assert.equal(watchers.find((w) => w.path === path)?.enabled, false);
    assert.equal(watchers.find((w) => w.path === path)?.bundled, false);
    assert.ok(watchers.some((w) => w.name === 'GitHub PR' && w.bundled && !w.enabled));
    assert.equal(existsSync(marker), false);
    assert.deepEqual(parseFieldWatchers({ fieldWatchers: [], fieldHandler: 'bad' }), []);
    for (const fieldWatchers of [null, [{ path: 'relative', enabled: true }], [{ path, enabled: 1 }], [{ path, enabled: true }, { path: join(dir, '.', 'custom.mjs'), enabled: false }], Array(33).fill({ path, enabled: true }), [{ path: '/a\n', enabled: false }], [{ path: '/' + 'a'.repeat(4096), enabled: true }]]) {
      assert.throws(() => parseFieldWatchers({ fieldWatchers }));
    }
    assert.deepEqual(parseFieldWatchers({ fieldHandler: null }), [], 'A disabled legacy configuration stays disabled');
    assert.throws(() => validateWatcherExecutable(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent durable watchers, ignored results, immediate disable/removal and in-flight cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-scheduler-'));
  let automation: FieldAutomation | undefined;
  try {
    const path = join(dir, 'state.db'), note = join(dir, 'note.mjs');
    const task = { id: 1, state: 'active', updated_at: 'v1', agent_notes: { PR: 'url' } };
    writeFileSync(note, `#!${process.execPath}\nconst args=process.argv.slice(2); console.log(JSON.stringify(args.includes('field-events') ? {cursor:1,events:Number(args[args.indexOf('--after')+1])===0 ? [{id:1,taskId:1,field:'PR',event:'added',value:'url',previousValue:null}] : []} : ${JSON.stringify(task)}));`, { mode: 0o700 });
    const scripts = ['first', 'second', 'ignored', 'slow'].map((name) => join(dir, `${name}.mjs`));
    scripts.forEach((script, i) => writeFileSync(script, `#!${process.execPath}\n${i === 3 ? `setInterval(()=>{},1000);` : `console.log(JSON.stringify(${i === 2 ? '{}' : JSON.stringify({ state: String(i), notification: { key: 'same', message: String(i) } })}));`}`, { mode: 0o700 }));
    let configs = scripts.slice(0, 3).map((path) => ({ path, enabled: true }));
    const watchers = () => discoverFieldWatchers({ fieldWatchers: configs });
    const open = () => FieldAutomation.open({ path, noteCommand: note, watchers });
    automation = await open();
    await automation.tick();
    for (let i = 0; i < 3; i++) await automation.tick();
    assert.deepEqual(automation.statuses(task).map((s) => s.result.state), ['0', '1']);
    const notices = automation.notices(task, 'a');
    assert.equal(notices.length, 2);
    assert.notEqual(notices[0].id, notices[1].id);
    assert.deepEqual(automation.notices(task, 'b'), []);
    await automation.close(); automation = await open();
    assert.deepEqual(automation.notices(task, 'a'), notices);
    configs[0].enabled = false;
    assert.deepEqual(automation.statuses(task).map((s) => s.result.state), ['1']);
    configs = [configs[0]];
    assert.deepEqual(automation.notices(task, 'a'), []);
    configs[0].enabled = true;
    assert.deepEqual(automation.notices(task, 'a'), [], 'old notices cannot reappear before new checks');
    await automation.tick(); await automation.tick();
    assert.equal(automation.notices(task, 'a').length, 1);
    configs = [{ path: scripts[3], enabled: true }];
    await automation.tick();
    const running = automation.tick();
    await new Promise((r) => setTimeout(r, 250));
    configs = [];
    assert.deepEqual(automation.statuses(task), []);
    await running;
    assert.deepEqual(automation.notices(task, 'a'), []);
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM fw_jobs').get()?.n, 0); } finally { db.close(); }

    // Two watchers x 33 persistent field alerts exceed the wire page limit.
    configs = scripts.slice(0, 2).map((path) => ({ path, enabled: true }));
    automation.statuses(task);
    const many = { ...task, agent_notes: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`F${i}`, 'url'])) };
    const seed = new DatabaseSync(path);
    try {
      for (const watcher of watchers().filter((w) => w.enabled)) for (const field of Object.keys(many.agent_notes)) {
        const result = { notification: { key: field, message: 'Still failing' } };
        const job = { watcherId: watcher.id, event: { id: 1, taskId: 1, field, value: 'url', previousValue: null, event: 'added' }, result, due: null, attempts: 0 };
        seed.prepare('INSERT INTO fw_jobs VALUES (?,?,?,?)').run(watcher.id, 1, field, JSON.stringify(job));
        seed.prepare('INSERT INTO fw_notices VALUES (?,?,?,?,?)').run(watcher.id, 1, field, randomUUID(), 'Still failing');
      }
    } finally { seed.close(); }
    const received: string[] = [];
    const session = new RemoteSession(remoteConfig({ PINOTE_TOKEN: 'x'.repeat(32) }), () => {}, async () => ({
      read: async (_uri, meta) => {
        const caller = meta['native-ui/context'] as { fieldReceipts: string[] };
        const fieldNotifications = automation!.notices(many, 'a', caller.fieldReceipts);
        assert.ok(fieldNotifications.length <= 64);
        return { contents: [{ mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify({ version: 1, title: 'Alerts', revision: 'r', state: { selectedId: 1 }, controls: [], fieldNotifications }) }] };
      },
      tool: async () => ({ content: [] }), action: async () => { throw new Error('No action expected'); }, close: async () => {},
    }));
    session.onFieldNotification = (notice) => { received.push(notice.id); return true; };
    try {
      await session.start([], 'paging');
      assert.equal(received.length, 64);
      for (let i = 0; i < 20 && received.length < 66; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(new Set(received).size, 66, 'Acknowledged alerts cannot starve the next page');
      await session.refresh();
      assert.equal(received.length, 66, 'Persistent conditions remain deduplicated');
    } finally { await session.stop(); }
  } finally { await automation?.close(); rmSync(dir, { recursive: true, force: true }); }
});
