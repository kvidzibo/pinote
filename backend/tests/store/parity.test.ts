import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worktree = fileURLToPath(new URL('../../../', import.meta.url));
const pythonPath = fileURLToPath(new URL('../../../.venv/bin/python', import.meta.url));
import { Store } from '../../src/store.ts';
import { jsonStringify } from '../../src/runtime.ts';

test('complete mutation sequence matches Python durable snapshots apart from clock readings',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinote-parity-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const ref=spawnSync(pythonPath,['-c',`
from pathlib import Path
from pinote.store import Store
from datetime import datetime
import sys,json
with Store(Path(sys.argv[1])) as s:
 n=s.add_note('Original',tag='Straße',cwd=Path(sys.argv[2]))
 n=s.update_agent(n.id,{'Next':'  review 日本語  ','__proto__':'literal'},[],expected_updated_at=n.updated_at)
 s.edit(n.id,'Edited',expected_updated_at=n.updated_at)
 n=s.get(n.id);s.set_tag(n.id,'STRASSE',expected_updated_at=n.updated_at)
 s.create_tag('Other',folder=sys.argv[2]);s.set_tag_folder('Other',None)
 s.rename_tag('Straße','WORK')
 n=s.get(n.id);s.set_tag(n.id,'Other',expected_updated_at=n.updated_at,folder=sys.argv[2])
 s.transition(n.id,'done');s.transition(n.id,'rm');s.transition(n.id,'restore');s.select(n.id,Path(sys.argv[2]))
 n=s.get(n.id);s.update_agent(n.id,{'PR':'link'},['Next'],expected_updated_at=n.updated_at)
 s.schedule(n.id,datetime.fromisoformat('2999-01-01T00:00:00.123456+00:00'))
 s.connection.execute("UPDATE notes SET remind_at='2000-01-01T00:00:00.123456+00:00' WHERE id=?",(n.id,));s.connection.commit()
 s.activate_due();s.delete_tag('Other')
 s.import_notes('/source',[('one','active','WORK'),('two','done',None)])
 print(json.dumps({name:[dict(r) for r in s.connection.execute('SELECT * FROM '+name+' ORDER BY 1')] for name in ['notes','events','tags','imports','agent_selections','sqlite_sequence']},ensure_ascii=False))
`,join(dir,'python.db'),dir],{cwd:worktree,encoding:'utf8',env:{...process.env,PYTHONPATH:'src',PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(ref.status,0,ref.stderr);
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
 assert.deepEqual(normalize(jsonStringify(actual)),normalize(ref.stdout));
});

test('unsupported versions remain untouched',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinote-version-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'notes.db');
 const s=new Store(path); s.add('retained'); s.connection.exec('PRAGMA user_version=99'); s.close();
 assert.throws(()=>new Store(path),/Unsupported database version 99/);
 const ref=spawnSync(pythonPath,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA user_version').fetchone()[0]); print(c.execute('SELECT text FROM notes').fetchone()[0])",path],{encoding:'utf8'});
 assert.equal(ref.status,0,ref.stderr); assert.equal(ref.stdout,'99\nretained\n');
});
