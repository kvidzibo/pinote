import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { FieldAutomation } from '../mcp/field-events.ts';

test('per-PR receipts retain an undelivered failure across alias recovery, restart and list edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinote-pr-receipts-'));
  const path = join(dir, 'state.db'), data = join(dir, 'data.json'), mode = join(dir, 'mode.json');
  const note = join(dir, 'note.mjs'), watcher = join(dir, 'watcher.mjs');
  const a = 'https://github.com/example/repo/pull/1', b = 'https://github.com/example/repo/pull/2';
  const c = 'https://github.com/example/repo/pull/3';
  const failureA = { state: 'failed', notification: { key: 'a-head', message: 'A failed' }, recheckAfterSeconds: 60 };
  const failureB = { state: 'failed', notification: { key: 'b-head', message: 'B failed' } };
  const task = { id: 1, state: 'in_progress', updated_at: '1', agent_notes: { PR: a } as Record<string, string> };
  const events = [{ id: 1, taskId: 1, field: 'PR', event: 'added', value: a, previousValue: null as string | null }];
  const save = () => writeFile(data, JSON.stringify({ task, events }));
  const setMode = (PR: unknown, PRs: unknown) => writeFile(mode, JSON.stringify({ PR, PRs }));
  const batch = (items: unknown[]) => ({ state: 'multiple', items, notification: { key: 'batch', message: 'PR failure' }, recheckAfterSeconds: 60 });
  await writeFile(note, `#!/usr/bin/env node
import {readFileSync} from 'node:fs';
const state=JSON.parse(readFileSync(${JSON.stringify(data)},'utf8')), args=process.argv.slice(2).filter(arg=>arg!=='--no-notify');
if(args[0]==='field-events'){const after=Number(args[args.indexOf('--after')+1]);const events=state.events.filter(event=>event.id>after);console.log(JSON.stringify({cursor:events.at(-1)?.id??after,events}));}
else if(args[0]==='agent'&&args[1]==='get')console.log(JSON.stringify(state.task));
else process.exit(1);
`, { mode: 0o700 });
  await writeFile(watcher, `#!/usr/bin/env node
import {readFileSync} from 'node:fs';const event=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(JSON.parse(readFileSync(${JSON.stringify(mode)},'utf8'))[event.field]??{}));
`, { mode: 0o700 });
  const open = () => FieldAutomation.open({ path, noteCommand: note, watchers: () => [{ id: 'github-test', path: watcher, enabled: true, bundled: true, name: 'GitHub PR' }] });
  const due = (field: string) => {
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE fw_jobs SET job=json_set(job,'$.due',0) WHERE field=?").run(field); } finally { db.close(); }
  };
  let automation: FieldAutomation | undefined;
  try {
    await save(); await setMode(failureA, {}); automation = await open();
    await automation.tick(); await automation.tick();
    const legacy = automation.notices(task, 'owner')[0];
    assert.equal(legacy.field, 'PR');
    task.agent_notes.PRs = `${a}\n${b}`; task.updated_at = '2';
    events.push({ id: 2, taskId: 1, field: 'PRs', event: 'added', value: task.agent_notes.PRs, previousValue: null });
    await save(); await setMode(failureA, batch([{ url: a, state: 'error' }, { url: b, ...failureB }]));
    await automation.tick(); await automation.tick();
    const pending = automation.notices(task, 'owner', [legacy.id]);
    assert.equal(pending.length, 1); assert.match(pending[0].message, /B failed/);
    const bId = pending[0].id;
    await setMode(failureA, batch([{ url: a, ...failureA }, { url: b, ...failureB }]));
    due('PRs'); await automation.tick();
    assert.equal(automation.notices(task, 'owner', [legacy.id])[0].id, bId, 'A recovery never overwrites B’s undelivered receipt');
    const grouped = automation.notices(task, 'owner', [], true);
    assert.equal(grouped.length, 1);
    assert.deepEqual(new Set(grouped[0].receiptIds), new Set([legacy.id, bId]));
    await setMode(failureA, batch([{ url: a, ...failureA }, { url: b, ...failureB, notification: { ...failureB.notification, message: 'B'.repeat(980) } }]));
    due('PRs'); await automation.tick();
    const bounded = automation.notices(task, 'owner', [], true);
    assert.equal(bounded.length, 2, 'A group never acknowledges a PR omitted by the message budget');
    assert.ok(bounded.every((notice) => !notice.receiptIds && notice.message.length <= 1000));
    await automation.close(); automation = await open();
    assert.equal(automation.notices(task, 'owner', [legacy.id], true)[0].id, bId);
    assert.deepEqual(automation.notices(task, 'owner', [legacy.id, bId], true), []);

    // A confirmed recovery ends the condition even if the batch still holds its old failure.
    await setMode({ state: 'passing', recheckAfterSeconds: 60 }, batch([{ url: a, ...failureA }, { url: b, ...failureB }]));
    due('PR'); await automation.tick();
    assert.deepEqual(automation.notices(task, 'owner', [legacy.id, bId]), []);
    due('PRs'); await automation.tick();
    const recurrence = automation.notices(task, 'owner', [legacy.id, bId]);
    assert.equal(recurrence.length, 1); assert.notEqual(recurrence[0].id, legacy.id, 'A new same-head failure gets a new receipt');

    const previousValue = task.agent_notes.PRs;
    task.agent_notes.PRs = `${b}\n${c}`; task.updated_at = '3';
    events.push({ id: 3, taskId: 1, field: 'PRs', event: 'changed', value: task.agent_notes.PRs, previousValue });
    await save(); await setMode({ state: 'passing' }, batch([{ url: b, ...failureB }, { url: c, state: 'passing' }]));
    await automation.tick(); await automation.tick();
    assert.deepEqual(automation.notices(task, 'owner', [legacy.id, bId, recurrence[0].id]), [], 'Unchanged B retains its acknowledgement across list edits');

    // Upgrade a released single-PR scheduler without losing its client receipt.
    await setMode(failureA, {}); due('PR'); await automation.tick();
    const oldId = automation.notices(task, 'owner').find((notice) => notice.field === 'PR')!.id;
    const canonicalKey = `pr:example/repo:1:${'a'.repeat(64)}`;
    task.agent_notes.PR = a.replace('/example/repo/', '/Example/Repo/'); task.updated_at = '4'; await save();
    await automation.close(); automation = undefined;
    const db = new DatabaseSync(path);
    try {
      db.prepare('INSERT OR REPLACE INTO fw_notices(watcher_id,task_id,field,id,message) VALUES (?,?,?,?,?)').run('github-test', 1, 'PR', oldId, failureA.notification.message);
      db.prepare("UPDATE fw_jobs SET job=json_set(job,'$.event.value',?,'$.result.notification.key',?) WHERE field='PR'")
        .run(task.agent_notes.PR, canonicalKey.replace('example/repo', 'Example/Repo'));
      db.exec("DROP TABLE fw_pr_notices; UPDATE fw_jobs SET job=json_set(job,'$.result',json('{}')) WHERE field='PRs'; DELETE FROM fw_notices WHERE field='PRs'");
    } finally { db.close(); }
    automation = await open();
    assert.ok(oldId);
    assert.equal(automation.notices(task, 'owner')[0].id, oldId);
    assert.deepEqual(automation.notices(task, 'owner', [oldId, bId, recurrence[0].id]), [], 'Historical legacy IDs remain valid after the additive migration');
    await setMode({ ...failureA, notification: { ...failureA.notification, key: canonicalKey } }, {});
    due('PR'); await automation.tick();
    assert.equal(automation.notices(task, 'owner')[0].id, oldId, 'Canonicalized GitHub owner/repo casing does not replace a migrated receipt');
    assert.deepEqual(automation.notices(task, 'owner', [oldId]), []);
  } finally {
    await automation?.close(); await rm(dir, { recursive: true, force: true });
  }
});
