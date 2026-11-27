import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Frozen databases and expected results; see fixtures/reference/README.md.
const reference = (name:string) => readFileSync(new URL('../fixtures/reference/'+name, import.meta.url), 'utf8');
import { DatabaseSync } from 'node:sqlite';
import { Store, NoteError, markdown } from '../../src/store.ts';
import { timestamp, validate_tag, validate_text, agentJSON, codepointCompare } from '../../src/compat.ts';
import { parse_reminder_time, local_reminder_time } from '../../src/reminders.ts';

function fixture(t:any) { const dir=mkdtempSync(join(tmpdir(),'pinote-store-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'data','notes.db'); const store=new Store(path); t.after(()=>store.close()); return {store,path,dir}; }

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

test('Unicode normalization, whitespace, folding, length, codepoint ordering',t=>{
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
 const taskEvents=s.task_events(0n).events.filter((e:any)=>e.taskId===n.id);
 assert.deepEqual(taskEvents.slice(-3).map((e:any)=>e.event),['completed','removed','restored']);
 assert.deepEqual(taskEvents.at(-3)!.fields,s.get(n.id).agent_notes,'completion carries the fields held before it');
 assert.deepEqual(s.task_events(),{cursor,events:[]});
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
 const {store:s}=fixture(t), tz=process.env.TZ, tzdir=process.env.TZDIR;
 process.env.TZ='Europe/Prague'; delete process.env.TZDIR;
 t.after(()=>{
  if(tz===undefined) delete process.env.TZ; else process.env.TZ=tz;
  if(tzdir!==undefined) process.env.TZDIR=tzdir;
 });
 assert.equal(parse_reminder_time('2030-01-01 14:30'),'2030-01-01T13:30:00.000000+00:00');
 assert.equal(parse_reminder_time('2030-10-27 02:30:01.123456+02:00'),'2030-10-27T00:30:01.123456+00:00');
 for(const date of ['2030-03-31 02:30','2030-10-27 02:30','2090-03-26 02:30','2090-10-29 02:30']) assert.throws(()=>parse_reminder_time(date),/daylight saving/);
 assert.equal(parse_reminder_time('2090-03-26 01:59:59.999999'),'2090-03-26T00:59:59.999999+00:00');
 assert.equal(parse_reminder_time('2090-03-26 03:00'),'2090-03-26T01:00:00.000000+00:00');
 for(const date of ['tomorrow','2030-02-30 12:00','2030-01-01 24:30','0000-01-01 00:00','2030-01-01 12:00:60Z','2030-02-30 12:00+01:00','0001-01-01 00:00']) assert.throws(()=>parse_reminder_time(date),/date and time/);
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
 const reader=new Store(path,{timeout:0}); try { assert.deepEqual(reader.notes(),[]); assert.equal(reader.activate_due(),0); assert.deepEqual(reader.history(),[]); assert.throws(()=>reader.add('blocked'),/locked/); } finally {reader.close();holder.exec('ROLLBACK');}
 assert.equal(s.notes().length,0);
});

// The dumps insert rows before the tables their foreign keys name exist.
function load(path:string,sql:string) { const c=new DatabaseSync(path,{enableForeignKeyConstraints:false}); try { c.exec(sql); } finally { c.close(); } }
const tables=['notes','events','imports','tags','agent_selections','sqlite_sequence'];
function snapshot(path:string) {
 const c=new DatabaseSync(path,{readOnly:true});
 try {
  const all=(sql:string)=>c.prepare(sql).all().map(r=>({...r}));
  return {schema:all('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').map(r=>[r.type,r.name,r.tbl_name,r.sql]),
   version:c.prepare('PRAGMA user_version').get()!.user_version,
   data:Object.fromEntries(tables.map(name=>[name,all('SELECT * FROM '+name+' ORDER BY 1')]))};
 } finally { c.close(); }
}
const migrations:Record<string,{before:string|null,after:unknown}>=JSON.parse(reference('migrations.json'));
for(let version=0;version<=8;version++) test(`migration schema/data/sequence matches the reference v${version}`,t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinote-migrate-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'notes.db');
 const {before,after}=migrations[version];
 assert.equal(before===null,version===0);
 if(before!==null) load(path,before);
 const s=new Store(path); try {
  assert.deepEqual(snapshot(path),after);
  assert.deepEqual(s.query('PRAGMA foreign_key_check'),[]); assert.equal(s.row('PRAGMA integrity_check')!.integrity_check,'ok');
  assert.equal(s.add('after'),version?41n:1n);
 } finally{s.close();}
});

test('list fields are validated, stored as JSON arrays and reported to watchers in text form',t=>{
 const {store:s}=fixture(t); let n=s.add_note('task');
 const set=(fields:any)=>s.update_agent(n.id,fields,[],{expected_updated_at:n.updated_at});
 n=set({PRs:'https://example.test/1\nhttps://example.test/2',Notes:'text'});
 const start=s.history().at(-1)!.id;
 // Storing a text value as an equal list changes its shape but is no field event.
 n=set({PRs:[' https://example.test/1 ','https://example.test/2']});
 assert.deepEqual(n.agent_notes.PRs,['https://example.test/1','https://example.test/2']);
 assert.equal(s.row('SELECT agent_notes FROM notes WHERE id=?',n.id)!.agent_notes,'{"Notes":"text","PRs":["https://example.test/1","https://example.test/2"]}');
 assert.deepEqual(s.field_events(start).events,[]);
 assert.equal(set({PRs:['https://example.test/1','https://example.test/2']}).updated_at,n.updated_at);
 n=set({PRs:['https://example.test/2','duplicate','duplicate']});
 assert.deepEqual(s.field_events(start).events.map((e:any)=>[e.field,e.event,e.value,e.previousValue]),[['PRs','changed','https://example.test/2\nduplicate\nduplicate','https://example.test/1\nhttps://example.test/2']]);
 assert.equal(markdown(n),'task\n\n## Agent\nNotes: text\n\nPRs:\n- https://example.test/2\n- duplicate\n- duplicate');
 for(const [value,message] of [[[],/1–256/],[Array(257).fill('x'),/1–256/],[['a\nb'],/single lines/],[[' '],/cannot be empty/],[[1],/must be strings/],[['x'.repeat(4097)],/4096/],[['a\u0000'],/control/],[{a:'b'},/strings or lists/]] as [unknown,RegExp][]) assert.throws(()=>set({PRs:value}),message);
 s.transition(n.id,'done');
 assert.deepEqual(s.task_events(start).events.at(-1)!.fields,{Notes:'text',PRs:'https://example.test/2\nduplicate\nduplicate'});
});

test('agent notes saved with spaced JSON separators read back and an unchanged update is a no-op',t=>{
 const {store:s}=fixture(t); const n=s.add_note('task');
 // Earlier releases wrote ", " and ": " separators; such rows remain in existing databases.
 s.connection.prepare('UPDATE notes SET agent_notes=? WHERE id=?').run('{"10": "ten", "2": "two", "Next": "日本語\\nreview", "__proto__": "safe"}',n.id);
 const current=s.get(n.id);
 assert.deepEqual({...current.agent_notes},{'10':'ten','2':'two',Next:'日本語\nreview',...JSON.parse('{"__proto__":"safe"}')});
 assert.equal(s.update_agent(n.id,{Next:'日本語\nreview'},[],{expected_updated_at:current.updated_at}).updated_at,current.updated_at);
 assert.equal(s.history(n.id).length,1);
 const changed=s.update_agent(n.id,{Next:'done'},[],{expected_updated_at:current.updated_at});
 assert.equal(s.row('SELECT agent_notes FROM notes WHERE id=?',n.id)!.agent_notes,agentJSON(changed.agent_notes));
 assert.equal(agentJSON(changed.agent_notes),'{"10":"ten","2":"two","Next":"done","__proto__":"safe"}');
});
