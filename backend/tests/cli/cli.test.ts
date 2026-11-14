import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { arguments_, positive_id, event_cursor, event_limit } from '../../src/cli.ts';
const entry = resolve(import.meta.dirname, '../../src/cli-entry.ts');
function fixture(t: {after(fn:()=>void):void}) {
  const root = mkdtempSync(join(tmpdir(),'pinote-cli-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin = join(root,'bin'); mkdirSync(bin);
  const database = join(root,'data/pinote/notes.db');
  const capture = join(root,'render');
  writeFileSync(join(bin,'dunstify'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', {mode:0o700});
  const env = {...process.env, HOME:root, XDG_DATA_HOME:join(root,'data'), XDG_STATE_HOME:join(root,'state'), PATH:`${bin}:/usr/bin:/bin`, CAPTURE:capture, TZ:'UTC'};
  const cli = (...args:string[]) => spawnSync(process.execPath,['--experimental-strip-types',entry,...args],{env,encoding:'utf8'});
  const ok = (...args:string[]) => { const result=cli(...args); assert.equal(result.status,0, result.stdout+result.stderr); return result.stdout; };
  return {root,bin,database,capture,cli,ok,env};
}
test('argument validation is exact for bigint IDs and bounded event cursors',()=>{
  assert.equal(positive_id('9223372036854775807'),9223372036854775807n);
  assert.equal(positive_id(' +١_٢ '),12n);
  for(const id of ['0','-1','9223372036854775808','no']) assert.throws(()=>positive_id(id));
  assert.equal(event_cursor('9007199254740991'),9007199254740991n);
  for(const id of ['+1','-1','9007199254740992','1.0']) assert.throws(()=>event_cursor(id));
  for(const limit of ['0','1001']) assert.throws(()=>event_limit(limit));
  assert.equal(arguments_([]).command,'list');
  assert.equal(arguments_(['gui']).command,'add');
  assert.equal(arguments_(['--no-notify','hello']).no_notify,true);
  assert.deepEqual(arguments_(['add','--','--literal']).text,['--literal']);
});
test('help/version/invalid input are side effect free',t=>{
  const f=fixture(t);
  assert.equal(f.ok('--version'),'pinote 0.26.0\n');
  assert.match(f.ok('--help'),/durable history/);
  for(const args of [['done','0'],['show','unexpected'],['done'],['agent','update','1']]) assert.equal(f.cli(...args).status,2);
  for(const args of [['--no-notify','add',' '],['schedule','1','2000-01-01T00:00:00Z'],['agent','add','--text','ok','--tag','\n'],['agent','update','1','--expected-updated-at','x','--set-json','{"Next":false}']]) assert.equal(f.cli(...args).status,1);
  for(const session of ['', 'bad/id', '-bad', 'a'.repeat(257)]) assert.equal(f.cli('agent','start','1','--expected-updated-at','x','--pi-session-id',session).status,1);
  assert.ok(!existsSync(f.database)); assert.ok(!existsSync(join(f.root,'state/pinote/app.log'))); assert.ok(!existsSync(join(f.root,'data/pinote/display.lock')));
  f.ok('--no-notify','due reminder');
  const db=new DatabaseSync(f.database);
  try {
    db.exec("UPDATE notes SET state='scheduled',remind_at='2000-01-01T00:00:00.000000+00:00' WHERE id=1");
    const before=db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    assert.equal(f.cli('agent','start','1','--expected-updated-at','x','--pi-session-id','bad/id').status,1);
    assert.equal(db.prepare('SELECT state FROM notes WHERE id=1').get()!.state,'scheduled');
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()!.n,before);
  } finally {db.close();}
});
test('lifecycle, scheduling, import/export and bounded event scans',t=>{
  const f=fixture(t);
  assert.equal(f.ok('--no-notify','check backups'),'Added note 1.\n');
  f.ok('--no-notify','another'); assert.equal(f.ok(),'1. check backups\n2. another\n');
  f.ok('start','1','--no-notify'); assert.match(f.ok(),/\[in progress\]/);
  f.ok('done','1','--no-notify'); f.ok('rm','2','--no-notify');
  assert.equal(f.ok(),'No active notes.\n');
  assert.equal(JSON.parse(f.ok('events')).cursor,5);
  const page=JSON.parse(f.ok('events','--after','0','--limit','3')); assert.equal(page.cursor,3); assert.deepEqual(page.events,[]);
  assert.equal(JSON.parse(f.ok('events','--after','3')).events[0].task_id,1);
  f.ok('restore','1','--no-notify');
  assert.match(f.ok('schedule','1','2099-04-10 12:30','--no-notify'),/scheduled for 2099-04-10 12:30:00 UTC/);
  assert.equal(f.ok(),'No active notes.\n'); assert.match(f.ok('reminders'),/check backups/);
  assert.match(f.ok('history','1'),/reminder none -> 2099/);
  assert.equal(f.ok('export','--all'),'# Reminders\n\n');
  f.ok('restore','1','--no-notify');
  const source=join(f.root,'notes.md');writeFileSync(source,'- Work\n  - [~] job\n      detail\n- [x] old\n');
  assert.equal(f.ok('import',source,'--no-notify'),'Imported 2 notes. Tags created: 1.\n');
  symlinkSync(source,join(f.root,'alias.md'));
  assert.match(f.ok('import',join(f.root,'alias.md'),'--no-notify'),/already imported/);
  assert.match(f.ok('export','--all'),/- \[~\] job\n    detail/);
  const db=new DatabaseSync(f.database); try {db.exec("UPDATE notes SET state='scheduled',remind_at='2000-01-01T00:00:00.000000+00:00' WHERE id=1");} finally{db.close();}
  assert.match(f.ok(),/check backups/); assert.equal(f.ok('reminders'),'No scheduled reminders.\n');
});
test('agent revisions, selection, prototype-safe fields, sessions and field pagination',t=>{
  const f=fixture(t);
  let task=JSON.parse(f.ok('agent','add','--text=Task','--tag=Work','--cwd',f.root));
  assert.equal(task.state,'in_progress'); assert.deepEqual(JSON.parse(f.ok('agent','tags')),['Work']);
  assert.equal(JSON.parse(f.ok('agent','selected','--cwd',f.root)).id,task.id);
  task=JSON.parse(f.ok('agent','start','1','--expected-updated-at',task.updated_at,'--pi-session-id','session-1'));
  assert.deepEqual(task['pi-sessions'],['session-1']);
  const old=task.updated_at;
  task=JSON.parse(f.ok('agent','update','1','--expected-updated-at',old,'--set-json','{"__proto__":"literal","PR":"#1"}'));
  assert.equal(task.agent_notes.__proto__,'literal'); assert.match(task.markdown,/## Agent/);
  assert.equal(f.cli('agent','done','1','--expected-updated-at',old).status,1);
  const events=JSON.parse(f.ok('field-events','--after','0')); assert.equal(events.events.length,2);
  assert.equal(events.events[0].field,'PR');
  task=JSON.parse(f.ok('agent','tag','1','--expected-updated-at',task.updated_at,'--clear'));
  assert.equal(task.tag,null);
  f.ok('agent','done','1','--expected-updated-at',task.updated_at);
  assert.equal(f.ok('agent','selected','--cwd',f.root),'null\n');
});
test('bigint output is exact and save precedes notifier failure',t=>{
  const f=fixture(t); f.ok('--no-notify','seed');
  const db=new DatabaseSync(f.database); try{db.exec("UPDATE sqlite_sequence SET seq=9223372036854775805 WHERE name='notes'");}finally{db.close();}
  assert.equal(f.ok('--no-notify','large'),'Added note 9223372036854775806.\n');
  assert.match(f.ok('list','--json'),/"id":9223372036854775806/);
  assert.match(f.ok('agent','get','9223372036854775806'),/"id":9223372036854775806/);
  writeFileSync(join(f.bin,'dunstify'),'#!/bin/sh\nprintf "test: desktop unavailable" >&2\nexit 1\n',{mode:0o700});
  const result=f.cli('saved despite failure'); assert.equal(result.status,0);assert.match(result.stdout,/Added note 9223372036854775807/); assert.match(result.stdout,/Notes saved, but desktop refresh failed/);
  assert.match(f.ok(),/saved despite failure/); assert.equal(f.cli('show').status,1);
  assert.match(readFileSync(join(f.root,'state/pinote/app.log'),'utf8'),/desktop unavailable/);
});
test('parallel saves and desktop renders are serialized, with literal escaping', async t=>{
  const f=fixture(t);
  writeFileSync(join(f.bin,'dunstify'),'#!/bin/sh\nsleep 0.03\nfor arg do last="$arg"; done\nprintf "%s\\n" "$last" >> "$CAPTURE"\n',{mode:0o700});
  const exec=promisify(execFile);
  await Promise.all(Array.from({length:8},(_,i)=>exec(process.execPath,['--experimental-strip-types',entry,`parallel-${i} <&> \\074b\\076`],{env:f.env})));
  const bodies=readFileSync(f.capture,'utf8').trimEnd().split('\n');
  assert.equal(bodies.length,8);
  const last=bodies.at(-1)!;
  for(let i=0;i<8;i++) assert.ok(last.includes(`parallel-${i}`));
  assert.ok(last.includes('&lt;&amp;&gt; \\\\074b\\\\076'));
  const db=new DatabaseSync(f.database);
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM notes').get()!.count,8);
    assert.equal(db.prepare('SELECT count(*) AS count FROM events').get()!.count,8);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  } finally { db.close(); }
});
test('SQLite contention cannot unblock and commit a terminated mutation', async t=>{
  const f=fixture(t); f.ok('--no-notify','seed');
  const holder=new DatabaseSync(f.database); holder.exec('BEGIN IMMEDIATE');
  const child=spawn(process.execPath,['--experimental-strip-types',entry,'--no-notify','must not save after cancellation'],{env:f.env,stdio:'ignore'});
  const closed=new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  try {
    await new Promise(resolve=>setTimeout(resolve,200)); child.kill('SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,200)); holder.exec('ROLLBACK');
    assert.notEqual(await closed,0);
    assert.equal(holder.prepare('SELECT count(*) AS count FROM notes').get()!.count,1);
  } finally { child.kill('SIGKILL'); holder.close(); }
});
test('cancellation during a large synchronous import rolls back every imported note', async t=>{
  const f=fixture(t); f.ok('--no-notify','seed');
  const source=join(f.root,'large.md'); writeFileSync(source,Array.from({length:30000},(_,i)=>`- [ ] imported ${i}\n`).join(''));
  const child=spawn(process.execPath,['--experimental-strip-types',entry,'--no-notify','import',source],{env:f.env,stdio:'ignore'});
  const closed=new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  try {
    const deadline=Date.now()+10000;
    while(!existsSync(f.database+'-journal')&&child.exitCode===null&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(existsSync(f.database+'-journal'),'import transaction has started');
    child.kill('SIGTERM'); assert.equal(await closed,143);
    const db=new DatabaseSync(f.database); try { assert.equal(db.prepare('SELECT count(*) AS count FROM notes').get()!.count,1); assert.equal(db.prepare('SELECT count(*) AS count FROM imports').get()!.count,0); } finally {db.close();}
  } finally {child.kill('SIGKILL');}
});
test('termination during desktop delivery does not write a late warning', async t=>{
  const f=fixture(t);
  writeFileSync(join(f.bin,'dunstify'),'#!/bin/sh\nprintf started > "$CAPTURE"\nsleep 0.3\nprintf unavailable >&2\nexit 1\n',{mode:0o700});
  const child=spawn(process.execPath,['--experimental-strip-types',entry,'committed before cancellation'],{env:f.env,stdio:['ignore','pipe','pipe']});
  const closed=new Promise<number|null>((resolve,reject)=>{child.once('close',code=>resolve(code));child.once('error',reject);});
  for(let i=0;i<200&&!existsSync(f.capture);i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(existsSync(f.capture),'notifier started');
  child.kill('SIGTERM');
  assert.equal(await closed,143);
  assert.equal(readFileSync(join(f.root,'state/pinote/app.log'),'utf8'),'');
  assert.match(f.ok(),/committed before cancellation/);
});
