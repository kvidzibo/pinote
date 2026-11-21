// Watchers settings in the running desktop: declared parameters, event selection and a real worktree cleanup.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

assert.match(process.env.XAUTHORITY || '', /xvfb-run\./, 'Use xvfb-run with a private dbus-run-session');
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'), 'Use a private D-Bus session');
const root = await mkdtemp(join(tmpdir(), 'pinote-watchers-e2e-'));
const env = { ...process.env, PINOTE_ELECTRON_BACKEND: resolve('../backend/bin/pinote-electron-backend'), PINOTE_NOTE_COMMAND: resolve('../backend/bin/note'),
  HOME: join(root,'home'), XDG_DATA_HOME: join(root,'data'), XDG_STATE_HOME: join(root,'state'), XDG_CONFIG_HOME: join(root,'config'), XDG_CACHE_HOME: join(root,'cache'),
  XDG_RUNTIME_DIR: join(root,'runtime'), PI_CODING_AGENT_DIR: join(root,'pi-agent'), NO_AT_BRIDGE:'1', GIO_USE_VFS:'local', GSETTINGS_BACKEND:'memory' };
for (const name of ['WAYLAND_DISPLAY','I3SOCK','SWAYSOCK','KITTY_LISTEN_ON','KITTY_WINDOW_ID','ELECTRON_RUN_AS_NODE']) delete env[name];
for (const name of ['HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','PI_CODING_AGENT_DIR']) await mkdir(env[name], {recursive:true,mode:0o700});
const settingsFile = join(env.PI_CODING_AGENT_DIR,'pi-note.json');
const saved = async () => JSON.parse(await readFile(settingsFile,'utf8'));
const note = (...args) => JSON.parse(execFileSync(env.PINOTE_NOTE_COMMAND,['--no-notify',...args],{env,encoding:'utf8'}));
const git = (...args) => execFileSync('git',args,{env,stdio:'pipe'});
const until = async (check, text) => { for (let i=0;i<150;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,100)); } assert.fail(text); };

await writeFile(settingsFile, JSON.stringify({ handoffPrompt:'Keep me', forgejoInstances:[{url:'https://forgejo.example',tokenEnv:'FORGEJO_TOKEN'}], footer:{fields:[{name:'Deploy'}]} }));
const repo = join(root,'repo'), worktrees = join(root,'worktrees'), worktree = join(worktrees,'task'), dirty = join(worktrees,'dirty');
await mkdir(worktrees); git('init','-q',repo);
git('-C',repo,'-c','user.name=t','-c','user.email=t@example.invalid','commit','-q','--allow-empty','-m','first');
git('-C',repo,'worktree','add','-q','-b','task',worktree); git('-C',repo,'worktree','add','-q','-b','dirty',dirty);
await writeFile(join(dirty,'unsaved.txt'),'keep');
const custom = join(root,'deploy-status.mjs'), calls = join(root,'calls.jsonl');
await writeFile(custom, `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},fs.readFileSync(0,'utf8')+'\\n');console.log('{}');\n`);
await chmod(custom,0o755);
await writeFile(join(root,'deploy-status.params.json'), JSON.stringify({ name:'Deploy status', fieldEvents:['changed'], params:[
  {key:'environment',label:'Environment',type:'select',options:['staging','production'],required:true},
  {key:'timeout',label:'Timeout seconds',type:'number',default:30}, {key:'recovery',label:'Notify on recovery',type:'boolean',default:true}] }));
const withField = (text, fields) => { const task = note('agent','add',`--text=${text}`); return note('agent','update',String(task.id),'--expected-updated-at',task.updated_at,'--set-json',JSON.stringify(fields)); };
const before = withField('Completed before the watcher was enabled',{Worktree:worktree});
note('agent','done',String(before.id),'--expected-updated-at',before.updated_at);

