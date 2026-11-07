import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

assert.match(process.env.XAUTHORITY || '', /xvfb-run\./, 'Use Xvfb and a private D-Bus session');
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'));
const root = await mkdtemp(join(tmpdir(),'pinote-electron-package-'));
const binary = resolve(`out/pinote-electron-linux-${process.arch}/pinote-electron`);
const backend = process.env.PINOTE_ELECTRON_BACKEND || resolve('../.venv/bin/pinote-electron-backend');
const env = { ...process.env, PINOTE_ELECTRON_BACKEND:backend, HOME:join(root,'home'), XDG_DATA_HOME:join(root,'data'), XDG_STATE_HOME:join(root,'state'), XDG_CONFIG_HOME:join(root,'config'), XDG_CACHE_HOME:join(root,'cache'), XDG_RUNTIME_DIR:join(root,'runtime'), NO_AT_BRIDGE:'1', GIO_USE_VFS:'local', GSETTINGS_BACKEND:'memory' };
for(const key of ['WAYLAND_DISPLAY','I3SOCK','SWAYSOCK','KITTY_LISTEN_ON','KITTY_WINDOW_ID','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','PYTHONPATH']) delete env[key];
for(const key of ['HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR']) await mkdir(env[key],{recursive:true,mode:0o700});
const run = (command,args,options={})=>spawnSync(command,args,{env,encoding:'utf8',timeout:10000,...options});
const call = (operation,params)=>{ const p=run(backend,[],{input:JSON.stringify({protocol:1,operation,params})}); assert.equal(p.status,0,p.stderr); const r=JSON.parse(p.stdout); assert.ok(r.ok,JSON.stringify(r)); return r.result; };
const wait = async condition => { const until=Date.now()+10000; while(!await condition()){assert.ok(Date.now()<until,'Packaged workflow timed out');await new Promise(r=>setTimeout(r,60));} };
let wm, app; let stderr='';
const socket=join(root,'i3.sock'); await writeFile(join(root,'i3.conf'),`font pango:monospace 9\nipc-socket ${socket}\n`);
try {
  wm=spawn('i3',['-a','-c',join(root,'i3.conf')],{env,stdio:'ignore'});
  await wait(()=>run('i3-msg',['-s',socket,'-t','get_tree']).status===0); env.I3SOCK=socket;
  call('add',{text:'Packaged Pinote keeps GTK available',tag:null});
  app=spawn(binary,[],{env,cwd:root,stdio:['ignore','ignore','pipe']}); app.stderr.on('data',b=>stderr+=b);
  let windowId;
  await wait(()=>{ const p=run('xdotool',['search','--all','--pid',String(app.pid),'--name','^Pinote$']); windowId=p.stdout.trim().split('\n')[0]; return p.status===0&&!!windowId; });
  await new Promise(r=>setTimeout(r,650));
  const tree=JSON.parse(run('i3-msg',['-s',socket,'-t','get_tree']).stdout);
  const find=n=>n.window_properties?.title==='Pinote'?n:[...(n.nodes||[]),...(n.floating_nodes||[])].map(find).find(Boolean);
  const node=find(tree); assert.ok(node); assert.ok(node.floating==='auto_on'||node.floating==='user_on'); assert.ok(node.rect.width<=420);
  console.log('Packaged WM_CLASS:',node.window_properties.class,'bounds:',node.rect);
  assert.equal(run('xdotool',['windowfocus',windowId]).status,0);
  assert.equal(run('xdotool',['mousemove','--window',windowId,'80',String(node.rect.height-55),'click','1']).status,0);
  assert.equal(run('xdotool',['type','--clearmodifiers','Packaged workflow task']).status,0);
  assert.equal(run('xdotool',['key','Return']).status,0);
  await wait(()=>call('snapshot',{view:'active'}).notes.some(n=>n.text==='Packaged workflow task'));
  if(run('which',['import']).status===0) { const capture=run('import',['-window',windowId,join(root,'packaged.png')]); assert.equal(capture.status,0,capture.stderr); }
  await new Promise(r=>setTimeout(r,350));
  run('xdotool',['windowfocus',windowId]);
  assert.equal(run('xdotool',['type','--clearmodifiers','Packaged unfinished draft']).status,0);
  await new Promise(r=>setTimeout(r,200));
  const stopped=new Promise(r=>app.once('close',r));
  run('xdotool',['key','Escape']); await stopped; app=undefined;
  const statePath=join(env.XDG_DATA_HOME,'pinote/electron/state.json');
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).draft,'Packaged unfinished draft');
  // Corrupt drafts must remain intact even if the read-only window is opened and closed.
  await writeFile(statePath,'unreadable draft JSON');
  app=spawn(binary,[],{env,cwd:root,stdio:['ignore','ignore','pipe']}); app.stderr.on('data',b=>stderr+=b);
  await wait(()=>{const p=run('xdotool',['search','--all','--pid',String(app.pid),'--name','^Pinote$']);windowId=p.stdout.trim().split('\n')[0];return p.status===0&&!!windowId;});
  await new Promise(r=>setTimeout(r,500));
  run('xdotool',['windowfocus',windowId]);
  const closed=new Promise(r=>app.once('close',r)); run('xdotool',['key','Escape']); await closed; app=undefined;
  assert.equal(await readFile(statePath,'utf8'),'unreadable draft JSON');
  const absent=spawnSync(binary,[],{env:{...env,PINOTE_ELECTRON_BACKEND:join(root,'missing')},cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(absent.status,1); assert.match(absent.stdout,/Install Pinote/);
  console.log(`Packaged workflow artifacts: ${root}`);
} catch(error) { console.error(stderr); console.error(`Package failure artifacts: ${root}`); throw error; }
finally { app?.kill('SIGTERM'); wm?.kill('SIGTERM'); }
