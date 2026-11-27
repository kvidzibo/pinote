import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store.ts';
import { jsonStringify } from '../../src/runtime.ts';
import { parse_reminder_time, local_reminder_time } from '../../src/reminders.ts';

test('Vancouver reminder parsing and display follow IANA rules, DST gaps, folds and historical offsets',t=>{
 const previousTZ=process.env.TZ, previousTZDIR=process.env.TZDIR;
 process.env.TZ='America/Vancouver'; delete process.env.TZDIR;
 t.after(()=>{
  if(previousTZ===undefined) delete process.env.TZ; else process.env.TZ=previousTZ;
  if(previousTZDIR!==undefined) process.env.TZDIR=previousTZDIR;
 });
 // Past dates only: future offsets depend on the tzdb version bundled with Node.
 for(const wall of ['2025-03-09 02:30','2025-11-02 01:30']) assert.throws(()=>parse_reminder_time(wall),/daylight saving/,wall);
 for(const [wall,utc,local] of [
  ['2025-01-01 12:00:00.123456','2025-01-01T20:00:00.123456+00:00','2025-01-01 12:00:00 PST'],
  ['2025-11-02 02:00','2025-11-02T10:00:00.000000+00:00','2025-11-02 02:00:00 PST'],
  ['1870-01-01 12:00:00.123456','1870-01-01T20:12:28.123456+00:00'], // Local mean time has seconds.
  ['1969-12-31 15:59:59.123456','1969-12-31T23:59:59.123456+00:00'], // Fractional second before the epoch.
 ]) {
  assert.equal(parse_reminder_time(wall),utc,wall);
  // Historical abbreviations vary with ICU data; the wall time must not.
  if(local) assert.equal(local_reminder_time(utc),local);
  else assert.ok(local_reminder_time(utc).startsWith(wall.slice(0,19)+' '),wall);
 }
});

test('complete mutation sequence matches the Python reference rows apart from clock readings',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinote-parity-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const s=new Store(join(dir,'node.db')); t.after(()=>s.close());
 let n=s.add_note('Original',{tag:'Straße',cwd:dir});
 n=s.update_agent(n.id,{Next:'  review 日本語  ',...JSON.parse('{"__proto__":"literal"}')},[],{expected_updated_at:n.updated_at});
 s.edit(n.id,'Edited',{expected_updated_at:n.updated_at});
 n=s.get(n.id);s.set_tag(n.id,'STRASSE',{expected_updated_at:n.updated_at});
 s.create_tag('Other',{folder:dir});s.set_tag_folder('Other',null);s.rename_tag('Straße','WORK');
 n=s.get(n.id);s.set_tag(n.id,'Other',{expected_updated_at:n.updated_at,folder:dir});
 s.transition(n.id,'done');s.transition(n.id,'rm');s.transition(n.id,'restore');s.select(n.id,dir);
 n=s.get(n.id);s.update_agent(n.id,{PR:'link'},['Next'],{expected_updated_at:n.updated_at});
 s.schedule(n.id,'2999-01-01T00:00:00.123456+00:00');
 s.connection.prepare("UPDATE notes SET remind_at='2000-01-01T00:00:00.123456+00:00' WHERE id=?").run(n.id);
 s.activate_due();s.delete_tag('Other');s.import_notes('/source',[['one','active','WORK'],['two','done',null]]);
 const actual=Object.fromEntries(['notes','events','tags','imports','agent_selections','sqlite_sequence'].map(name=>[name,s.query('SELECT * FROM '+name+' ORDER BY 1')]));
 const normalize=(text:string)=>JSON.parse(text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00/g,'CLOCK'));
 // Captured from the removed Python implementation; see fixtures/python-reference/README.md.
 assert.deepEqual(normalize(jsonStringify(actual)),JSON.parse(readFileSync(new URL('../fixtures/python-reference/mutation-sequence.json',import.meta.url),'utf8')));
});

test('unsupported versions remain untouched',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinote-version-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'notes.db');
 const s=new Store(path); s.add('retained'); s.connection.exec('PRAGMA user_version=99'); s.close();
 assert.throws(()=>new Store(path),/Unsupported database version 99/);
 const c=new DatabaseSync(path,{readOnly:true});
 try {
  assert.equal(c.prepare('PRAGMA user_version').get()!.user_version,99);
  assert.equal(c.prepare('SELECT text FROM notes').get()!.text,'retained');
 } finally { c.close(); }
});
