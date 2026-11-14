import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

const sourceValue = locator => locator.evaluate(node => node.querySelector('.cm-placeholder') ? '' : Array.from(node.querySelectorAll('.cm-line'), line => line.textContent).join('\n'));

assert.match(process.env.XAUTHORITY || '', /xvfb-run\./, 'Use xvfb-run with a private dbus-run-session');
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'), 'Use a private D-Bus session');
const root = await mkdtemp(join(tmpdir(), 'pinote-electron-e2e-'));
const backend = process.env.PINOTE_ELECTRON_BACKEND || resolve('../.venv/bin/pinote-electron-backend');
const env = { ...process.env, PINOTE_ELECTRON_BACKEND: backend, HOME: join(root,'home'), XDG_DATA_HOME: join(root,'data'), XDG_STATE_HOME: join(root,'state'), XDG_CONFIG_HOME: join(root,'config'), XDG_CACHE_HOME: join(root,'cache'), XDG_RUNTIME_DIR: join(root,'runtime'), NO_AT_BRIDGE:'1', GIO_USE_VFS:'local', GSETTINGS_BACKEND:'memory' };
for (const name of ['WAYLAND_DISPLAY','I3SOCK','SWAYSOCK','KITTY_LISTEN_ON','KITTY_WINDOW_ID','ELECTRON_RUN_AS_NODE']) delete env[name];
for (const name of ['HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR']) await mkdir(env[name], {recursive:true,mode:0o700});
const faultFile=join(root,'backend-fault');
const slowAddMarker=join(root,'slow-add-dispatched');
const completeMarker=join(root,'completion-committed');
const editMarker=join(root,'edit-committed');
const createTagMarker=join(root,'create-tag-committed');
const frontendBackend=join(root,'backend.mjs');
await writeFile(frontendBackend,`#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const op=JSON.parse(input).operation;let fault='';try{fault=readFileSync(${JSON.stringify(faultFile)},'utf8');}catch{}if(fault==='slow-add'&&op==='add'){writeFileSync(${JSON.stringify(slowAddMarker)},'dispatched');setTimeout(()=>process.stdout.write(JSON.stringify({protocol:1,ok:false,error:{code:'unknown',message:'Injected delayed add failure'}})),1000);return;}if(fault==='slow-busy-edit'&&op==='edit'){writeFileSync(${JSON.stringify(editMarker)},JSON.parse(input).params.text);setTimeout(()=>process.stdout.write(JSON.stringify({protocol:1,ok:false,error:{code:'busy',message:'Injected delayed edit failure'}})),1500);return;}if((fault==='busy-tag'&&op==='tag')||(fault==='busy-create-tag'&&op==='create_tag')){process.stdout.write(JSON.stringify({protocol:1,ok:false,error:{code:'busy',message:'Injected edit failure'}}));return;}if(op===fault){process.stdout.write(JSON.stringify({protocol:1,ok:false,error:{code:op==='snapshot'?'busy':'unknown',message:'Injected rapid failure'}}));return;}const r=spawnSync(${JSON.stringify(backend)},[],{input,encoding:'utf8',env:process.env});const reply=()=>{process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;};if(fault==='slow-create-tag'&&op==='create_tag'){writeFileSync(${JSON.stringify(createTagMarker)},'committed');setTimeout(reply,1200);return;}if(fault==='slow-edit'&&op==='edit'){writeFileSync(${JSON.stringify(editMarker)},JSON.parse(input).params.text);setTimeout(reply,1200);return;}if(fault==='slow-complete'&&op==='transition'&&JSON.parse(input).params.action==='done'){writeFileSync(${JSON.stringify(completeMarker)},'committed');setTimeout(reply,1000);return;}reply();});`,{mode:0o700});
env.PINOTE_ELECTRON_BACKEND=frontendBackend;
function call(operation, params) {
  const run = spawnSync(backend, [], { env, input: JSON.stringify({ protocol:1,operation,params }), encoding:'utf8' });
  assert.equal(run.status,0,run.stderr);
  const response = JSON.parse(run.stdout); assert.ok(response.ok,JSON.stringify(response)); return response.result;
}
call('create_tag',{name:'Work',folder:null});
call('create_tag',{name:'Empty filter',folder:null});
const first = call('add',{ text:'Ship optional Electron frontend\n\nKeep **GTK** available. [Safe preview link](https://example.org/task393)\n\n<script>window.compromised=true</script>\n\n![no network](https://example.org/track.svg)',tag:null }).id;
const progress = call('add',{text:'Check GTK, CLI and Pi coexistence',tag:'Work'}).id;
let t = call('snapshot',{view:'active'}).notes.find(n => n.id === progress);
call('transition',{id:t.id,revision:t.updated_at,state:t.state,action:'start'});
call('add',{text:'Review drafts, reminders and archive',tag:null});
for(let index=0;index<100;index++) call('add',{text:`Benchmark task ${index}`,tag:'Work'});
let wm, app, gtk;
let service, client;
const logs=[]; const pageErrors=[];
// Observe the real main-process menu without replacing native popup behavior.
const installNativeMenuProbe = async () => app.evaluate(({Menu, ipcMain}) => {
  const original = Menu.prototype.popup;
  globalThis.__e2eMenu = {serial:0, pending:false};
  Menu.prototype.popup = function(options) {
    const probe = globalThis.__e2eMenu;
    probe.menu = this; probe.options = {x:options.x,y:options.y};
    probe.serial++; probe.pending = true; probe.selected = null;
    for(const item of this.items) {
      const click=item.click;
      item.click=(...args)=>{probe.selected=item.id;return click?.apply(item,args);};
    }
    return original.call(this, {...options, callback:() => {
      probe.pending = false; options.callback?.();
    }});
  };
  const handler = ipcMain._invokeHandlers.get('popup-menu');
  if (typeof handler !== 'function') throw new Error('Missing popup-menu handler');
  ipcMain.removeHandler('popup-menu');
  ipcMain.handle('popup-menu', (event, request) => {
    globalThis.__e2eMenu.request = request;
    return handler(event, request);
  });
});
const menuState = () => app.evaluate(() => {
  const p = globalThis.__e2eMenu;
  return {serial:p.serial,pending:p.pending,request:p.request,options:p.options,
    selected:p.selected, items:p.menu?.items.map(i=>({id:i.id,enabled:i.enabled,type:i.type}))};
});
const waitMenu = async (predicate, message) => {
  for(let i=0;i<200;i++) { const state=await menuState(); if(predicate(state)) return state; await new Promise(r=>setTimeout(r,10)); }
  assert.fail(message);
};
const openNativeMenu = async opener => {
  const serial=(await menuState()).serial;
  await opener();
  return waitMenu(s=>s.serial>serial && s.pending,'Native Menu.popup must open');
};
const nativeKey = (...keys) => {
  const result=spawnSync('xdotool',['key','--clearmodifiers',...keys],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
};
const dismissNativeMenu = async () => {
  nativeKey('Escape');
  await waitMenu(s=>!s.pending,'Escape must dismiss the native menu');
};
// Existing workflow tests select the captured native item, not a DOM imitation.
const selectNativeMenu = async (opener, id) => {
  await openNativeMenu(opener);
  await app.evaluate(({BrowserWindow}, id) => {
    const menu=globalThis.__e2eMenu.menu, item=menu.getMenuItemById(id);
    if(!item || !item.enabled) throw new Error(`Unavailable native menu item: ${id}`);
    item.click(item,BrowserWindow.getAllWindows()[0],{});
    menu.closePopup();
  }, id);
  await waitMenu(s=>!s.pending,'Selected native menu must close');
};

const selectTaskAction = async (page, id, label) => {
  await page.getByRole('button',{name:`Actions for task ${id}`,exact:true}).click();
  await page.getByRole('toolbar',{name:new RegExp(`^Actions for task ${id}:`)}).getByRole('button',{name:label,exact:true}).click();
};

try {
  const socket = join(root,'i3.sock');
  const config = join(root,'i3.conf');
  await writeFile(config,`font pango:monospace 9\nipc-socket ${socket}\nfor_window [class="^pinote-electron$"] floating enable, border none\nfor_window [window_role="^pinote-"] floating enable, border none\n`);
  wm = spawn('i3',['-a','-c',config],{env,stdio:'ignore'});
  for(let i=0;i<100;i++) { if(spawnSync('i3-msg',['-s',socket,'-t','get_tree'],{env,stdio:'ignore'}).status===0) break; await new Promise(r=>setTimeout(r,30)); }
  env.I3SOCK = socket;
  const gtkPath=resolve('../.venv-gui/bin/pinote-gui');
  gtk=spawn(gtkPath,[],{env:{...env,GDK_BACKEND:'x11'},stdio:['ignore','pipe','pipe']});
  gtk.stdout.on('data',b=>logs.push(`GTK: ${b}`));
  gtk.stderr.on('data',b=>logs.push(`GTK: ${b}`));
  gtk.on('exit',(code,signal)=>logs.push(`GTK exited: code=${code}, signal=${signal}`));
  // A late GTK window steals the real X11 Escape used by native-menu checks.
  // Wait for it to map before Electron opens and takes focus.
  let gtkReady=false;
  for(let i=0;i<200;i++) {
    assert.equal(gtk.exitCode,null,`GTK exited before showing its window: ${logs.join('\n')}`);
    const windows=spawnSync('xdotool',['search','--all','--onlyvisible','--pid',String(gtk.pid),'--name','^pinote — Reminders$'],{env,encoding:'utf8'});
    assert.ifError(windows.error);
    if(windows.status===0 && windows.stdout.trim()) { gtkReady=true; break; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(gtkReady,`GTK must show its window before Electron starts: ${logs.join('\n')}`);
  const started = performance.now();
  app = await _electron.launch({ executablePath:createRequire(import.meta.url)('electron'), args:['--class=pinote-electron',resolve('dist/main.cjs')], env, chromiumSandbox:true, timeout:20000 });
  app.process().stderr.on('data',b=>logs.push(b.toString()));
  const page = await app.firstWindow();
  page.on('pageerror',e=>pageErrors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error') logs.push(m.text());});
  const outgoing=[]; page.on('request',req=>{if(/^https?:/.test(req.url()))outgoing.push(req.url());});
  app.on('window', child => {
    if (child === page) return;
    child.on('pageerror', e => pageErrors.push(String(e)));
    child.on('request', req => { if (/^https?:/.test(req.url())) outgoing.push(req.url()); });
  });
  const openPreview = async opener => {
    const created = app.waitForEvent('window');
    await opener();
    const child = await created;
    await child.waitForURL('pinote-app://ui/preview.html');
    await child.getByRole('dialog').waitFor();
    await child.waitForFunction(() => document.activeElement === document.querySelector('.panel'));
    return child;
  };
  const dismissPreview = async child => {
    const closed = child.waitForEvent('close');
    // Escape destroys this renderer on keydown, so keyup may race its closure.
    await child.keyboard.press('Escape').catch(error => { if (!child.isClosed()) throw error; });
    await closed;
    assert.equal(page.isClosed(), false, 'Escape closes only the preview');
  };
  await page.locator('.task-row').first().waitFor();
  await installNativeMenuProbe();
  const taskReadyMs=performance.now()-started;
  await page.waitForTimeout(350);
  console.log(`Cold start to tasks: ${Math.round(taskReadyMs)} ms`);
  const tree = spawnSync('i3-msg',['-s',socket,'-t','get_tree'],{env,encoding:'utf8'}).stdout;
  await writeFile(join(root,'i3-tree.json'),tree);
  const geometry = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
  console.log('Window bounds', geometry);
  assert.ok(geometry.width <= 420 && geometry.height <= 400, 'Checklist must float compactly, not tile');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox));
  assert.equal(await page.locator('#pinned .task-row').count(),1);
  assert.equal(await page.locator('#ordinary .task-row').count(),2);
  const resources = await app.evaluate(({app})=>app.getAppMetrics().reduce((r,p)=>({rssKiB:r.rssKiB+p.memory.workingSetSize,cpuPercent:r.cpuPercent+p.cpu.percentCPUUsage}),{rssKiB:0,cpuPercent:0}));
  const gtkRSS=Number(spawnSync('ps',['-o','rss=','-p',String(gtk.pid)],{encoding:'utf8'}).stdout.trim());
  const scan=performance.now(); for(let i=0;i<5;i++)call('snapshot',{view:'active'});
  const snapshotMean=Math.round((performance.now()-scan)/5);
  const ticks=async(pid,children=false)=>{try{const s=(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ').slice(1).join(') ').split(' ');return Number(s[11])+Number(s[12])+(children?Number(s[13])+Number(s[14]):0);}catch{return 0;}};
  const pids=await app.evaluate(({app})=>app.getAppMetrics().map(p=>p.pid));
  const sample=async()=>({electron:(await Promise.all(pids.map(p=>ticks(p,p===app.process().pid)))).reduce((a,b)=>a+b,0),gtk:await ticks(gtk.pid)});
  const before=await sample(), at=performance.now(); await page.waitForTimeout(2100); const after=await sample();
  const hz=Number(spawnSync('getconf',['CLK_TCK'],{encoding:'utf8'}).stdout.trim()), seconds=(performance.now()-at)/1000;
  const measurement={datasetTasks:103,coldStartToTasksMs:Math.round(taskReadyMs),electronReportedRSSKiB:resources.rssKiB,gtkRSSKiB:gtkRSS,backendSnapshotMeanMs:snapshotMean,electronIdleCPUPercent:+((after.electron-before.electron)/hz/seconds*100).toFixed(2),gtkIdleCPUPercent:+((after.gtk-before.gtk)/hz/seconds*100).toFixed(2)};
  console.log('Resource sample',measurement); await writeFile(join(root,'resources.json'),JSON.stringify(measurement,null,2));
  assert.ok(await page.locator('img[src]').evaluateAll(images=>images.every(i=>i.complete&&i.naturalWidth>0)),'Bundled icons must load');
  await page.screenshot({path:join(root,'checklist.png')});
  assert.equal(await page.getByRole('button',{name:'Add task (Enter)',exact:true}).count(),0);
  await page.getByRole('button',{name:'New-task tag: Untagged',exact:true}).click();
  assert.deepEqual(await page.locator('.tag-choice span').allTextContents(),['Work (101) ▶ 1','Empty filter (0)','Untagged (2)']);
  await page.keyboard.press('Escape');
  // task393: allocation and keyboard focus with the complete benchmark dataset.
  {
    const filter = page.locator('#toolbar button').filter({has:page.locator('img[src*="view-filter-symbolic"]')});
    const draft = page.locator('#draft');
    const resize = async (width, height) => {
      await app.evaluate(({BrowserWindow, screen}, {width,height}) => {
        const win = BrowserWindow.getAllWindows()[0];
        const area = screen.getDisplayMatching(win.getBounds()).workArea;
        win.setBounds({x:area.x,y:area.y,width,height:Math.min(height,area.height)});
      }, {width,height});
      await page.waitForFunction(width => window.innerWidth === width, width);
    };
    await resize(580,620);
    await filter.click();
    await page.getByRole('button',{name:'Select all tags',exact:true}).click();
    const filters = page.getByRole('group',{name:'Tag filters',exact:true});
    const work = filters.getByRole('checkbox').filter({hasText:'Work'});
    assert.equal(await work.getAttribute('aria-checked'),'true');
    await work.focus();
    await page.keyboard.press('Space');
    assert.equal(await work.getAttribute('aria-checked'),'false');
    assert.ok(await work.evaluate(node=>node===document.activeElement),'Space redraw must retain the filter checkbox focus');
    await page.keyboard.press('Space');
    assert.equal(await work.getAttribute('aria-checked'),'true');
    assert.ok(await work.evaluate(node=>node===document.activeElement));
    const emptyFilter = filters.getByRole('checkbox').filter({hasText:'Empty filter'});
    await emptyFilter.focus();
    await page.keyboard.press('Space');
    assert.equal(await emptyFilter.count(),1,'A focused empty tag must not disappear on deselection');
    assert.equal(await emptyFilter.getAttribute('aria-checked'),'false');
    assert.ok(await emptyFilter.evaluate(node=>node===document.activeElement),'An empty saved tag must remain focused after deselection');
    await page.keyboard.press('Space');
    assert.equal(await emptyFilter.getAttribute('aria-checked'),'true');
    await page.keyboard.press('Escape');
    assert.ok(await filter.evaluate(node=>node===document.activeElement),'Escape must return focus to the toolbar opener');
    assert.equal(await page.locator('.task-row').count(),103);
    assert.equal(await page.locator('#ordinary .task-row').count(),102);
    assert.equal(await page.locator('#pinned .task-row').count(),1);
    assert.match(await page.locator(`#pinned [data-id="${progress}"] [role="checkbox"] img`).getAttribute('src'),/task-complete-symbolic\.svg$/);

    // Each idle refresh writes the toolbar count, even when its value is unchanged.
    // Observe actual redraws instead of assuming two refreshes from a sleep duration.
    await filter.evaluate(node=>{
      window.__task393Refreshes=0;
      window.__task393FocusKept=true;
      window.__task393Observer=new MutationObserver(()=>{
        window.__task393Refreshes++;
        window.__task393FocusKept &&= document.activeElement===node;
      });
      window.__task393Observer.observe(node.querySelector('span'),{childList:true});
    });
    await page.waitForFunction(()=>window.__task393Refreshes>=2);
    assert.ok(await page.evaluate(()=>window.__task393FocusKept),'Toolbar focus must survive at least two observed refreshes');
    await page.evaluate(()=>{window.__task393Observer.disconnect();delete window.__task393Observer;delete window.__task393Refreshes;delete window.__task393FocusKept;});

    const layout = () => page.evaluate(()=>{
      const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right};};
      const ordinary=document.getElementById('ordinary');
      return {ordinary:box('ordinary'),pinned:box('pinned'),composer:box('composer'),checklist:box('checklist'),toolbar:box('toolbar'),draft:box('draft'),scrollHeight:ordinary.scrollHeight,scrollTop:ordinary.scrollTop,width:innerWidth,height:innerHeight};
    });
    const assertAllocation = box => {
      assert.ok(box.ordinary.height>170,'Ordinary list must use available height, not the old 170px cap');
      assert.ok(Math.abs(box.ordinary.top-box.checklist.top)<=1);
      assert.ok(Math.abs(box.pinned.top-box.ordinary.bottom-4)<=1,'Pinned list must follow ordinary list without wasted space');
      assert.ok(Math.abs(box.composer.top-box.pinned.bottom-5)<=1,'Pinned row must sit immediately above composer');
      assert.ok(Math.abs(box.composer.bottom-(box.height-6))<=1,'Composer must stay at the bottom');
      assert.ok(box.scrollHeight>box.ordinary.height,'All seeded ordinary tasks must overflow');
    };
    const tall = await layout();
    assertAllocation(tall);
    assert.equal(Math.round(tall.pinned.height),34,'One progress row must retain its content height with 100 ordinary tasks');
    let resizedTask=call('snapshot',{view:'active'}).notes.find(n=>n.id===first);
    call('transition',{id:first,revision:resizedTask.updated_at,state:resizedTask.state,action:'start'});
    await page.waitForFunction(()=>document.querySelectorAll('#pinned .task-row').length===2);
    assert.equal(Math.round((await layout()).pinned.height),67,'Progress must grow when another task starts');
    resizedTask=call('snapshot',{view:'active'}).notes.find(n=>n.id===first);
    call('transition',{id:first,revision:resizedTask.updated_at,state:resizedTask.state,action:'reset'});
    await page.waitForFunction(()=>document.querySelectorAll('#pinned .task-row').length===1);
    assert.deepEqual((await layout()).pinned,tall.pinned,'Progress must shrink again after reset');
    await page.locator('#ordinary').hover();
    await page.mouse.wheel(0,700);
    await page.waitForFunction(()=>document.getElementById('ordinary').scrollTop>0);
    const scrolled = await layout();
    assert.deepEqual(scrolled.pinned,tall.pinned,'Ordinary scrolling must not move the pinned row');
    assert.deepEqual(scrolled.composer,tall.composer,'Ordinary scrolling must not move the composer');
    await page.screenshot({path:join(root,'task393-expanded.png')});

    await draft.fill('One\nTwo\nThree\nFour\nFive\nSix');
    const grown = await layout();
    await draft.fill('Short');
    const shortened = await layout();
    assert.ok(shortened.draft.height<grown.draft.height,'Shortening the draft must shrink its accessible textbox');
    assert.ok(shortened.composer.height<grown.composer.height,'Shortening the draft must shrink the composer');
    assert.ok(shortened.ordinary.height>grown.ordinary.height,'The list must reclaim the released composer space');
    await draft.fill('');
    await resize(280,620);
    const narrow = await layout();
    assertAllocation(narrow);
    assert.ok(narrow.toolbar.left>=0 && narrow.toolbar.right<=narrow.width,'Compact toolbar must fit horizontally');
    assert.ok(await page.locator('#toolbar button').evaluateAll(nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})),'Every compact toolbar control must fit');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),280);
    await page.screenshot({path:join(root,'task393-compact.png')});

    // Tab to a real Markdown link without activating it (and thus without network I/O).
    await resize(580,620);
    const preview = await openPreview(() => page.locator(`[data-id="${first}"]`).getByRole('button',{name:'Preview full task',exact:true}).click());
    const link = preview.getByRole('dialog').getByRole('link',{name:'Safe preview link',exact:true});
    await link.waitFor();
    let reachedLink=false;
    for(let tab=0;tab<12;tab++) {
      await preview.keyboard.press('Tab');
      if(await link.evaluate(node=>node===document.activeElement)) { reachedLink=true; break; }
    }
    assert.ok(reachedLink,'Dialog Tab order must reach the preview Markdown link');
    assert.equal(outgoing.length,0,'Tab must not request remote resources');
    await dismissPreview(preview);

    // Restore the original Untagged view and compact geometry for the existing workflow.
    await filter.click();
    await page.getByRole('button',{name:'Clear selection (in-progress only)',exact:true}).click();
    await filters.getByRole('checkbox').filter({hasText:'Untagged'}).click();
    await page.keyboard.press('Escape');
    await resize(geometry.width,geometry.height);
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),geometry);
    await page.locator('#ordinary').evaluate(node=>{node.scrollTop=0;});
    await page.locator('#pinned').evaluate(node=>{node.scrollTop=0;});
    assert.equal(await sourceValue(draft),'');
    assert.equal(await page.locator('#ordinary .task-row').count(),2);
    assert.equal(await page.locator('#pinned .task-row').count(),1);
    assert.match(await filter.getAttribute('aria-label'),/^Filter by tag: Untagged /);
  }
  // Inline row actions: real pointer/keyboard input, stable layout and polling.
  {
    const row=page.locator(`[data-id="${first}"]`), title=row.locator('.task-title');
    const actions=page.getByRole('button',{name:`Actions for task ${first}`,exact:true});
    const bar=page.getByRole('toolbar',{name:new RegExp(`^Actions for task ${first}:`)});
    const bottom=page.getByRole('button',{name:'Menu',exact:true});
    const focusReturns=async locator => {
      assert.ok(await locator.evaluate(node=>node===document.activeElement),'Dismissal must return focus to the opener');
      assert.equal(page.isClosed(),false);
      assert.equal(app.process().exitCode,null,'Dismissing actions must not close Pinote');
    };
    const rowBox=await row.boundingBox();
    const serial=(await menuState()).serial;
    await title.click({button:'right'});
    assert.equal((await menuState()).serial,serial,'Task actions must not open a native menu');
    assert.deepEqual(await bar.getByRole('button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Start in Kitty…','Copy note','Start','Complete','Remove to archive','Edit text…','Set reminder…','Change tag…','Preview','Close task actions']);
    assert.ok(await bar.getByRole('button').evaluateAll(nodes=>nodes.every(n=>n.title===n.getAttribute('aria-label') && n.querySelector('img'))),'Every action needs an icon, tooltip and accessible name');
    assert.equal(await title.isVisible(),false);
    assert.deepEqual(await row.boundingBox(),rowBox,'Opening actions must not move or resize the row');
    await page.screenshot({path:join(root,'inline-actions.png')});
    // Unchanged polling must retain the toolbar and its focused button.
    await bar.getByRole('button',{name:'Copy note',exact:true}).focus();
    await page.waitForTimeout(2200);
    await focusReturns(bar.getByRole('button',{name:'Copy note',exact:true}));
    await page.keyboard.press('Escape'); await focusReturns(title);
    assert.deepEqual(await row.boundingBox(),rowBox);
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('End'); await focusReturns(bar.getByRole('button',{name:'Close task actions',exact:true}));
    await page.keyboard.press('ArrowRight'); await focusReturns(bar.getByRole('button',{name:'Start in Kitty…',exact:true}));
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
    const expectedCopy=call('snapshot',{view:'active'}).notes.find(n=>n.id===first).text;
    let copied=false;
    for(let i=0;i<100;i++) {
      copied=(await app.evaluate(({clipboard})=>clipboard.readText()))===expectedCopy;
      if(copied) break;
      await page.waitForTimeout(10);
    }
    assert.ok(copied,'Keyboard activation must copy the full note');
    await focusReturns(title);
    await page.keyboard.press('ContextMenu');
    await bar.getByRole('button',{name:'Close task actions',exact:true}).click(); await focusReturns(title);
    await actions.click();
    await page.keyboard.press('Tab');
    assert.equal(await bar.count(),0,'Tab out must restore the row');
    await actions.click();
    await page.locator('#draft').click();
    assert.equal(await bar.count(),0,'Outside click must restore the row');
    assert.ok(await page.locator('#draft').evaluate(n=>n===document.activeElement));
    await actions.click();
    // Playwright emulates perpetual page focus; disable it for actual X11 blur.
    const focusSession=await page.context().newCDPSession(page);
    await focusSession.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    const gtkWindow=spawnSync('xdotool',['search','--all','--onlyvisible','--pid',String(gtk.pid),'--name','^pinote — Reminders$'],{env,encoding:'utf8'});
    assert.equal(gtkWindow.status,0,gtkWindow.stderr);
    const activate=spawnSync('xdotool',['windowactivate','--sync',gtkWindow.stdout.trim().split('\n')[0]],{env,encoding:'utf8'});
    assert.equal(activate.status,0,activate.stderr);
    await bar.waitFor({state:'detached'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
    await page.waitForFunction(()=>document.hasFocus());
    await focusSession.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await focusSession.detach();
    await actions.click();
    await page.locator(`[data-id="${progress}"] .task-title`).click({button:'right'});
    assert.equal(await page.getByRole('toolbar').count(),1,'Only one row may show actions');
    assert.equal(await title.isVisible(),true);
    await page.getByRole('button',{name:'Reset progress',exact:true}).click();
    await page.waitForFunction(id=>!document.querySelector(`[data-id="${id}"]`)?.classList.contains('progress'),progress);
    // The reset Work task is filtered out; restore its state through the shared backend.
    const reset=call('snapshot',{view:'active'}).notes.find(n=>n.id===progress);
    assert.equal(reset.state,'active');
    call('transition',{id:progress,revision:reset.updated_at,state:reset.state,action:'start'});
    await page.waitForFunction(id=>document.querySelector(`#pinned [data-id="${id}"]`),progress);
    await actions.click();
    const current=call('snapshot',{view:'active'}).notes.find(n=>n.id===first);
    call('edit',{id:first,revision:current.updated_at,text:current.text+'\nExternal update'});
    await bar.waitFor({state:'detached'});
    await focusReturns(title);
    // Resizing an open toolbar must keep all ten controls inside the unchanged row.
    await actions.click();
    for(const width of [280,580,420]) {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,360),width);
      await page.waitForFunction(w=>innerWidth===w,width);
      const box=await row.boundingBox();
      assert.equal(box.height,rowBox.height);
      const clipped = await bar.getByRole('button').evaluateAll(nodes=>nodes.flatMap(n=>{
        const r=n.getBoundingClientRect(),p=n.closest('.task-row').getBoundingClientRect();
        return r.left>=p.left && r.right<=p.right && r.top>=p.top && r.bottom<=p.bottom ? []
          : [{label:n.getAttribute('aria-label'),button:r.toJSON(),row:p.toJSON()}];
      }));
      assert.deepEqual(clipped,[],`Every inline action must fit without clipping at ${width}px`);
      if(width===280) await page.screenshot({path:join(root,'inline-actions-narrow.png')});
    }
    await page.keyboard.press('Escape'); await focusReturns(actions);
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),geometry);
    // The bottom menu still uses the native popup at its opener.
    const point=await bottom.evaluate(n=>{const r=n.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.bottom)};});
    const state=await openNativeMenu(()=>bottom.click());
    assert.equal(state.request.kind,'app');
    assert.deepEqual({x:state.request.x,y:state.request.y},point);
    const bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentBounds());
    assert.deepEqual(state.options,{x:Math.min(point.x,bounds.width-1),y:Math.min(point.y,bounds.height-1)});
    assert.deepEqual(state.items.filter(i=>i.type!=='separator').map(i=>i.id),['filter','scheduled','archive','manage-tags','task-actions','drafts','close']);
    const capture=spawnSync('import',['-window','root',join(root,'native-menu-root.png')],{env,encoding:'utf8'});
    assert.ifError(capture.error); assert.equal(capture.status,0,capture.stderr);
    assert.ok((await readFile(join(root,'native-menu-root.png'))).length>1000);
    await dismissNativeMenu(); await focusReturns(bottom);
  }
  // Row and menu settings are one draft, independent for each task state.
  {
    const settings = page.getByRole('dialog',{name:'Task actions',exact:true});
    const picker = page.getByRole('dialog',{name:'Available actions',exact:true});
    const openSettings = async () => {
      await selectNativeMenu(() => page.getByRole('button',{name:'Menu',exact:true}).click(),'task-actions');
      await settings.waitFor();
    };
    const available = async () => { await settings.getByRole('button',{name:'Add actions / configure menu',exact:true}).click(); await picker.waitFor(); };
    const closePicker = async () => { await page.keyboard.press('Escape'); await picker.waitFor({state:'detached'}); assert.ok(await settings.isVisible()); };
    const rowOrder = () => settings.locator('.row-settings-list [data-element]').evaluateAll(nodes=>nodes.map(n=>n.dataset.element));
    const menuOrder = () => picker.locator('.action-settings-list [data-element]').evaluateAll(nodes=>nodes.map(n=>n.dataset.element));
    const tab = name => settings.getByRole('tab',{name,exact:true});
    const save = async () => { await settings.getByRole('button',{name:'Save task actions',exact:true}).click(); await settings.waitFor({state:'detached'}); };
    const add = label => picker.getByRole('button',{name:`Add ${label} to row`,exact:true}).click();
    const remove = label => settings.getByRole('button',{name:`Remove ${label} from row`,exact:true}).click();
    const original = ['kitty','copy','start','done','archive','edit','schedule','tag'];
    const defaultRow = primary => [primary,'task-tag','task-text','preview','actions'];
    const defaults = {
      active:{order:[...original,'preview'],hidden:[],row:defaultRow('start')},
      in_progress:{order:[...original,'preview'],hidden:[],row:defaultRow('done')},
      marked:{order:[...original,'unmark','preview'],hidden:[],row:defaultRow('unmark')},
    };
    const load = () => page.evaluate(async()=> (await window.pinote.loadState()).taskActions);
    const row = page.locator(`[data-id="${first}"]`);
    const action = id => row.locator(`[data-row-element="${id}"]`);
    const bar = page.getByRole('toolbar',{name:new RegExp(`^Actions for task ${first}:`)});
    const resize = async width => {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,660),width);
      await page.waitForFunction(width=>innerWidth===width,width);
      // Chromium exposes the new viewport before dispatching its resize/reflow callbacks.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    // Shared legacy preferences migrate to rows, with preview appended to menus.
    await page.evaluate(async order => {
      const state=await window.pinote.loadState();
      await window.pinote.saveState({...state,taskActions:{order,hidden:[],primary:'start'}});
    },original);
    await page.reload(); await row.waitFor(); await resize(580);
    await openSettings();
    assert.deepEqual(await rowOrder(),defaultRow('start'));
    await tab('Not started').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await tab('In progress').getAttribute('aria-selected'),'true');
    assert.deepEqual(await rowOrder(),defaultRow('done'));
    await page.keyboard.press('End');
    assert.equal(await tab('Marked for deletion').getAttribute('aria-selected'),'true');
    assert.deepEqual(await rowOrder(),defaultRow('unmark'));
    await page.keyboard.press('Home');
    await save(); assert.deepEqual(await load(),defaults);
    // Per-state legacy migration preserves each primary and hidden list too.
    await page.evaluate(async ({original}) => {
      const state=await window.pinote.loadState();
      await window.pinote.saveState({...state,taskActions:{
        active:{order:original,hidden:['start'],primary:'copy'},
        in_progress:{order:original,hidden:[],primary:'start'},
        marked:{order:[...original,'unmark'],hidden:['done'],primary:'unmark'},
      }});
    },{original});
    await page.reload(); await row.waitFor(); await openSettings();
    assert.deepEqual(await rowOrder(),defaultRow('copy'));
    await tab('In progress').click(); assert.deepEqual(await rowOrder(),defaultRow('start'));
    await tab('Marked for deletion').click(); await available();
    assert.deepEqual(await menuOrder(),[...original,'unmark','preview']);
    assert.equal(await picker.getByRole('checkbox',{name:'Show Complete in menu',exact:true}).isChecked(),false);
    await closePicker();
    for(const name of ['Not started','In progress','Marked for deletion']) {
      await tab(name).click(); await settings.getByRole('button',{name:`Restore default actions for ${name}`,exact:true}).click();
    }
    await save(); assert.deepEqual(await load(),defaults);
    await openSettings(); await tab('Not started').click();
    for(const label of ['Tag','Task text']) {
      assert.equal(await settings.getByRole('button',{name:`Remove ${label} from row`,exact:true}).count(),0);
    }
    await settings.getByRole('button',{name:'Reorder Tag',exact:true}).dragTo(settings.locator('.row-settings-list [data-element="start"]'),{targetPosition:{x:50,y:2}});
    await settings.getByRole('button',{name:'Reorder Task text',exact:true}).focus();
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    assert.deepEqual(await rowOrder(),['task-text','task-tag','start','preview','actions']);
    assert.ok(await settings.getByRole('button',{name:'Reorder Task text',exact:true}).evaluate(n=>n===document.activeElement));
    await remove('Preview'); await remove('Actions'); await available();
    for(const label of ['Copy note','Start in Kitty…','Complete','Remove to archive','Edit text…','Set reminder…','Change tag…','Preview']) await add(label);
    assert.ok(await picker.getByRole('button',{name:'Copy note already in row',exact:true}).isDisabled());
    await add('Actions');
    assert.ok(await picker.getByRole('button',{name:'Add Actions to row',exact:true}).isDisabled());
    await picker.getByRole('button',{name:'Reorder Copy note',exact:true}).dragTo(picker.locator('.action-settings-list [data-element="kitty"]'),{targetPosition:{x:50,y:2}});
    await picker.getByRole('button',{name:'Reorder Change tag…',exact:true}).focus();
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    const customMenu=['copy','kitty','start','done','archive','tag','edit','schedule','preview'];
    assert.deepEqual(await menuOrder(),customMenu);
    // Hide every menu action; overflowing row actions must still be reachable.
    for(const checkbox of await picker.getByRole('checkbox').all()) await checkbox.uncheck();
    await page.screenshot({path:join(root,'task-actions-picker.png')});
    await closePicker();
    const customRow=await rowOrder();
    assert.deepEqual(await settings.locator('.layout-preview .task-content > [data-row-element]').evaluateAll(nodes=>nodes.map(n=>n.dataset.rowElement)),customRow);
    assert.ok(await settings.locator('.layout-preview').evaluate(n=>n.inert));
    assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===first).state,'active');
    await page.screenshot({path:join(root,'task-actions-settings.png')});
    // Failed persistence must not apply the draft to the actual row or disk.
    await app.evaluate(({ipcMain})=>{
      const original=ipcMain._invokeHandlers.get('save-state');
      ipcMain.removeHandler('save-state'); ipcMain.handle('save-state',(...args)=>{
        ipcMain.removeHandler('save-state'); ipcMain.handle('save-state',original);
        throw new Error('Injected task-action save failure');
      });
    });
    await settings.getByRole('button',{name:'Save task actions',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('Injected task-action save failure'));
    assert.ok(await settings.isVisible()); assert.deepEqual(await load(),defaults);
    assert.equal(await row.locator('.checkbox').count(),1);
    await page.getByRole('button',{name:'Dismiss notice',exact:true}).click();
    await save(); await page.reload(); await row.waitFor();
    const persisted=await load();
    assert.deepEqual(persisted.active,{order:customMenu,hidden:customMenu,row:customRow});
    assert.deepEqual(persisted.in_progress,defaults.in_progress); assert.deepEqual(persisted.marked,defaults.marked);
    assert.deepEqual(JSON.parse(await readFile(join(env.XDG_DATA_HOME,'pinote','electron','state.json'),'utf8')).taskActions,persisted);
    await resize(1100);
    const liveOrder = () => row.locator('.task-content > [data-row-element]').evaluateAll(nodes=>nodes.filter(n=>!n.hidden).map(n=>n.dataset.rowElement));
    assert.deepEqual(await liveOrder(),customRow);
    await page.screenshot({path:join(root,'task-actions-custom-row.png')});
    const expected=call('snapshot',{view:'active'}).notes.find(n=>n.id===first);
    await action('copy').click();
    for(let i=0;i<100;i++) {
      if(await app.evaluate(({clipboard})=>clipboard.readText())===expected.text) break;
      await page.waitForTimeout(10);
    }
    assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),expected.text);
    assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===first).updated_at,expected.updated_at);
    await app.evaluate(({dialog})=>{
      globalThis.__originalFolderDialog=dialog.showOpenDialog; globalThis.__folderCalls=0;
      dialog.showOpenDialog=()=>{globalThis.__folderCalls++; return new Promise(resolve=>{globalThis.__cancelFolder=()=>resolve({canceled:true,filePaths:[]});});};
    });
    await action('kitty').click({clickCount:2});
    await page.waitForFunction(id=>document.querySelector(`[data-id="${id}"] [data-row-element="kitty"]`)?.disabled,first);
    assert.equal(await app.evaluate(()=>globalThis.__folderCalls),1,'Busy Kitty action must not dispatch twice');
    await app.evaluate(({dialog})=>{globalThis.__cancelFolder(); dialog.showOpenDialog=globalThis.__originalFolderDialog;});
    await page.waitForFunction(id=>!document.querySelector(`[data-id="${id}"] [data-row-element="kitty"]`)?.disabled,first);
    assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===first).updated_at,expected.updated_at);
    await resize(280);
    const hidden=await row.locator('.row-action').evaluateAll(nodes=>nodes.filter(n=>n.hidden).map(n=>n.dataset.rowElement));
    assert.ok(hidden.length>0);
    await action('actions').click();
    const labels={kitty:'Start in Kitty…',copy:'Copy note',start:'Start',done:'Complete',archive:'Remove to archive',edit:'Edit text…',schedule:'Set reminder…',tag:'Change tag…',preview:'Preview'};
    for(const id of hidden) assert.equal(await bar.getByRole('button',{name:labels[id],exact:true}).count(),1,`Overflow ${id} must remain reachable`);
    await page.screenshot({path:join(root,'task-actions-row-narrow.png')});
    await page.keyboard.press('Escape');
    await openSettings();
    assert.ok(await settings.evaluate(n=>n.scrollWidth<=n.clientWidth),'280px settings must not clip horizontally');
    await page.screenshot({path:join(root,'task-actions-settings-narrow.png')});
    await available();
    assert.ok(await picker.evaluate(n=>n.scrollWidth<=n.clientWidth),'280px action picker must not clip horizontally');
    await page.screenshot({path:join(root,'task-actions-picker-narrow.png')});
    await closePicker(); await remove('Actions'); await save();
    await row.locator('[data-overflow-menu]').click(); assert.ok(await bar.isVisible()); await page.keyboard.press('Escape');
    await resize(1100); assert.deepEqual(await liveOrder(),customRow.filter(id=>id!=='actions'));
    assert.equal(await row.locator('[data-overflow-menu]').isVisible(),false);
    await row.locator('.task-title').click({button:'right'}); assert.ok(await bar.isVisible());
    assert.deepEqual(await bar.getByRole('button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Close task actions']);
    await page.keyboard.press('Escape');
    // Changes on every tab discard together, and resets remain state-local.
    await openSettings();
    for(const name of ['Not started','In progress','Marked for deletion']) {
      await tab(name).click(); await settings.getByRole('button',{name:`Restore default actions for ${name}`,exact:true}).click();
      await remove('Preview');
    }
    await page.keyboard.press('Escape');
    assert.deepEqual((await load()).in_progress,defaults.in_progress);
    assert.deepEqual((await load()).marked,defaults.marked);
    assert.deepEqual((await load()).active.row,customRow.filter(id=>id!=='actions'));
    await openSettings();
    for(const name of ['Not started','In progress','Marked for deletion']) {
      await tab(name).click(); await settings.getByRole('button',{name:`Restore default actions for ${name}`,exact:true}).click();
    }
    await tab('In progress').click(); await available(); await add('Reset progress');
    await picker.getByRole('checkbox',{name:'Show Start in Kitty… in menu',exact:true}).uncheck(); await closePicker();
    await tab('Marked for deletion').click(); await available(); await add('Copy note');
    await picker.getByRole('checkbox',{name:'Show Complete in menu',exact:true}).uncheck(); await closePicker();
    await tab('Not started').click(); assert.deepEqual(await rowOrder(),defaultRow('start')); await save();
    assert.deepEqual((await load()).in_progress.row,[...defaultRow('done'),'start']);
    const progressRow=page.locator(`[data-id="${progress}"]`);
    assert.match(await progressRow.locator('[data-row-element="start"]').getAttribute('title'),/: Reset progress;/);
    const completeId=call('add',{text:'Complete with the in-progress row button',tag:null}).id;
    const completeTask=call('snapshot',{view:'active'}).notes.find(n=>n.id===completeId);
    call('transition',{id:completeId,revision:completeTask.updated_at,state:'active',action:'start'});
    const completeRow=page.locator(`[data-id="${completeId}"]`); await completeRow.waitFor();
    await completeRow.locator('[data-row-element="done"]').click(); await completeRow.waitFor({state:'detached'});
    assert.equal(call('snapshot',{view:'archive'}).notes.find(n=>n.id===completeId).state,'done');
    await action('start').click({button:'right'});
    assert.ok(await row.evaluate(n=>n.classList.contains('marked')));
    assert.match(await action('unmark').getAttribute('title'),/: Cancel deletion mark;/);
    await action('copy').click(); assert.ok(await row.evaluate(n=>n.classList.contains('marked')),'Copy must not confirm deletion');
    await action('actions').click();
    assert.equal(await bar.getByRole('button',{name:'Complete',exact:true}).count(),0);
    assert.equal(await bar.getByRole('button',{name:'Cancel deletion mark',exact:true}).count(),1);
    await page.keyboard.press('Escape');
    await page.screenshot({path:join(root,'task-actions-marked-row.png')});
    await action('unmark').click(); assert.equal(await row.evaluate(n=>n.classList.contains('marked')),false);
    await openSettings();
    for(const name of ['In progress','Marked for deletion']) {
      await tab(name).click(); await settings.getByRole('button',{name:`Restore default actions for ${name}`,exact:true}).click();
    }
    await save(); assert.deepEqual(await load(),defaults);
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),geometry);
  }
  {
    const preview = await openPreview(() => page.locator(`[data-id="${first}"]`).getByRole('button',{name:'Preview full task',exact:true}).click());
    assert.equal(await preview.evaluate(()=>window.compromised),undefined);
    assert.equal(await preview.getByRole('dialog').locator('img[src^="http"]').count(),0);
    assert.equal(await preview.evaluate(()=>typeof window.pinote),'undefined');
    assert.deepEqual(await preview.evaluate(()=>Object.keys(window.pinotePreview).sort()),['action','load','onUpdate','openLink','ready']);
    assert.equal(await page.evaluate(()=>typeof window.pinotePreview),'undefined');
    await app.evaluate(async ({BrowserWindow, ipcMain}) => {
      const child = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='pinote-app://ui/preview.html');
      const event = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
      for (const channel of ['backend','save-state','finish-close']) {
        const handler = ipcMain._invokeHandlers.get(channel);
        if (!handler) throw new Error(`Missing owner handler: ${channel}`);
        try { await handler(event, 'edit', {}); } catch (error) {
          if (/Untrusted IPC sender/.test(String(error))) continue;
          throw error;
        }
        throw new Error(`Preview invoked owner channel: ${channel}`);
      }
    });
    await preview.screenshot({path:join(root,'preview.png')});
    await dismissPreview(preview);
  }
  await page.getByRole('textbox',{name:'Add a task…',exact:true}).fill('Electron lifecycle ☘\nsecond line');
  await page.keyboard.press('Enter');
  await page.locator('.task-title').filter({hasText:/^Electron lifecycle ☘$/}).waitFor();
  assert.equal(call('snapshot',{view:'active'}).notes.filter(n=>n.text==='Electron lifecycle ☘\nsecond line').length,1);
  const added = call('snapshot',{view:'active'}).notes.find(n=>n.text.startsWith('Electron lifecycle'));
  // One integrated Markdown source regression: real textbox keys, undo, paste,
  // storage, compact title, reload and explicit draft copy.
  {
    const checkBulletIndent = async (textbox, name) => {
      const source = '# Indentation\n- Parent\n- Child';
      await textbox.fill(source); await textbox.press('Control+End');
      await textbox.press('Tab'); await textbox.press('Tab');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\n    - Child');
      assert.equal(await textbox.evaluate(node=>node===document.activeElement),true,'Indenting must retain editor focus');
      await textbox.press('Control+z');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\n  - Child','Each indentation level is independently undoable');
      await textbox.press('Control+y');
      await textbox.press('Backspace');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\n    - Chil','Backspace inside text deletes normally');
      for(let i=0;i<4;i++) await textbox.press('ArrowLeft');
      await textbox.press('Backspace');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\n  - Chil');
      await textbox.press('Backspace');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\n- Chil','Outdenting must preserve the bullet');
      await textbox.press('Backspace');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\nChil','Only the top-level Backspace removes the marker');
      await textbox.press('Control+z');
      assert.equal(await sourceValue(textbox),'# Indentation\n- Parent\n- Chil','Marker removal is undoable');
      await textbox.fill('  - '); await textbox.press('Control+End');
      await textbox.press('Backspace'); assert.equal(await sourceValue(textbox),'- ');
      await textbox.press('Backspace'); assert.equal(await sourceValue(textbox),'');
      await textbox.fill('\t- Imported');
      assert.equal(await sourceValue(textbox),'\t- Imported','Loading preserves existing tabs');
      await textbox.press('Control+End'); await textbox.press('Tab');
      assert.equal(await sourceValue(textbox),'    - Imported','Indent commands use two spaces, never tabs');
      await textbox.press('Shift+Tab');
      assert.equal(await textbox.evaluate(node=>node===document.activeElement),false,'Shift+Tab remains available for focus navigation');
      await textbox.fill('# Bullet indentation\n- Parent\n- Child');
      await textbox.press('Control+End'); await textbox.press('Tab');
      await textbox.press('Shift+Enter'); await page.keyboard.type('Grandchild');
      await textbox.press('Tab');
      assert.equal(await sourceValue(textbox),'# Bullet indentation\n- Parent\n  - Child\n    - Grandchild');
      const bounds = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:25,y:25,width:520,height:400}));
      await textbox.press('Control+Home');
      await page.screenshot({path:join(root,`bullet-indent-${name}.png`)});
      await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),bounds);
    };
    const composer = page.getByRole('textbox',{name:'Add a task…',exact:true});
    await composer.press('Control+z');
    assert.equal(await sourceValue(composer),'','Undo must not resurrect a submitted task');
    await composer.fill('Plain heading');
    await composer.press('End');
    await composer.press('Shift+Enter');
    assert.equal(await sourceValue(composer),'# Plain heading\n- ');
    await composer.press('Control+z');
    assert.equal(await sourceValue(composer),'Plain heading','Auto-prefix must undo with its newline');
    await composer.press('Control+y');
    assert.equal(await sourceValue(composer),'# Plain heading\n- ');
    await page.keyboard.type('first');
    await composer.press('Shift+Enter');
    assert.equal(await sourceValue(composer),'# Plain heading\n- first\n- ');
    await composer.press('Shift+Enter');
    assert.equal(await sourceValue(composer),'# Plain heading\n- first\n');
    await page.keyboard.type('ordinary');
    await composer.press('Shift+Enter');
    assert.equal(await sourceValue(composer),'# Plain heading\n- first\nordinary\n');
    await composer.fill('**Bold heading**');
    await composer.press('End'); await composer.press('Shift+Enter');
    assert.equal(await sourceValue(composer),'# **Bold heading**\n- ');
    await composer.fill('# Title\n  - first tail');
    await composer.press('Control+End');
    for (let i=0;i<4;i++) await composer.press('ArrowLeft');
    await composer.press('Shift+Enter');
    assert.equal(await sourceValue(composer),'# Title\n  - first \n  - tail','Splitting an indented bullet retains its marker and tail');
    await checkBulletIndent(composer,'add');
    const composerSource = await sourceValue(composer);
    await composer.press('Enter');
    await page.locator('.task-title').filter({hasText:/^Bullet indentation$/}).waitFor();
    assert.ok(call('snapshot',{view:'active'}).notes.some(note=>note.text===composerSource),'Enter submits Markdown bullets instead of continuing them');
    await composer.fill('Selected text'); await composer.press('Control+a');
    await app.evaluate(({clipboard})=>clipboard.writeText('https://example.org/source'));
    await composer.press('Control+v');
    assert.equal(await sourceValue(composer),'https://example.org/source','Pasting a URL replaces selected source without creating a Markdown link');
    await composer.fill('');

    const source='# Markdown source **bold** *italic* `code`\n- saved bullet';
    await selectTaskAction(page, added.id, 'Edit text…');
    const editor=page.getByRole('textbox',{name:'Task text',exact:true});
    await checkBulletIndent(editor,'edit');
    await editor.press('Control+Enter');
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(call('snapshot',{view:'active'}).notes.find(note=>note.id===added.id).text,composerSource,'Saving preserves two-space nesting');
    await page.locator(`[data-id="${added.id}"] .task-title`).filter({hasText:/^Bullet indentation$/}).waitFor();
    await selectTaskAction(page, added.id, 'Edit text…');
    assert.equal(await sourceValue(editor),composerSource,'Reload preserves nesting');
    await editor.fill(source);
    await editor.press('Control+End');
    await editor.press('Enter');
    assert.equal(await sourceValue(editor),source+'\n- ');
    await editor.press('Backspace');
    await page.keyboard.type('plain'); await editor.press('Enter');
    assert.equal(await sourceValue(editor),source+'\nplain\n','Deleting a bullet must allow plain following lines');
    await editor.fill(source);
    for(const selector of ['.source-heading','.source-strong','.source-emphasis','.source-code']) {
      await editor.locator(selector).first().waitFor();
    }
    assert.equal(await sourceValue(editor),source,'Styling must retain all Markdown markers');
    await editor.press('Control+Home');
    await editor.press('Tab');
    const undoEditor = page.getByRole('button',{name:'Undo text edit (Ctrl+Z)',exact:true});
    assert.equal(await undoEditor.evaluate(node=>node===document.activeElement),true,'Tab from the editor reaches footer actions');
    await undoEditor.press('Shift+Tab');
    assert.equal(await editor.evaluate(node=>node===document.activeElement),true,'Shift+Tab returns to the source editor');
    const editorBounds = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:25,y:25,width:520,height:400}));
    await editor.press('Control+Home');
    await page.screenshot({path:join(root,'markdown-source.png')});
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),editorBounds);
    await editor.press('Control+Enter');
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===added.id).text,source);
    await page.locator(`[data-id="${added.id}"] .task-title`).filter({hasText:/^Markdown source/}).waitFor();
    assert.equal(await page.locator(`[data-id="${added.id}"] .task-title`).textContent(),'Markdown source **bold** *italic* `code`');
    await selectTaskAction(page, added.id, 'Edit text…');
    assert.equal(await sourceValue(editor),source,'Loading source must not normalize it');
    await page.getByRole('button',{name:'Copy edit draft',exact:true}).click();
    assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),source);
    await editor.fill('Electron lifecycle ☘\nsecond line');
    await editor.press('Control+Enter');
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.locator(`[data-id="${added.id}"] .task-title`).filter({hasText:/^Electron lifecycle ☘$/}).waitFor();
  }
  await selectTaskAction(page, added.id, 'Edit text…');
  await page.getByRole('textbox',{name:'Task text',exact:true}).fill('Edited from Electron ☘\nkeeps ID and history');
  await page.keyboard.press('Control+Enter');
  await page.locator('.task-title').filter({hasText:/^Edited from Electron ☘$/}).waitFor();
  assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===added.id).text,'Edited from Electron ☘\nkeeps ID and history');
  // Autosave owns a revision chain across typing, tag changes and detached editors.
  {
    const original='Edited from Electron ☘\nkeeps ID and history';
    const snapshot=()=>call('snapshot',{view:'active'}).notes.find(n=>n.id===added.id);
    const editDialog=page.getByRole('dialog',{name:`Edit task ${added.id}`,exact:true});
    const text=editDialog.getByRole('textbox',{name:'Task text',exact:true});
    const saved=async()=>editDialog.getByText('All changes saved',{exact:true}).waitFor();
    await selectTaskAction(page, added.id, 'Edit text…');
    await text.fill('Autosaved without a shortcut\n- Keep Markdown');
    assert.equal(snapshot().text,original,'Typing debounce must not dispatch immediately');
    await saved();
    assert.equal(snapshot().text,'Autosaved without a shortcut\n- Keep Markdown');
    assert.ok(await editDialog.isVisible(),'Autosave keeps the editor open');
    await editDialog.getByRole('button',{name:'Undo text edit (Ctrl+Z)',exact:true}).click();
    await saved(); assert.equal(snapshot().text,original,'Undo after autosave writes the reverted source');
    const delayedEditReady=async value=>{
      for(let i=0;i<200;i++) {
        if(await readFile(editMarker,'utf8').catch(()=>null)===value) return;
        await new Promise(r=>setTimeout(r,20));
      }
      assert.fail('Delayed edit must reach its injected wait');
    };
    await writeFile(faultFile,'slow-edit');
    await text.fill('First delayed autosave');
    await delayedEditReady('First delayed autosave');
    await text.fill('Newer typing during save');
    await writeFile(faultFile,'');
    await saved(); assert.equal(snapshot().text,'Newer typing during save','In-flight typing must chain from the exact acknowledged revision');
    await writeFile(faultFile,'slow-busy-edit');
    await text.fill('Retry only when asked');
    await editDialog.getByRole('button',{name:'Change tag: Untagged',exact:true}).click();
    await delayedEditReady('Retry only when asked');
    await page.getByRole('dialog',{name:'Task tag',exact:true}).getByRole('button',{name:/^Work \(/}).click();
    await editDialog.getByText('Not saved — retry',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await writeFile(faultFile,'');
    await page.waitForTimeout(900);
    assert.equal(snapshot().text,'Newer typing during save','Failed edits must never replay on a later poll');
    assert.equal(snapshot().tag,null);
    assert.equal((await page.evaluate(()=>window.pinote.loadState())).edits[String(added.id)].pendingTag,'Work','The tag accepted during an in-flight failed write must be retained');
    await page.keyboard.press('Escape'); await editDialog.waitFor({state:'detached'});
    await selectTaskAction(page, added.id, 'Edit text…');
    await editDialog.getByRole('button',{name:'Change tag: Work (not saved)',exact:true}).waitFor();
    await editDialog.getByRole('button',{name:'Retry saving changes (Ctrl+Enter)',exact:true}).click();
    await saved(); assert.equal(snapshot().text,'Retry only when asked');
    assert.equal(snapshot().tag,'Work','Explicit retry must save text and its pending tag');
    // Tag-only failure, including clearing a tag, survives closing and reopening.
    for(const pendingTag of [null,'Work']) {
      await writeFile(faultFile,'busy-tag');
      await editDialog.getByRole('button',{name:`Change tag: ${snapshot().tag ?? 'Untagged'}`,exact:true}).click();
      await page.getByRole('dialog',{name:'Task tag',exact:true}).getByRole('button',{name:new RegExp(`^${pendingTag ?? 'Untagged'} \\(`)}).click();
      await editDialog.getByText('Not saved — retry',{exact:true}).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(async({id,tag})=>(await window.pinote.loadState()).edits[String(id)]?.pendingTag===tag,{id:added.id,tag:pendingTag});
      const disk=JSON.parse(await readFile(join(env.XDG_DATA_HOME,'pinote/electron/state.json'),'utf8'));
      assert.equal(disk.edits[String(added.id)].pendingTag,pendingTag,'Pending tag must reach durable recovery storage');
      await page.keyboard.press('Escape');
      await editDialog.waitFor({state:'detached'});
      await writeFile(faultFile,'');
      // The saved tag may hide this row under the current filter; recovery must still open it.
      if (!await page.getByRole('dialog',{name:'Private edit drafts',exact:true}).count()) await selectNativeMenu(()=>page.getByRole('button',{name:'Menu',exact:true}).click(),'drafts');
      await page.getByRole('button',{name:'Open revision-bound editor',exact:true}).click();
      await editDialog.getByText('Not saved — retry',{exact:true}).waitFor();
      await page.waitForTimeout(900);
      assert.notEqual(snapshot().tag,pendingTag,'Reopening must not replay the failed tag selection');
      await editDialog.getByRole('button',{name:`Change tag: ${pendingTag ?? 'Untagged'} (not saved)`,exact:true}).waitFor();
      await editDialog.getByRole('button',{name:'Retry saving changes (Ctrl+Enter)',exact:true}).click();
      await saved(); assert.equal(snapshot().tag,pendingTag);
    }
    await editDialog.getByRole('button',{name:'Change tag: Work',exact:true}).click();
    await page.getByRole('dialog',{name:'Task tag',exact:true}).getByRole('button',{name:/^Untagged \(/}).click();
    await saved();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await selectTaskAction(page, added.id, 'Edit text…');
    await writeFile(faultFile,'slow-edit');
    await text.fill('Own pending acknowledgement');
    await delayedEditReady('Own pending acknowledgement');
    await text.fill('Local text after external race');
    const beforeExternal=snapshot();
    call('edit',{id:added.id,revision:beforeExternal.updated_at,text:'External client wins'});
    await writeFile(faultFile,'');
    await page.waitForFunction(()=>document.querySelector('.cm-content[aria-label="Task text"]')?.getAttribute('aria-readonly')==='true');
    assert.equal(snapshot().text,'External client wins','A late acknowledgement must never adopt an external revision');
    assert.equal(await sourceValue(text),'Local text after external race');
    await editDialog.getByRole('button',{name:'Copy edit draft',exact:true}).click();
    assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'Local text after external race');
    await page.keyboard.press('Escape');
    await selectNativeMenu(()=>page.getByRole('button',{name:'Menu',exact:true}).click(),'drafts');
    await page.getByRole('button',{name:'Discard private draft',exact:true}).click();
    await page.getByRole('button',{name:'Confirm',exact:true}).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Dismiss notice',exact:true}).click();
    await selectTaskAction(page, added.id, 'Edit text…');
    await text.fill('Text and tag saved together');
    await editDialog.getByRole('button',{name:'Change tag: Untagged',exact:true}).click();
    await page.getByRole('dialog',{name:'Task tag',exact:true}).getByRole('button',{name:/^Work \(/}).click();
    await editDialog.getByRole('button',{name:'Change tag: Work',exact:true}).waitFor();
    await saved(); assert.equal(snapshot().tag,'Work'); assert.equal(snapshot().text,'Text and tag saved together');
    assert.equal(await text.getAttribute('aria-readonly'),'false','Own tag updates must not stale the editor');
    await editDialog.getByRole('button',{name:'Change tag: Work',exact:true}).click();
    await page.getByRole('searchbox',{name:'Search tags',exact:true}).fill('Editor tag');
    await page.getByRole('button',{name:'Create tag “Editor tag”…',exact:true}).click();
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},root);
    await page.getByRole('button',{name:'Choose default Kitty folder',exact:true}).click();
    await writeFile(faultFile,'busy-create-tag');
    await page.getByRole('button',{name:'Create tag',exact:true}).click();
    await editDialog.getByText('Not saved — retry',{exact:true}).waitFor();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const pendingCreate=(await page.evaluate(()=>window.pinote.loadState())).edits[String(added.id)];
    assert.equal(pendingCreate.pendingTag,'Editor tag'); assert.equal(pendingCreate.pendingTagFolder,root,'Failed creation must retain its chosen folder');
    await writeFile(faultFile,'');
    await editDialog.getByRole('button',{name:'Retry saving changes (Ctrl+Enter)',exact:true}).click();
    await editDialog.getByRole('button',{name:'Change tag: Editor tag',exact:true}).waitFor();
    assert.equal(snapshot().tag,'Editor tag');
    assert.equal(call('snapshot',{view:'active'}).tags.find(t=>t.name==='Editor tag').folder,root);
    await page.getByRole('button',{name:'Dismiss notice',exact:true}).click();
    await editDialog.getByRole('button',{name:'Change tag: Editor tag',exact:true}).click();
    await page.getByRole('dialog',{name:'Task tag',exact:true}).getByRole('button',{name:/^Untagged \(/}).click();
    await editDialog.getByRole('button',{name:'Change tag: Untagged',exact:true}).waitFor();
    assert.equal(snapshot().tag,null);
    call('delete_tag',{name:'Editor tag'});
    await text.fill('# Redesign the task editor\n\nKeep writing focused.\n\n- Save after a typing pause\n- Change tags in the header\n- Keep local text on failure');
    await saved();
    const bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
    for(const [width,height] of [[720,540],[320,480],[280,260]]) {
      await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setBounds({x:20,y:20,...size}),{width,height});
      await text.press('Control+Home');
      assert.equal(await editDialog.evaluate(panel=>panel.scrollWidth<=panel.clientWidth),true,'Editor must not clip horizontally');
      for(const name of ['Change tag: Untagged','Undo text edit (Ctrl+Z)','Copy edit draft',`Close Edit task ${added.id}`]) {
        const control=editDialog.getByRole('button',{name,exact:true});
        await control.scrollIntoViewIfNeeded();
        assert.equal(await control.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),true,`${name} remains reachable at ${width}x${height}`);
      }
      await page.screenshot({path:join(root,`editor-autosave-${width}.png`)});
    }
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),bounds);
    await text.fill('Close flushes the debounce');
    await page.keyboard.press('Escape');
    await editDialog.waitFor({state:'detached'});
    await page.locator(`[data-id="${added.id}"] .task-title`).filter({hasText:/^Close flushes the debounce$/}).waitFor();
    await selectTaskAction(page, added.id, 'Edit text…');
    await saved(); assert.equal(await sourceValue(text),'Close flushes the debounce');
    assert.equal(snapshot().text,'Close flushes the debounce');
    await text.fill(original); await saved();
    await page.keyboard.press('Escape');
  }
  await selectTaskAction(page, added.id, 'Start');
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"]`)?.classList.contains('progress'), added.id);
  // Queue a refresh behind completion so clearing busy renders the old snapshot.
  await writeFile(faultFile,'slow-complete');
  await selectTaskAction(page, added.id, 'Complete');
  let completionCommitted=false;
  for(let i=0;i<200;i++) {
    try { completionCommitted=await readFile(completeMarker,'utf8')==='committed'; } catch(error) { if(error.code!=='ENOENT') throw error; }
    if(completionCommitted) break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(completionCommitted,'Completion must commit before the overlapping refresh');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(id=>document.querySelector(`[data-id="${id}"]`)?.classList.contains('completed'),added.id);
  await page.screenshot({path:join(root,'completion-refresh.png')});
  await page.locator(`[data-id="${added.id}"]`).waitFor({state:'detached'});
  await writeFile(faultFile,'');
  assert.ok(call('snapshot',{view:'archive'}).notes.some(n=>n.id===added.id));
  await selectNativeMenu(() => page.getByRole('button',{name:'Menu',exact:true}).click(), 'archive');
  await page.getByRole('article').filter({hasText:'Edited from Electron ☘'}).getByRole('button',{name:'Restore task',exact:true}).click();
  await page.keyboard.press('Escape');
  await page.locator('.task-title').filter({hasText:/^Edited from Electron ☘$/}).waitFor();
  await selectTaskAction(page, added.id, 'Remove to archive');
  await page.locator(`[data-id="${added.id}"]`).waitFor({state:'detached'});
  assert.equal(call('snapshot',{view:'archive'}).notes.find(n=>n.id===added.id).state,'removed');
  await selectNativeMenu(() => page.getByRole('button',{name:'Menu',exact:true}).click(), 'archive');
  await page.getByRole('article').filter({hasText:'Edited from Electron ☘'}).getByRole('button',{name:'Restore task',exact:true}).click();
  await page.keyboard.press('Escape');
  await page.locator('.task-title').filter({hasText:/^Edited from Electron ☘$/}).waitFor();
  await selectTaskAction(page, added.id, 'Set reminder…');
  await page.getByRole('textbox',{name:'When (local time)',exact:true}).fill('2099-01-01 12:00');
  await page.getByRole('button',{name:'Set reminder',exact:true}).click();
  await page.locator(`[data-id="${added.id}"]`).waitFor({state:'detached'});
  assert.ok(call('snapshot',{view:'scheduled'}).notes.some(n=>n.id===added.id));
  await selectNativeMenu(() => page.getByRole('button',{name:'Menu',exact:true}).click(), 'scheduled');
  await page.getByRole('button',{name:'Release reminder now',exact:true}).click();
  await page.keyboard.press('Escape');
  await page.locator('.task-title').filter({hasText:/^Edited from Electron ☘$/}).waitFor();
  await page.getByRole('button',{name:'New-task tag: Untagged',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search tags',exact:true}).fill('Side project');
  await page.getByRole('button',{name:'Create tag “Side project”…',exact:true}).click();
  await page.getByRole('button',{name:'Create tag',exact:true}).click();
  await page.getByRole('button',{name:'New-task tag: Side project',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Add a task…',exact:true}).fill('Tagged Electron task'); await page.keyboard.press('Enter');
  await page.locator('.task-title').filter({hasText:/^Tagged Electron task$/}).waitFor();
  assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.text==='Tagged Electron task').tag,'Side project');
  await page.getByRole('button',{name:'New-task tag: Side project',exact:true}).click();
  assert.deepEqual(await page.locator('.tag-choice span').allTextContents(),['Side project (1)','Work (101) ▶ 1','Empty filter (0)','Untagged (4)']);
  await page.screenshot({path:join(root,'recent-tags.png')});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); // reset creation tag, not the filter or existing tasks
  const tagged=call('snapshot',{view:'active'}).notes.find(n=>n.text==='Tagged Electron task');
  await selectTaskAction(page, tagged.id, 'Change tag…');
  await page.getByRole('dialog').getByRole('button',{name:/^Untagged \(/}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===tagged.id).tag,null);
  // Manage tags: one searchable list/editor workflow, with real shared-backend refreshes.
  {
    const geometry = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
    const manage = page.getByRole('dialog',{name:'Manage tags',exact:true});
    await selectNativeMenu(()=>page.getByRole('button',{name:'Menu',exact:true}).click(),'manage-tags');
    await manage.getByRole('button',{name:'Create saved tag',exact:true}).click();
    const create = page.getByRole('dialog',{name:'New tag',exact:true});
    await create.getByRole('textbox',{name:'Name',exact:true}).fill('pinote');
    await create.getByRole('button',{name:'Create tag',exact:true}).click();
    await create.waitFor({state:'detached'});
    await manage.getByRole('heading',{name:'pinote',exact:true}).waitFor();
    const search = manage.getByRole('searchbox',{name:'Find saved tag',exact:true});
    const list = manage.getByRole('group',{name:'Saved tags',exact:true});
    await search.fill('PiNoTe');
    assert.deepEqual(await list.getByRole('button').allTextContents(),['pinote']);
    await search.press('ArrowDown');
    assert.equal(await list.getByRole('button',{name:'pinote',exact:true}).evaluate(n=>n===document.activeElement),true);
    await page.keyboard.press('Enter');
    assert.equal(await list.getByRole('button',{name:'pinote',exact:true}).getAttribute('aria-pressed'),'true');
    const current = call('snapshot',{view:'active'}).notes.find(n=>n.id===tagged.id);
    call('tag',{id:current.id,revision:current.updated_at,tag:'pinote'});
    const name = manage.getByRole('textbox',{name:'Tag name',exact:true});
    await name.fill('pinote-app');
    call('tag_folder',{name:'pinote',folder:root});
    call('create_tag',{name:'docs',folder:null});
    await page.waitForFunction(folder=>document.querySelector('.tag-editor .folder-path')?.textContent===folder,root);
    assert.equal(await name.inputValue(),'pinote-app','External folder updates must preserve the unfinished name');
    assert.equal(await name.evaluate(n=>n===document.activeElement),true,'Polling must preserve editor focus');
    await manage.getByRole('button',{name:'Rename tag',exact:true}).click();
    await manage.getByRole('heading',{name:'pinote-app',exact:true}).waitFor();
    assert.equal(await search.inputValue(),'','The renamed selection must remain visible');
    assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===tagged.id).tag,'pinote-app');
    await manage.getByRole('button',{name:'Clear default Kitty folder',exact:true}).click();
    await manage.locator('.folder-path').filter({hasText:'No default folder'}).waitFor();
    assert.equal(call('snapshot',{view:'active'}).tags.find(t=>t.name==='pinote-app').folder,null);
    await app.evaluate(({dialog},folder)=>{
      globalThis.__manageFolderDialog=dialog.showOpenDialog;
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});
    },root);
    try {
      await manage.getByRole('button',{name:'Set default Kitty folder',exact:true}).click();
      await page.waitForFunction(folder=>document.querySelector('.tag-editor .folder-path')?.textContent===folder,root);
    } finally { await app.evaluate(({dialog})=>{dialog.showOpenDialog=globalThis.__manageFolderDialog;}); }
    assert.equal(call('snapshot',{view:'active'}).tags.find(t=>t.name==='pinote-app').folder,root);
    for (const [width,height] of [[760,560],[420,560],[280,360]]) {
      await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});
      await page.waitForFunction(width=>innerWidth===width,width);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await manage.evaluate(n=>n.scrollWidth<=n.clientWidth),true,`No horizontal overflow at ${width}px`);
      assert.equal(await list.evaluate(n=>{
        const row=n.querySelector('.chosen').getBoundingClientRect(), box=n.getBoundingClientRect();
        return row.top>=box.top-1 && row.bottom<=box.bottom+1;
      }),true,'The selected tag stays visible when the list becomes shorter');
      await manage.evaluate(n=>{n.scrollTop=0;});
      await page.screenshot({path:join(root,`manage-tags-${width}.png`)});
      const remove = manage.getByRole('button',{name:'Delete saved tag…',exact:true});
      await remove.scrollIntoViewIfNeeded();
      const box=await remove.boundingBox(), viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      assert.ok(box.x>=0 && box.x+box.width<=viewport.width && box.y>=0 && box.y+box.height<=viewport.height,'Delete remains reachable after resizing');
      if(width===280) await page.screenshot({path:join(root,'manage-tags-narrow-editor.png')});
    }
    await search.fill('no-such-saved-tag');
    await list.getByText('No matching tags.',{exact:true}).waitFor();
    assert.equal(await list.getByRole('button').count(),0);
    assert.equal(await name.inputValue(),'pinote-app','Search must not discard the selected editor');
    await search.fill('');
    await manage.getByRole('button',{name:'Delete saved tag…',exact:true}).click();
    const confirm = page.getByRole('dialog',{name:'Delete tag?',exact:true});
    await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.ok(call('snapshot',{view:'active'}).tags.some(t=>t.name==='pinote-app'));
    await manage.getByRole('button',{name:'Delete saved tag…',exact:true}).click();
    await confirm.getByRole('button',{name:'Confirm',exact:true}).click();
    await confirm.waitFor({state:'detached'});
    await list.getByRole('button',{name:'pinote-app',exact:true}).waitFor({state:'detached'});
    const after = call('snapshot',{view:'active'});
    assert.equal(after.tags.some(t=>t.name==='pinote-app'),false);
    assert.equal(after.notes.find(n=>n.id===tagged.id).tag,null,'Deleting a tag keeps its tasks');
    await list.getByRole('button',{name:'docs',exact:true}).click();
    await manage.getByRole('heading',{name:'docs',exact:true}).waitFor();
    call('delete_tag',{name:'docs'});
    await manage.getByRole('textbox',{name:'Tag name',exact:true}).waitFor({state:'detached'});
    await page.keyboard.press('Escape'); await manage.waitFor({state:'detached'});
    await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),geometry);
  }
  // Use the real service and native-client protocol on the same temporary data while GTK is running.
  Object.assign(process.env,env,{PINOTE_NOTE_COMMAND:resolve('../.venv/bin/note'),PI_CODING_AGENT_DIR:join(root,'pi-agent')});
  const piRequire=createRequire(resolve('../pi/package.json'));
  const { Client }=await import(piRequire.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StreamableHTTPClientTransport }=await import(piRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
  const { startPinoteHttpServer }=await import('../../pi/dist-mcp/mcp/http.js');
  service=await startPinoteHttpServer({token:'isolated-electron-test-token-'.repeat(3),port:0,logPath:join(root,'service.log')});
  client=new Client({name:'electron-coexistence-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url),{requestInit:{headers:{Authorization:`Bearer ${'isolated-electron-test-token-'.repeat(3)}`}}}));
  const task=call('snapshot',{view:'active'}).notes.find(n=>n.id===first);
  const update=await client.callTool({name:'update_current',arguments:{expected_updated_at:task.updated_at,set:{Next:'Shared update from Pi\n\n' + 'Long preview paragraph.\n\n'.repeat(60)}},_meta:{'native-ui/context':{conversationId:'isolated-test',state:{selectedId:first}}}});
  assert.ok(!update.isError,JSON.stringify(update));
  await page.getByRole('button',{name:'Unread agent update — click to view.',exact:true}).waitFor();
  await page.screenshot({path:join(root,'agent-update.png')});
  let disappearingPreview, previewOwnerBounds;
  // One popup lifecycle: captured pointer, edge placement, keyboard fallback and live data.
  {
    previewOwnerBounds = await app.evaluate(({BrowserWindow, screen}) => {
      const owner = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));
      const before = owner.getBounds(), area = screen.getDisplayMatching(before).workArea;
      owner.setBounds({...before, x:area.x+area.width-before.width, y:area.y+area.height-before.height});
      return before;
    });
    const placement = () => app.evaluate(({BrowserWindow, screen}) => {
      const owner = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));
      const popup = BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/preview.html'));
      return { owner:owner.getBounds(), content:owner.getContentBounds(), popup:popup?.getBounds(), area:screen.getDisplayMatching(owner.getBounds()).workArea };
    });
    const assertPlacement = (layout, point) => {
      const {popup, content, area} = layout;
      const axis = (at, size, start, span) => Math.max(start, Math.min(at+10+size<=start+span ? at+10 : at-10-size, start+span-size));
      assert.equal(popup.x,axis(content.x+point.x,popup.width,area.x,area.width));
      assert.equal(popup.y,axis(content.y+point.y,popup.height,area.y,area.height));
      assert.ok(popup.x>=area.x && popup.y>=area.y && popup.x+popup.width<=area.x+area.width && popup.y+popup.height<=area.y+area.height);
    };
    const opener = page.locator(`[data-id="${first}"] [data-row-element="preview"]`);
    await opener.scrollIntoViewIfNeeded();
    const box = await opener.boundingBox();
    const click = {x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};
    const before = await placement();
    let preview = await openPreview(async () => {
      await page.mouse.click(click.x,click.y);
      await page.mouse.move(1,1);
    });
    const shown = await placement();
    assertPlacement(shown,click);
    assert.deepEqual(shown.owner,before.owner,'Opening a preview must not resize or move its owner');
    assert.ok(shown.popup.x < shown.content.x+click.x,'Near the right screen edge the popup must flip left');
    const openedEvent = call('snapshot',{view:'active'}).notes.find(n=>n.id===first).agent_event_id;
    await page.waitForFunction(async ({id,event})=>(await window.pinote.loadState()).read[String(id)]===event,{id:first,event:openedEvent});
    await preview.locator('#body').evaluate(body=>{body.scrollTop=100;});
    const scroll = await preview.locator('#body').evaluate(body=>body.scrollTop);
    assert.ok(scroll>0,'Long agent fixture must exercise preview scrolling');
    const latest = call('snapshot',{view:'active'}).notes.find(n=>n.id===first);
    const live = await client.callTool({name:'update_current',arguments:{expected_updated_at:latest.updated_at,set:{Next:'Live popup update\n\n'+'Long preview paragraph.\n\n'.repeat(60)}},_meta:{'native-ui/context':{conversationId:'isolated-test',state:{selectedId:first}}}});
    assert.ok(!live.isError,JSON.stringify(live));
    await preview.getByText('Live popup update',{exact:true}).waitFor();
    assert.equal(await preview.locator('#body').evaluate(body=>body.scrollTop),scroll);
    assert.deepEqual(await placement(),shown,'Live updates must preserve both windows and popup geometry');
    assert.equal((await page.evaluate(()=>window.pinote.loadState())).read[String(first)],openedEvent,'Live updates must not acknowledge a later agent event');
    await dismissPreview(preview);
    await opener.focus();
    const fallback = await opener.evaluate(node=>{const r=node.getBoundingClientRect();return {x:Math.max(0,Math.round(r.left)),y:Math.max(0,Math.round(r.bottom))};});
    preview = await openPreview(()=>page.keyboard.press('Enter'));
    assertPlacement(await placement(),fallback);
    await preview.getByRole('button',{name:'Copy note',exact:true}).click();
    assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),latest.text);
    const closed = preview.waitForEvent('close');
    await preview.getByRole('button',{name:'Edit text…',exact:true}).click();
    await closed;
    await page.getByRole('textbox',{name:'Task text',exact:true}).waitFor();
    assert.equal(page.isClosed(),false);
    await page.keyboard.press('Escape');
    preview = await openPreview(()=>opener.click());
    // Keep this popup open for the existing CLI disappearance below.
    disappearingPreview = preview;
  }
  const cli=spawnSync(resolve('../.venv/bin/note'),['--no-notify','done',String(first)],{env,encoding:'utf8'}); assert.equal(cli.status,0,cli.stderr);
  await page.locator(`[data-id="${first}"]`).waitFor({state:'detached'});
  if (!disappearingPreview.isClosed()) await disappearingPreview.waitForEvent('close');
  await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setBounds(bounds),previewOwnerBounds);
  assert.equal(gtk.exitCode,null,'GTK must coexist without exiting');
  // Failed Kitty launch must keep the acknowledgement action, not offer a blocked retry.
  await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:['/nonexistent-pinote-kitty-test']});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await selectTaskAction(page, added.id, 'Start in Kitty…');
  await page.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#draft').getAttribute('aria-readonly')==='false');
  await page.getByRole('textbox',{name:'Add a task…',exact:true}).fill('Unfinished draft preserved');
  await page.waitForTimeout(250);
  // A failed close must preserve the window/draft and allow a later successful close.
  await selectTaskAction(page, added.id, 'Edit text…');
  const failedCloseEditor=page.locator('.cm-content[aria-label="Task text"]');
  await failedCloseEditor.fill('Private draft before failed close');
  const stateDir=join(env.XDG_DATA_HOME,'pinote/electron');
  await chmod(stateDir,0o500);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await page.getByText(/Could not finish closing:/).waitFor();
  assert.equal(await page.evaluate(()=>document.body.inert),false,'Failed close must restore interaction');
  assert.equal(await failedCloseEditor.evaluate(input=>input.getAttribute('aria-readonly')==='true'),false,'Failed close must restore the editor');
  await failedCloseEditor.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(' — still writable');
  assert.equal(await sourceValue(failedCloseEditor),'Private draft before failed close — still writable');
  await chmod(stateDir,0o700);
  await page.getByRole('button',{name:'Retry saving changes (Ctrl+Enter)',exact:true}).click();
  await page.getByText('All changes saved',{exact:true}).waitFor();
  await failedCloseEditor.fill('Private draft before failed close — still writable; app close flushes');
  await page.getByRole('button',{name:'Change tag: Untagged',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search tags',exact:true}).fill('Created at app close');
  await page.getByRole('button',{name:'Create tag “Created at app close”…',exact:true}).click();
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},root);
  await page.getByRole('button',{name:'Choose default Kitty folder',exact:true}).click();
  await writeFile(faultFile,'slow-create-tag');
  await page.getByRole('button',{name:'Create tag',exact:true}).click();
  let creationCommitted=false;
  for(let i=0;i<200;i++) { if(await readFile(createTagMarker,'utf8').catch(()=>null)==='committed') {creationCommitted=true;break;} await new Promise(r=>setTimeout(r,10)); }
  assert.ok(creationCommitted,'Tag creation must commit while its acknowledgement is delayed');
  const closed = app.waitForEvent('close');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await closed; app=undefined;
  const saved = JSON.parse(await readFile(join(env.XDG_DATA_HOME,'pinote/electron/state.json'),'utf8'));
  assert.equal(saved.draft,'Unfinished draft preserved');
  const afterClose=call('snapshot',{view:'active'});
  const savedAtClose=afterClose.notes.find(n=>n.id===added.id);
  assert.equal(savedAtClose.text,'Private draft before failed close — still writable; app close flushes','App close must drain a fresh edit before quitting');
  assert.equal(savedAtClose.tag,'Created at app close','App close must retain the accepted tag assignment, not just create a registry tag');
  assert.equal(afterClose.tags.find(t=>t.name==='Created at app close').folder,root);
  assert.equal(saved.edits[String(added.id)],undefined);
  await writeFile(faultFile,'');
  call('tag',{id:added.id,revision:savedAtClose.updated_at,tag:null}); call('delete_tag',{name:'Created at app close'});
  assert.equal(outgoing.length,0,`Unexpected remote resources: ${outgoing}`);
  assert.deepEqual(pageErrors,[]);
  // Submit in the same event-loop turn as paste: no debounce may be required for safety.
  const reopen=async(collapsed=false)=>{app=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[resolve('dist/main.cjs')],env,chromiumSandbox:true,timeout:20000});const p=await app.firstWindow();await p.locator(collapsed?'#draft':'.task-row').first().waitFor();await installNativeMenuProbe();return p;};
  const close=async()=>{const done=app.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await done;app=undefined;};
  let reopened=await reopen();
  // Restore working state together, not just text: the draft must retain its tag.
  {
    const composer = () => reopened.getByRole('textbox',{name:'Add a task…',exact:true});
    await reopened.getByRole('button',{name:/^New-task tag:/}).click();
    await reopened.getByRole('dialog',{name:'New-task tag',exact:true}).locator('[data-tag="Work"]').click();
    await composer().fill('Restart keeps the draft and its tag');
    await reopened.getByRole('button',{name:/^Filter by tag:/}).click();
    await reopened.getByRole('button',{name:'Clear selection (in-progress only)',exact:true}).click();
    await reopened.getByRole('searchbox',{name:'Search tags',exact:true}).fill('Work');
    await reopened.getByRole('dialog',{name:'Filter by tag',exact:true}).locator('[data-tag="Work"]').click();
    await reopened.keyboard.press('Escape');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:110,y:90,width:420,height:360}));
    await reopened.waitForTimeout(350);
    await reopened.locator('#ordinary').evaluate(node=>{node.scrollTop=420;});
    await reopened.waitForTimeout(250);
    const scroll=await reopened.locator('#ordinary').evaluate(node=>node.scrollTop);
    assert.ok(scroll>0);
    const expanded=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
    const before=await reopened.evaluate(()=>window.pinote.loadState());
    await reopened.getByRole('button',{name:'Collapse checklist',exact:true}).click();
    await close(); // Flushes even changes made inside the debounce period.
    // A collapsed restart intentionally has no visible task rows.
    reopened=await reopen(true);
    await reopened.getByRole('button',{name:'Expand checklist',exact:true}).waitFor();
    await reopened.waitForTimeout(350);
    assert.equal(await reopened.locator('#checklist').isVisible(),false);
    assert.equal(await sourceValue(composer()),'Restart keeps the draft and its tag');
    assert.equal(await reopened.getByRole('button',{name:'New-task tag: Work',exact:true}).count(),1);
    const restored=await reopened.evaluate(()=>window.pinote.loadState());
    assert.deepEqual(restored.filters,['Work']);
    for(const key of ['edits','read','taskActions']) assert.deepEqual(restored[key],before[key]);
    await reopened.screenshot({path:join(root,'restart-collapsed.png')});
    await reopened.getByRole('button',{name:'Expand checklist',exact:true}).click();
    await reopened.waitForTimeout(350);
    assert.deepEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds()),expanded);
    assert.equal(await reopened.locator('#ordinary').evaluate(node=>node.scrollTop),scroll);
    await reopened.screenshot({path:join(root,'restart-restored.png')});
    await composer().press('Enter');
    await reopened.waitForFunction(()=>document.querySelector('#draft .cm-placeholder'));
    const addedAfterRestart=call('snapshot',{view:'active'}).notes.find(n=>n.text==='Restart keeps the draft and its tag');
    assert.equal(addedAfterRestart?.tag,'Work');
    // Moving the collapsed window to the top must not clamp its hidden expanded rectangle.
    await reopened.getByRole('button',{name:'Collapse checklist',exact:true}).click();
    await reopened.waitForTimeout(200);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setPosition(110,0));
    await close(); reopened=await reopen(true);
    await reopened.getByRole('button',{name:'Expand checklist',exact:true}).waitFor();
    await reopened.waitForTimeout(350);
    assert.equal((await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds())).y,0);
    await reopened.getByRole('button',{name:'Expand checklist',exact:true}).click();
    // Clearing the creation tag and selecting All must survive another restart too.
    await reopened.getByRole('button',{name:'New-task tag: Work',exact:true}).click({button:'right'});
    await reopened.getByRole('button',{name:/^Filter by tag:/}).click();
    await reopened.getByRole('button',{name:'Select all tags',exact:true}).click();
    await reopened.keyboard.press('Escape');
    await reopened.locator('#ordinary').evaluate(node=>{node.scrollTop=210;});
    await reopened.waitForTimeout(250);
    await close(); reopened=await reopen();
    assert.equal(await reopened.getByRole('button',{name:'New-task tag: Untagged',exact:true}).count(),1);
    assert.equal((await reopened.evaluate(()=>window.pinote.loadState())).filters,null);
    assert.equal(await reopened.locator('#ordinary').evaluate(node=>node.scrollTop),210);
    // A tag removed while closed must not leave a restored draft using a stale tag.
    call('create_tag',{name:'Restart-only tag',folder:null});
    await reopened.getByRole('button',{name:'New-task tag: Untagged',exact:true}).click();
    await reopened.getByRole('dialog',{name:'New-task tag',exact:true}).locator('[data-tag="Restart-only tag"]').click();
    await close(); call('delete_tag',{name:'Restart-only tag'}); reopened=await reopen();
    assert.equal(await reopened.getByRole('button',{name:'New-task tag: Untagged',exact:true}).count(),1);
  }
  await writeFile(faultFile,'add');
  await reopened.evaluate(()=>{const input=document.querySelector('#draft');input.focus();window.getSelection().selectAllChildren(input);const data=new DataTransfer();data.setData('text/plain','Rapid uncertain add draft');input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));});
  await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).waitFor();
  await writeFile(faultFile,'snapshot');
  await reopened.getByText('busy: Injected rapid failure',{exact:true}).waitFor();
  assert.equal(await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).count(),1);
  assert.equal(await reopened.getByRole('button',{name:'Dismiss notice',exact:true}).count(),0);
  await reopened.screenshot({path:join(root,'recovery.png')});
  // Recovery keeps copy/private editing available, but disables all write actions.
  const readonlyActions=reopened.getByRole('button',{name:`Actions for task ${added.id}`,exact:true});
  await readonlyActions.click();
  const readonlyBar=reopened.getByRole('toolbar');
  for(const name of ['Start in Kitty…','Start','Complete','Remove to archive','Change tag…','Set reminder…']) {
    assert.equal(await readonlyBar.getByRole('button',{name,exact:true}).isDisabled(),true,`${name} must be disabled during recovery`);
  }
  for(const name of ['Copy note','Edit text…']) assert.equal(await readonlyBar.getByRole('button',{name,exact:true}).isEnabled(),true);
  assert.ok(await readonlyBar.getByRole('button',{name:'Copy note',exact:true}).evaluate(n=>n===document.activeElement));
  await reopened.keyboard.press('ArrowRight');
  assert.ok(await readonlyBar.getByRole('button',{name:'Edit text…',exact:true}).evaluate(n=>n===document.activeElement),'Arrow navigation must skip disabled actions');
  await reopened.keyboard.press('Escape');
  await readonlyActions.click();
  await writeFile(faultFile,''); await close();
  assert.equal(JSON.parse(await readFile(join(stateDir,'state.json'),'utf8')).draft,'Rapid uncertain add draft');
  reopened=await reopen();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).click();
  await selectTaskAction(reopened, added.id, 'Edit text…');
  await writeFile(faultFile,'edit');
  await reopened.evaluate(()=>{const input=document.querySelector('.cm-content[aria-label="Task text"]');input.focus();window.getSelection().selectAllChildren(input);const data=new DataTransfer();data.setData('text/plain','Rapid uncertain edit draft');input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,ctrlKey:true,bubbles:true}));});
  await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).waitFor();
  await close();
  const submitted=JSON.parse(await readFile(join(stateDir,'state.json'),'utf8'));
  assert.equal(submitted.edits[String(added.id)].text,'Rapid uncertain edit draft');
  assert.ok(!call('snapshot',{view:'active'}).notes.some(n=>n.text==='Rapid uncertain add draft'));
  assert.equal(call('snapshot',{view:'active'}).notes.find(n=>n.id===added.id).text,'Private draft before failed close — still writable; app close flushes');
  await writeFile(faultFile,''); reopened=await reopen();
  // A renderer crash cannot wait forever for a reply from the dead renderer or replay its draft.
  const crashed=app.waitForEvent('close');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await crashed; app=undefined;
  const recovered=JSON.parse(await readFile(join(stateDir,'state.json'),'utf8'));
  assert.equal(recovered.draft,'Rapid uncertain add draft'); assert.equal(recovered.edits[String(added.id)].text,'Rapid uncertain edit draft'); assert.match(recovered.warning,/previous operation may have succeeded/);
  // Hold only finish-close, after the renderer's final persistence, to expose late input deterministically.
  reopened=await reopen();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).click();
  await selectTaskAction(reopened, added.id, 'Edit text…');
  const closingText='Private editor draft frozen at final close';
  const closingEditor=reopened.locator('.cm-content[aria-label="Task text"]');
  await closingEditor.fill(closingText);
  await app.evaluate(({ipcMain})=>{
    const original=ipcMain._invokeHandlers.get('finish-close');
    if(typeof original!=='function') throw new Error('Missing finish-close IPC handler');
    ipcMain.removeHandler('finish-close');
    ipcMain.handle('finish-close',async(...args)=>{
      globalThis.__e2eFinishCloseWaiting=true;
      await new Promise(resolve=>setTimeout(resolve,1000));
      return original(...args);
    });
  });
  const frozenClose=app.waitForEvent('close');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  let finishCloseWaiting=false;
  for(let i=0;i<100;i++) {
    finishCloseWaiting=await app.evaluate(()=>globalThis.__e2eFinishCloseWaiting===true);
    if(finishCloseWaiting) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(finishCloseWaiting,'Final persistence must reach the delayed finish-close handler');
  assert.equal(await reopened.evaluate(()=>document.body.inert),true,'Closing must freeze all UI interaction');
  assert.equal(await closingEditor.evaluate(input=>input.getAttribute('aria-readonly')==='true'),true,'Closing must freeze the open editor');
  await reopened.keyboard.press('End');
  await reopened.keyboard.type(' LATE INPUT MUST NOT ENTER');
  assert.equal(await sourceValue(closingEditor),closingText,'Actual keyboard input must not change the closing draft');
  await frozenClose; app=undefined;
  assert.equal(JSON.parse(await readFile(join(stateDir,'state.json'),'utf8')).edits[String(added.id)].text,closingText);
  reopened=await reopen();
  assert.equal((await reopened.evaluate(()=>window.pinote.loadState())).edits[String(added.id)].text,closingText,'Recovered drafts stay paused on reopen and close, without automatic replay');

  // Warning metadata has its own budget: a valid near-capacity cache must survive crash recovery.
  const contentLimit=1024*1024, warningExpansionLimit=6*4096;
  const capacityState=await reopened.evaluate(()=>window.pinote.loadState());
  capacityState.draft=''; capacityState.read={}; capacityState.edits={}; capacityState.warning='';
  for(let id=1;id<=16;id++) capacityState.edits[String(id)]={text:'a'.repeat(65536),revision:'capacity-revision'};
  const targetBytes=contentLimit-16;
  const excess=Buffer.byteLength(JSON.stringify(capacityState))-targetBytes;
  assert.ok(excess>0 && excess<65536);
  capacityState.edits['16'].text=capacityState.edits['16'].text.slice(0,65536-excess);
  assert.equal(Buffer.byteLength(JSON.stringify(capacityState)),targetBytes);
  await reopened.evaluate(state=>window.pinote.saveState(state),capacityState);
  const acceptedCache=await readFile(join(stateDir,'state.json'),'utf8');
  assert.equal(Buffer.byteLength(acceptedCache),targetBytes,'Near-capacity content must be accepted');
  const overCapacity=structuredClone(capacityState);
  overCapacity.edits['16'].text+='b'.repeat(32);
  assert.ok(overCapacity.edits['16'].text.length<=65536,'Oversized case must still satisfy the per-entry bound');
  assert.ok(Buffer.byteLength(JSON.stringify(overCapacity))>contentLimit);
  await assert.rejects(()=>reopened.evaluate(state=>window.pinote.saveState(state),overCapacity));
  assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),acceptedCache,'Rejected oversized content must not alter the cache');
  const capacityCrash=app.waitForEvent('close');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await capacityCrash; app=undefined;
  const crashCache=await readFile(join(stateDir,'state.json'),'utf8');
  assert.ok(Buffer.byteLength(crashCache)>contentLimit,'Recovery warning must push this fixture past the old loader cap');
  assert.ok(Buffer.byteLength(crashCache)<=contentLimit+warningExpansionLimit,'Stored cache must respect the combined budget');
  const crashState=JSON.parse(crashCache);
  assert.deepEqual(crashState.edits,capacityState.edits);
  assert.ok(crashState.warning.length<=4096);
  assert.match(crashState.warning,/previous operation may have succeeded/);
  reopened=await reopen();
  const loadedCapacity=await reopened.evaluate(()=>window.pinote.loadState());
  assert.deepEqual(loadedCapacity.edits,capacityState.edits,'Crash recovery must preserve every near-capacity draft');
  assert.equal(loadedCapacity.warning,crashState.warning,'Load must return the actual persisted recovery warning');
  assert.doesNotMatch(loadedCapacity.warning,/cannot be read safely/);
  await reopened.screenshot({path:join(root,'capacity-recovery.png')});
  await close();

  // A rejected recovery save must not let close discard newer text in read-only mode.
  reopened=await reopen();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).click();
  await reopened.waitForFunction(()=>document.querySelector('#draft').getAttribute('aria-readonly')==='false');
  const tinyDraft='x', newerDraft='Newer unsaved draft: '+'z'.repeat(4096);
  const newerCapacity=structuredClone(capacityState);
  newerCapacity.draft=newerDraft;
  assert.ok(newerDraft.length<=65536,'Newer text must satisfy the per-draft bound');
  assert.ok(Buffer.byteLength(JSON.stringify(newerCapacity))>contentLimit,'Newer text must exceed the aggregate content budget');
  await writeFile(faultFile,'slow-add');
  const capacityComposer=reopened.getByRole('textbox',{name:'Add a task…',exact:true});
  await capacityComposer.fill(tinyDraft);
  await capacityComposer.press('Enter');
  let addDispatched=false;
  for(let i=0;i<200;i++) {
    try { addDispatched=await readFile(slowAddMarker,'utf8')==='dispatched'; } catch(error) { if(error.code!=='ENOENT') throw error; }
    if(addDispatched) break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(addDispatched,'Tiny valid draft must flush and dispatch before newer input');
  assert.equal(await capacityComposer.evaluate(input=>input.getAttribute('aria-readonly')==='true'),false,'Delayed add must still be pending when newer input arrives');
  await capacityComposer.fill(newerDraft);
  // An unrelated editor opened during the pending add must freeze immediately on recovery.
  await selectTaskAction(reopened, added.id, 'Edit text…');
  const recoveryEditor=reopened.locator('.cm-content[aria-label="Task text"]');
  const recoveryText=await sourceValue(recoveryEditor);
  await reopened.waitForFunction(()=>document.querySelector('#draft').getAttribute('aria-readonly')==='true');
  assert.equal(await recoveryEditor.evaluate(input=>input.getAttribute('aria-readonly')==='true'),true,'Unknown outcome must freeze already-open editors');
  await reopened.keyboard.type(' MUST NOT BE ACCEPTED');
  assert.equal(await sourceValue(recoveryEditor),recoveryText);
  await reopened.getByText(/Draft cache could not be saved:/).waitFor();
  assert.equal(await sourceValue(capacityComposer),newerDraft,'Unknown outcome must retain the newer draft');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await reopened.getByText(/Could not finish closing:/).waitFor();
  assert.equal(app.process().exitCode,null,'Rejected read-only recovery save must keep the app alive');
  assert.equal(reopened.isClosed(),false,'Rejected read-only recovery save must keep the window open');
  assert.equal(await reopened.evaluate(()=>document.body.inert),false,'Failed recovery close must restore interaction');
  assert.equal(await sourceValue(capacityComposer),newerDraft,'Failed recovery close must preserve newer text');
  assert.equal(await capacityComposer.evaluate(input=>input.getAttribute('aria-readonly')==='true'),true,'Unknown outcome must still require explicit acknowledgement');
  await reopened.getByRole('button',{name:'I checked saved tasks; enable writes',exact:true}).click();
  await reopened.waitForFunction(()=>document.querySelector('#draft').getAttribute('aria-readonly')==='false');
  assert.equal(await recoveryEditor.evaluate(input=>input.getAttribute('aria-readonly')==='true'),false,'Acknowledgement must immediately restore eligible editors');
  await reopened.keyboard.press('Escape');
  await capacityComposer.fill('');
  await writeFile(faultFile,'');
  await close();
  assert.equal(JSON.parse(await readFile(join(stateDir,'state.json'),'utf8')).draft,'','Reducing the draft to fit must allow a successful close');
  // A renderer failure must retain state adopted by main even when its disk save failed.
  reopened=await reopen();
  const failedSaveDraft='New draft retained after renderer failure';
  const failedSaveState=await reopened.evaluate(()=>window.pinote.loadState());
  failedSaveState.edits={}; failedSaveState.draft=failedSaveDraft;
  assert.ok(Buffer.byteLength(JSON.stringify(failedSaveState))<contentLimit);
  const beforeFailedSave=await readFile(join(stateDir,'state.json'),'utf8');
  await app.evaluate(({dialog})=>{
    globalThis.__e2eRecoveryPromptCount=0;
    dialog.showMessageBox=(_window,options)=>{
      globalThis.__e2eRecoveryPromptOptions=options;
      globalThis.__e2eRecoveryPromptCount++;
      return new Promise(resolve=>{globalThis.__e2eRecoveryPromptResolve=resolve;});
    };
  });
  await chmod(stateDir,0o500);
  await assert.rejects(()=>reopened.evaluate(state=>window.pinote.saveState(state),failedSaveState));
  assert.equal((await reopened.evaluate(()=>window.pinote.loadState())).draft,failedSaveDraft,'Main must adopt valid state before the disk save fails');
  assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),beforeFailedSave);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  const waitForRecoveryPrompt=async count=>{
    let reached=false;
    for(let i=0;i<600;i++) {
      reached=await app.evaluate((_electron,expected)=>globalThis.__e2eRecoveryPromptCount>=expected,count);
      if(reached) break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(reached,`Native recovery prompt ${count} must appear`);
  };
  await waitForRecoveryPrompt(1);
  assert.equal(app.process().exitCode,null,'Failed crash recovery save must keep main alive');
  assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),beforeFailedSave,'Failed crash recovery must not change disk state');
  const recoveryOptions=await app.evaluate(()=>globalThis.__e2eRecoveryPromptOptions);
  assert.deepEqual(recoveryOptions.buttons,['Retry saving','Copy recovered state','Quit without saving']);
  assert.equal(recoveryOptions.defaultId,0);
  assert.equal(recoveryOptions.cancelId,0);
  await app.evaluate(()=>globalThis.__e2eRecoveryPromptResolve({response:1,checkboxChecked:false}));
  await waitForRecoveryPrompt(2);
  const copiedRecovery=JSON.parse(await app.evaluate(({clipboard})=>clipboard.readText()));
  assert.equal(copiedRecovery.draft,failedSaveDraft);
  assert.match(copiedRecovery.warning,/previous operation may have succeeded/);
  assert.equal(app.process().exitCode,null,'Copying recovered state must return to the prompt, not quit');
  assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),beforeFailedSave);
  await chmod(stateDir,0o700);
  const recoveryClosed=app.waitForEvent('close');
  const recoveryExited=new Promise(resolve=>app.process().once('exit',resolve));
  await app.evaluate(()=>globalThis.__e2eRecoveryPromptResolve({response:0,checkboxChecked:false}));
  await Promise.all([recoveryClosed,recoveryExited]); app=undefined;
  const retriedRecovery=JSON.parse(await readFile(join(stateDir,'state.json'),'utf8'));
  assert.equal(retriedRecovery.draft,failedSaveDraft);
  assert.equal(retriedRecovery.warning,copiedRecovery.warning);
  reopened=await reopen();
  const loadedRecovery=await reopened.evaluate(()=>window.pinote.loadState());
  assert.equal(loadedRecovery.draft,failedSaveDraft,'Reopen must recover the exact draft adopted before the failed save');
  assert.equal(loadedRecovery.warning,retriedRecovery.warning);
  assert.doesNotMatch(loadedRecovery.warning,/cannot be read safely/);
  await close();
  // Unreadable drafts are protected, but best-effort geometry must not trap recovery on close.
  await writeFile(join(stateDir,'state.json'),'corrupt draft JSON — preserve me');
  await chmod(stateDir,0o500);
  try {
    reopened=await reopen();
    await reopened.getByText(/Electron state\/drafts cannot be read safely/).first().waitFor();
    await reopened.waitForTimeout(350);
    await close();
    assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),'corrupt draft JSON — preserve me');
  } finally { await chmod(stateDir,0o700); }
  console.log(`Electron UI validation artifacts: ${root}`);
} catch(error) { console.error(logs.join('\n')); if(app) { try { await (await app.firstWindow()).screenshot({path:join(root,'failure.png')}); }catch{} } console.error(`Failure artifacts: ${root}`); throw error; }
finally {
  if(app) {
    // A held native recovery prompt must not deadlock cleanup after an assertion fails.
    await app.evaluate(({dialog})=>{
      if(globalThis.__e2eRecoveryPromptCount===undefined) return;
      dialog.showMessageBox=async()=>({response:2,checkboxChecked:false});
      globalThis.__e2eRecoveryPromptResolve?.({response:2,checkboxChecked:false});
    }).catch(()=>{});
    await app.close().catch(()=>{});
  }
  await client?.close().catch(()=>{}); await service?.close().catch(()=>{}); gtk?.kill('SIGTERM'); wm?.kill('SIGTERM');
}