let app; const errors = [];
try {
  app = await _electron.launch({ executablePath:createRequire(import.meta.url)('electron'), args:['--class=pinote-electron',resolve('dist/main.cjs')], env, chromiumSandbox:true, timeout:20000 });
  const page = await app.firstWindow();
  page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('#draft-host').waitFor();
  // The native menu is covered by e2e.mjs; here its choice and the native dialogs are supplied directly.
  await app.evaluate(({ipcMain,dialog},script)=>{
    ipcMain.removeHandler('popup-menu'); ipcMain.handle('popup-menu',()=>'watchers');
    globalThis.__confirmations=[]; globalThis.__script=script;
    dialog.showMessageBox=async(_window,options)=>{globalThis.__confirmations.push(options.detail); return {response:1,checkboxChecked:false};};
    dialog.showOpenDialog=async(_window,options)=>({canceled:false,filePaths:[options.properties.includes('openFile')?globalThis.__script:globalThis.__folder]});
  },custom);
  await app.evaluate((_electron,folder)=>{globalThis.__folder=folder;},worktrees);
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Watchers',exact:true}), list = dialog.getByRole('group',{name:'Watchers',exact:true});
  const save = dialog.getByRole('button',{name:'Save watcher settings…',exact:true}), status = dialog.getByRole('status');
  const saveAll = async () => { await save.click(); await status.getByText('Saved.',{exact:true}).waitFor(); };
  // An automatic height fit in flight can restore the previous width: repeat until the size holds.
  const resize = async width => {
    for (let stable=0; stable<2;) {
      if (await page.evaluate(()=>innerWidth)===width) stable++;
      else { stable=0; await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,640),width); }
      await new Promise(r=>setTimeout(r,250));
    }
  };
  const capture = async name => {
    const box = await save.boundingBox(), height = await page.evaluate(()=>innerHeight);
    assert.ok(box.y>=0 && box.y+box.height<=height,'Save stays visible while the editor scrolls');
    await page.screenshot({path:join(root,`${name}.png`)});
  };
  await resize(760);
  await list.getByRole('button',{name:/^Worktree cleanup: disabled$/}).click();
  assert.deepEqual(await list.getByRole('button').evaluateAll(nodes=>nodes.map(node=>node.textContent)),['Worktree cleanup','Forgejo PR','GitHub PR']);
  assert.equal(await save.isDisabled(),true,'Nothing to save before a change');

  // Bundled task-event watcher: declared defaults, a directory parameter and the trust confirmation.
  const events = dialog.getByRole('group',{name:'Task events',exact:true});
  assert.deepEqual(await events.getByRole('checkbox').evaluateAll(nodes=>nodes.filter(node=>node.checked).map(node=>node.parentElement.textContent)),['completed']);
  assert.equal(await dialog.locator('.watcher-chip').textContent(),'Worktree');
  const directory = dialog.getByRole('textbox',{name:'Worktrees directory *',exact:true});
  assert.equal(await directory.inputValue(),'/tmp');
  await dialog.getByRole('button',{name:'Choose Worktrees directory',exact:true}).click();
  await page.waitForFunction(value=>document.querySelector('.watcher-param input')?.value===value,worktrees);
  await dialog.getByRole('checkbox',{name:'Enabled while Pinote is open',exact:true}).check();
  await status.getByText('Unsaved changes. Saving asks for confirmation.',{exact:true}).waitFor();
  await capture('watchers-cleanup-760');
  await saveAll();
  const cleanup = (await saved()).fieldWatchers.find(entry=>entry.path.endsWith('cleanup-worktree.mjs'));
  assert.deepEqual([cleanup.enabled,cleanup.taskEvents,cleanup.fieldEvents,cleanup.fields,cleanup.params],[true,['completed'],[],['Worktree'],{dir:worktrees}]);
  assert.match((await app.evaluate(()=>globalThis.__confirmations)).at(-1),/trusted code, not sandboxed[\s\S]*cleanup-worktree\.mjs/);
  assert.equal((await saved()).handoffPrompt,'Keep me','Unrelated settings are preserved');

  // Completing tasks as Pi does removes only the clean recorded worktree; the earlier completion is not replayed.
  await new Promise(r=>setTimeout(r,3000));
  assert.ok(existsSync(worktree),'A completion from before the watcher was enabled must not remove its worktree');
  for (const path of [dirty,worktree]) { const task = withField('Clean up',{Worktree:path}); note('agent','done',String(task.id),'--expected-updated-at',task.updated_at); }
  await until(()=>!existsSync(worktree),'Completing the task must remove its clean worktree');
  assert.ok(existsSync(join(dirty,'unsaved.txt')),'A changed worktree is kept');
  assert.match(git('-C',repo,'branch','--list','task').toString(),/task/,'The branch is kept');

  // Custom script: a required parameter blocks enabling; fields are suggested from the configured footer fields.
  await dialog.getByRole('button',{name:'Add watcher script…',exact:true}).click();
  await dialog.getByRole('heading',{name:'Deploy status',exact:true}).waitFor();
  const enabled = dialog.getByRole('checkbox',{name:'Enabled while Pinote is open',exact:true});
  assert.equal(await dialog.locator('.watcher-problem').textContent(),'Needs parameter: Environment');
  assert.equal(await enabled.isDisabled(),true);
  await dialog.getByRole('combobox',{name:'Environment *',exact:true}).selectOption('production');
  assert.equal(await dialog.locator('.watcher-problem').isHidden(),true);
  await enabled.check();
  await dialog.getByRole('spinbutton',{name:'Timeout seconds',exact:true}).fill('45');
  await dialog.getByRole('group',{name:'Task events',exact:true}).getByRole('checkbox',{name:'completed',exact:true}).check();
  const addField = dialog.getByRole('combobox',{name:'Add field',exact:true});
  assert.ok((await dialog.locator('#watcher-field-names option').evaluateAll(nodes=>nodes.map(node=>node.value))).includes('Deploy'),'Configured fields are suggested');
  await addField.fill('Deploy'); await addField.press('Enter');
  assert.equal(await dialog.locator('.watcher-chip').textContent(),'Deploy');
  await capture('watchers-custom-760');
  await saveAll();
  assert.deepEqual((await saved()).fieldWatchers.find(entry=>entry.path===custom),
    {path:custom,enabled:true,taskEvents:['completed'],fieldEvents:['changed'],fields:['Deploy'],params:{environment:'production',timeout:45,recovery:true}});
  const task = withField('Deploy',{Deploy:'1',Other:'x'});
  const changed = note('agent','update',String(task.id),'--expected-updated-at',task.updated_at,'--set-json',JSON.stringify({Deploy:'2',Other:'y'}));
  const received = async () => existsSync(calls) ? (await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line)) : [];
  // Field checks describe the current value: completing first would withdraw the pending one.
  await until(async()=>(await received()).length>=1,'The custom script must receive the field change');
  note('agent','done',String(changed.id),'--expected-updated-at',changed.updated_at);
  await until(async()=>(await received()).length>=2,'The custom script must receive the completion');
  const params = {environment:'production',timeout:45,recovery:true};
  assert.deepEqual((await received()).map(({eventId,previousValue,...rest})=>rest),[
    {version:1,taskId:task.id,field:'Deploy',event:'changed',value:'2',params},
    {version:1,scope:'task',event:'completed',taskId:task.id,fields:{Deploy:'2',Other:'y'},params}]);

  // Forgejo instances stay in the shared forgejoInstances key the script reads.
  await list.getByRole('button',{name:/^Forgejo PR:/}).click();
  assert.equal(await dialog.getByRole('textbox',{name:'Base URL 1',exact:true}).inputValue(),'https://forgejo.example');
  await dialog.getByRole('button',{name:'Add Instances row',exact:true}).click();
  await dialog.getByRole('textbox',{name:'Base URL 2',exact:true}).fill('http://127.0.0.1:3000');
  await dialog.getByRole('button',{name:'Add Instances row',exact:true}).click();
  await capture('watchers-forgejo-760');
  await saveAll();
  assert.deepEqual((await saved()).forgejoInstances,[{url:'https://forgejo.example',tokenEnv:'FORGEJO_TOKEN'},{url:'http://127.0.0.1:3000'}],'A blank row is not saved');

  // Removing a custom watcher keeps its file; narrow windows stay usable.
  await list.getByRole('button',{name:/^Deploy status:/}).click();
  for (const width of [420,280]) {
    await resize(width);
    assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true,`No horizontal overflow at ${width}px`);
    await capture(`watchers-custom-${width}`);
  }
  await dialog.getByRole('button',{name:'Remove watcher',exact:true}).click();
  await saveAll();
  assert.equal((await saved()).fieldWatchers.some(entry=>entry.path===custom),false);
  assert.ok(existsSync(custom));
  assert.deepEqual(errors,[]);
  console.log(process.env.PINOTE_E2E_KEEP ? `Watchers e2e passed; screenshots in ${root}` : 'Watchers e2e passed');
} catch (error) {
  console.error(`Watchers e2e failed; artifacts in ${root}`);
  throw error;
} finally {
  await app?.close().catch(()=>{});
  if (!process.env.PINOTE_E2E_KEEP) await rm(root,{recursive:true,force:true});
}
