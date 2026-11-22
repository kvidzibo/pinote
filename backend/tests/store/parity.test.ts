import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store.ts';
import { jsonStringify } from '../../src/runtime.ts';
import { parse_reminder_time, local_reminder_time } from '../../src/reminders.ts';

test('Vancouver reminder parsing and display match the system timezone rules',t=>{
 const TZ='America/Vancouver';
 const inputs=[
  '2030-01-01 12:00:00.123456', // Winter offset and abbreviation changed in tzdb 2026b.
  '2030-11-03 01:30', // Former fold under older rules.
  '2025-03-09 02:30', '2025-11-02 01:30', '2025-11-02 02:00',
  '1870-01-01 12:00:00.123456', // Historical offset has seconds.
  '1969-12-31 15:59:59.123456', // Fractional second before the epoch.
 ];
 // Independent reading of the same system rules, as the Python reference did:
 // an instant is valid when the system zone displays it as the requested wall
 // time, and the wall time must name exactly one instant.
 const date=(args:string[])=>{
  const r=spawnSync('/usr/bin/date',args,{encoding:'utf8',env:{LC_ALL:'C',TZ}});
  assert.equal(r.status,0,r.stderr); return r.stdout.trim();
 };
 const expected=inputs.map(wall=>{
  const [seconds,fraction='']=wall.length===16?[wall+':00']:wall.split('.');
  const asUTC=Number(date(['--utc','--date='+seconds.replace(' ','T')+'Z','+%s']));
  const instants=new Set<number>();
  // Every offset this zone has used or may use: local mean time, PST, PDT/MST.
  for(const offset of [-(8*3600+12*60+28),-8*3600,-7*3600]) {
   if(date(['--date=@'+(asUTC-offset),'+%Y-%m-%d %H:%M:%S'])===seconds) instants.add(asUTC-offset);
  }
  if(instants.size!==1) return null;
  const [instant]=instants;
  const utc=date(['--utc','--date=@'+instant,'+%Y-%m-%dT%H:%M:%S'])+'.'+fraction.padEnd(6,'0')+'+00:00';
  return [utc,date(['--date=@'+instant,'+%Y-%m-%d %H:%M:%S %Z'])];
 });
 assert.ok(expected[0]);
 assert.deepEqual(expected.slice(2,4),[null,null]);
 assert.ok(expected[4]);
 const previousTZ=process.env.TZ, previousTZDIR=process.env.TZDIR;
 process.env.TZ=TZ; delete process.env.TZDIR;
 t.after(()=>{
  if(previousTZ===undefined) delete process.env.TZ; else process.env.TZ=previousTZ;
  if(previousTZDIR!==undefined) process.env.TZDIR=previousTZDIR;
 });
 for(const [i,wall] of inputs.entries()) {
  if(expected[i]===null) assert.throws(()=>parse_reminder_time(wall),/daylight saving/,wall);
  else {
   const utc=parse_reminder_time(wall);
   assert.deepEqual([utc,local_reminder_time(utc)],expected[i],wall);
  }
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
