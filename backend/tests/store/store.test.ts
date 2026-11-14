import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worktree = fileURLToPath(new URL('../../../', import.meta.url));
const pythonPath = fileURLToPath(new URL('../../../.venv/bin/python', import.meta.url));
import { DatabaseSync } from 'node:sqlite';
import { Store, NoteError, markdown } from '../../src/store.ts';
import { timestamp, validate_tag, validate_text, agentJSON, codepointCompare } from '../../src/compat.ts';
import { parse_reminder_time, local_reminder_time } from '../../src/reminders.ts';

function fixture(t:any) { const dir=mkdtempSync(join(tmpdir(),'pinote-store-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'data','notes.db'); const store=new Store(path); t.after(()=>store.close()); return {store,path,dir}; }
function python(code:string,args:string[]=[]) { const r=spawnSync(pythonPath,['-c',code,...args],{cwd:worktree,encoding:'utf8',env:{...process.env,PYTHONPATH:'src',PYTHONDONTWRITEBYTECODE:'1'}}); assert.equal(r.status,0,r.stderr); return r.stdout; }

test('lifecycle, revisions, private creation, no-ops and transactional rollback',t=>{
 const {store:s,path}=fixture(t);
 assert.equal(statSync(path).mode&0o777,0o600); assert.equal(statSync(join(path,'..')).mode&0o777,0o700);
 const id=s.add('  first\r\n🐦  '); assert.equal(id,1n); const note=s.get(id);
 assert.equal(note.text,'first\n🐦'); assert.equal(s.transition(id,'restore'),false);
 assert.deepEqual(s.edit_with_revision(id,note.text,{expected_updated_at:note.updated_at}),[false,note.updated_at]);
 const [changed,revision]=s.edit_with_revision(id,'changed',{expected_updated_at:note.updated_at}); assert(changed); assert(revision>note.updated_at);
 assert.throws(()=>s.edit(id,'stale',{expected_updated_at:note.updated_at}),NoteError);
 s.connection.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'failed event'); END");
 assert.throws(()=>s.transition(id,'done'),/failed event/); assert.equal(s.get(id).state,'active');
 assert.throws(()=>s.add('rollback',{tag:'New'}),/failed event/); assert.deepEqual(s.tags(),[]);
 s.connection.exec('DROP TRIGGER fail_event');
 s.transition(id,'done'); assert.equal(s.notes().length,0); const archive=s.archived_notes()[0].archived_at;
 s.create_tag('Work'); s.connection.prepare('UPDATE notes SET tag=? WHERE id=?').run('Work',id); s.rename_tag('Work','Other');
 assert.equal(s.archived_notes()[0].archived_at,archive);
 s.transition(id,'restore'); assert.deepEqual(s.history(id).map(r=>r.action),['add','edit','done','tag','restore']);
 assert.equal(s.add('second'),2n); assert.deepEqual(s.query('PRAGMA foreign_key_check'),[]);
});

test('Unicode normalization, Python whitespace, folding, length, codepoint ordering',t=>{
 const {store:s}=fixture(t);
 assert.equal(validate_text('\x1c x \x85'),'x'); assert.equal(validate_text('\ufeffx\ufeff'),'\ufeffx\ufeff');
 assert.equal(validate_text('🐦'.repeat(4096)).length,8192); assert.throws(()=>validate_text('🐦'.repeat(4097)),NoteError);
 for(const v of ['bad\n','bad\ud800','bad\u2028']) assert.throws(()=>validate_tag(v),NoteError);
 assert.equal(validate_tag(' Cafe\u0301 '),'Café'); assert.equal(validate_tag('🐦'.repeat(64)),'🐦'.repeat(64));
 assert.equal(s.create_tag('Straße'),'Straße'); assert.equal(s.create_tag('STRASSE'),'Straße');
 const n=s.add_note('task',{tag:'strasse'}); assert.equal(n.tag,'Straße');
 s.create_tag('\ue000'); s.create_tag('𐀀'); assert.deepEqual(s.tags(),['Straße','\ue000','𐀀']);
 assert(codepointCompare('\ue000','𐀀')<0); assert.equal(timestamp('2999-01-01T00:00:00.999999+00:00'),'2999-01-01T00:00:01.000000+00:00');
});

test('agent validation, literal protected labels, sessions, selections and field pagination',t=>{
 const {store:s,dir}=fixture(t); let n=s.add_note('task',{cwd:dir});
 assert.equal(n.state,'in_progress'); assert.equal(s.selected(dir)?.id,n.id);
 n=s.update_agent(n.id,JSON.parse('{"__proto__":"safe","constructor":"literal","10":"ten","2":"two","PR*":"  keep  "}'),[],{expected_updated_at:n.updated_at});
 assert.equal(n.agent_notes.__proto__,'safe'); assert.equal(({} as any).safe,undefined);
 assert(markdown(n).includes('PR\\*:   keep  ')); assert(markdown(n).indexOf('10: ten')<markdown(n).indexOf('2: two'));
 assert.equal(s.get(n.id).agent_event_id,3n);
 const revision=n.updated_at, history=s.history().length;
 assert.deepEqual(s.update_agent(n.id,{},[],{expected_updated_at:revision}),n);
 assert.throws(()=>s.update_agent(n.id,{' Cafe\u0301 ':'one','Café':'two'},[],{expected_updated_at:revision}),/unique/);
 assert.throws(()=>s.update_agent(n.id,{a:'x'},['a'],{expected_updated_at:revision}),/same/);
 assert.throws(()=>s.update_agent(n.id,[] as any,[],{expected_updated_at:revision}),/JSON object/);
 assert.throws(()=>s.update_agent(n.id,{a:' '.repeat(4096)+'x'},[],{expected_updated_at:revision}),/4096/);
 assert(s.transition(n.id,'start',{allow_unchanged:true,pi_session_id:'Session.1',expected_updated_at:revision}));
 assert(s.transition(n.id,'start',{allow_unchanged:true,pi_session_id:'Session.2',expected_updated_at:revision}));
 assert.deepEqual(s.get(n.id).pi_sessions,['Session.1','Session.2']); assert.equal(s.get(n.id).updated_at,revision); assert.equal(s.history().length,history);
 assert.throws(()=>s.transition(n.id,'start',{pi_session_id:'invalid\n'}),NoteError);
 s.transition(n.id,'done'); assert.equal(s.selected(dir),null); s.transition(n.id,'rm'); s.transition(n.id,'restore');
 let cursor=0n; const events:any[]=[]; while(cursor<s.history().at(-1)!.id) {const p=s.field_events(cursor,1); assert(p.cursor>cursor); events.push(...p.events); cursor=p.cursor;}
 assert.equal(events.length,15); assert.equal(events[0].field,'10'); assert.equal(events[5].event,'removed'); assert.equal(events[10].event,'added');
 assert.equal(s.completion_events(0n).events.length,1);
 assert.deepEqual(s.field_events(),{cursor,events:[]});
 for(const a of [-1n,9007199254740992n,1 as any,true as any,cursor+1n]) assert.throws(()=>s.field_events(a),/Cursor/);
 for(const l of [0,1001,1.5,true as any]) assert.throws(()=>s.completion_events(0n,l),/Limit/);
});

test('import idempotency, rollback, bigint IDs and bounded cursors',t=>{
 const {store:s}=fixture(t);
 assert.deepEqual(s.import_notes('/empty',[]),{notes:0,tags:0});
 assert.deepEqual(s.import_notes('/source',[['one','active','Work'],['two','done',null]]),{notes:2,tags:1});
 assert.equal(s.import_notes('/source',[['ignored','active','Unused']]),null); assert.deepEqual(s.tags(),['Work']);
 s.connection.exec("UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='notes'");
 const id=s.add('big'); assert.equal(id,9007199254740992n); assert.equal(s.get(id).id,id);
 s.transition(id,'done'); assert.throws(()=>s.completion_events(0n),/Task ID/);
 s.connection.exec("UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='events'"); s.transition(id,'restore');
 assert.throws(()=>s.field_events(),/safe cursor/);
});

test('reminder parsing UTC6, invalid calendars, DST rejection, activation and due indicators',t=>{
 const {store:s}=fixture(t), tz=process.env.TZ; process.env.TZ='Europe/Prague'; t.after(()=>{if(tz===undefined) delete process.env.TZ; else process.env.TZ=tz;});
 assert.equal(parse_reminder_time('2030-01-01 14:30'),'2030-01-01T13:30:00.000000+00:00');
 assert.equal(parse_reminder_time('2030-10-27 02:30:01.123456+02:00'),'2030-10-27T00:30:01.123456+00:00');
 for(const date of ['2030-03-31 02:30','2030-10-27 02:30']) assert.throws(()=>parse_reminder_time(date),/daylight saving/);
 for(const date of ['tomorrow','2030-02-30 12:00','2030-01-01 24:30','0000-01-01 00:00','2030-01-01 12:00:60Z']) assert.throws(()=>parse_reminder_time(date),/date and time/);
 assert.equal(local_reminder_time('2030-01-01T13:30:00.000000+00:00'),'2030-01-01 14:30:00 CET');
 assert.equal(local_reminder_time('2090-07-01T13:30:00.000000+00:00'),'2090-07-01 15:30:00 CEST');
 const n=s.add_note('due'); const due='2999-01-01T00:00:00.123456+00:00'; assert(s.schedule(n.id,due)); assert(!s.schedule(n.id,due)); assert.equal(s.activate_due(),0);
 assert.throws(()=>s.transition(n.id,'start'),/restore/);
 s.connection.prepare('UPDATE notes SET remind_at=? WHERE id=?').run('2000-01-01T00:00:00.123456+00:00',n.id);
 assert(s.has_due()); assert.equal(s.activate_due(),1); assert.equal(s.activate_due(),0);
 assert.equal(s.notes()[0].reminder_due_at,'2000-01-01T00:00:00.123456+00:00');
 s.transition(n.id,'start'); assert(s.notes()[0].reminder_due_at); s.transition(n.id,'done'); s.transition(n.id,'restore'); assert.equal(s.notes()[0].reminder_due_at,null);
});

test('schema8 opens and ordinary polls without acquiring a SQLite write lock',t=>{
 const {store:s,path}=fixture(t); const holder=new DatabaseSync(path); t.after(()=>holder.close()); holder.exec('BEGIN IMMEDIATE');
 const reader=new Store(path); try { assert.deepEqual(reader.notes(),[]); assert.equal(reader.activate_due(),0); assert.deepEqual(reader.history(),[]); assert.throws(()=>reader.add('blocked'),/locked/); } finally {reader.close();holder.exec('ROLLBACK');}
 assert.equal(s.notes().length,0);
});

const snapshot=`
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
print(json.dumps({"schema":[list(r) for r in c.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")],"version":c.execute("PRAGMA user_version").fetchone()[0],"data":{name:[dict(r) for r in c.execute('SELECT * FROM '+name+' ORDER BY 1')] for name in ['notes','events','imports','tags','agent_selections','sqlite_sequence']}}))
`;
for(let version=0;version<=8;version++) test(`Python/Node migration schema/data/sequence parity v${version}`,t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinote-migrate-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const a=join(dir,'a.db'),b=join(dir,'b.db');
 python(`
import sqlite3,sys,shutil,ast
from pinote.store import *
p=sys.argv[1];v=int(sys.argv[3]);c=sqlite3.connect(p)
if v:
 if v==1:
  tree=ast.parse(open('tests/test_progress.py').read())
  legacy=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='LEGACY_SCHEMA' for t in n.targets))
  c.executescript(legacy)
 else:
  for sql in SCHEMA:c.execute(sql)
 for i in range(3,v+1):
  for sql in globals()['MIGRATION_'+str(i)]:c.execute(sql)
 c.execute('PRAGMA user_version='+str(v))
 c.execute("INSERT INTO notes(id,text,state,created_at,updated_at) VALUES (7,'legacy 🐦','active','created','old')")
 if v<3:c.execute("INSERT INTO events(id,note_id,action,state,occurred_at) VALUES (9,7,'add','active','created')")
 else:c.execute("INSERT INTO events(id,note_id,action,state,occurred_at,text) VALUES (9,7,'add','active','created','legacy 🐦')")
 c.execute("UPDATE sqlite_sequence SET seq=40 WHERE name='notes'")
 c.execute("UPDATE sqlite_sequence SET seq=80 WHERE name='events'")
 c.execute("INSERT INTO imports VALUES ('legacy','created',1)")
 c.commit()
c.close();shutil.copyfile(p,sys.argv[2])
with Store(__import__('pathlib').Path(p)):pass
`,[a,b,String(version)]);
 const s=new Store(b); try {
  const expected=JSON.parse(python(snapshot,[a])); const actual=JSON.parse(python(snapshot,[b])); assert.deepEqual(actual,expected);
  assert.deepEqual(s.query('PRAGMA foreign_key_check'),[]); assert.equal(s.row('PRAGMA integrity_check')!.integrity_check,'ok');
  assert.equal(s.add('after'),version?41n:1n);
 } finally{s.close();}
});

test('Python/Node write alternation and agent JSON byte parity',t=>{
 const {store:s,path}=fixture(t); const n=s.add_note('Node',{tag:'Straße'});
 python(`
from pinote.store import Store
from pathlib import Path
import sys
with Store(Path(sys.argv[1])) as s:
 n=s.get(1);s.update_agent(1,{'__proto__':'safe','10':'ten','2':'two','Next':'日本語\\nreview'},[],expected_updated_at=n.updated_at)
 s.add('Python',tag='STRASSE')
`,[path]);
 const current=s.get(n.id); assert.equal(s.get(2n).tag,'Straße');
 const encoded=s.row('SELECT agent_notes FROM notes WHERE id=?',n.id)!.agent_notes; assert.equal(encoded,agentJSON(current.agent_notes));
 assert.equal(s.update_agent(n.id,{},[],{expected_updated_at:current.updated_at}).updated_at,current.updated_at);
 s.transition(n.id,'done');
 const data=JSON.parse(python(`from pinote.store import Store;from pathlib import Path;import sys,json\nwith Store(Path(sys.argv[1])) as s: print(json.dumps({'state':s.get(1).state,'actions':[r['action'] for r in s.history(1)]}))`,[path]));
 assert.deepEqual(data,{state:'done',actions:['add','agent','done']});
});
