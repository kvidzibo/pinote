import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root=mkdtempSync(join(tmpdir(),'pinote-backend-package-'));
const run=(command,args,options={})=>{
  const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,...options});
  assert.equal(result.status,0,result.stdout+result.stderr); return result.stdout;
};
try {
  const tarball=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',root]))[0].filename;
  run('npm',['install','--prefix',join(root,'install'),'--ignore-scripts','--offline','--no-audit','--no-fund',join(root,tarball)]);
  const bin=join(root,'bin');mkdirSync(bin);
  symlinkSync(process.execPath,join(bin,'node'));
  const env={...process.env,HOME:root,PATH:bin,XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state')};
  delete env.NODE_OPTIONS;delete env.NODE_PATH;
  delete env.TZDIR;
  assert.equal(spawnSync('python3',['--version'],{env}).error?.code,'ENOENT');
  assert.equal(spawnSync('date',['--version'],{env}).error?.code,'ENOENT');
  const note=join(root,'install/node_modules/.bin/note');
  const cli=(...args)=>JSON.parse(run(note,['--no-notify',...args],{env,cwd:root}));
  let task=cli('agent','add','--text','Packaged CLI task','--tag','Work');
  task=cli('agent','start',String(task.id),'--expected-updated-at',task.updated_at,'--pi-session-id','package-session');
  task=cli('agent','update',String(task.id),'--expected-updated-at',task.updated_at,'--set-json','{"Next":"Verify packaged workflow"}');
  assert.deepEqual(task['pi-sessions'],['package-session']);
  const bridge=join(root,'install/node_modules/.bin/pinote-electron-backend');
  const response=JSON.parse(run(bridge,[],{env,cwd:root,input:JSON.stringify({protocol:1,operation:'snapshot',params:{view:'active'}})}));
  assert.equal(response.ok,true);assert.equal(response.result.notes[0].agent_notes.Next,'Verify packaged workflow');
  cli('agent','done',String(task.id),'--expected-updated-at',task.updated_at);
  assert.equal(cli('events','--after','0').events[0].task_id,task.id);
  // Japan has no daylight saving; Node's bundled time zone data needs no system date program.
  env.TZ='Asia/Tokyo';
  const wall='2090-01-01 12:00', label='2090-01-01 12:00:00 GMT+9', utc='2090-01-01T03:00:00.000000+00:00';
  const reminder=(...args)=>run(note,['--no-notify',...args],{env,cwd:root});
  assert.equal(reminder('add','Packaged reminder'),'Added note 2.\n');
  assert.equal(reminder('schedule','2',wall),`Note 2 scheduled for ${label}.\n`);
  assert.equal(reminder('reminders'),`2. ${label} Packaged reminder\n`);
  const scheduled=JSON.parse(run(bridge,[],{env,cwd:root,input:JSON.stringify({protocol:1,operation:'snapshot',params:{view:'scheduled'}})}));
  assert.equal(scheduled.ok,true); assert.equal(scheduled.result.notes[0].remind_at,utc);
  assert.equal(cli('list','--json','--all').length,2);
  console.log('Self-contained CLI/bridge tarball passed offline, outside checkout, without Python.');
} finally { rmSync(root,{recursive:true,force:true}); }
