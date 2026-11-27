// Fields settings and typed fields in the running desktop: types, list entries saved as arrays, preview chips.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

assert.match(process.env.XAUTHORITY || '', /xvfb-run\./, 'Use xvfb-run with a private dbus-run-session');
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'), 'Use a private D-Bus session');
const root = await mkdtemp(join(tmpdir(), 'pinote-fields-e2e-'));
const env = { ...process.env, PINOTE_BRIDGE_COMMAND: resolve('../backend/bin/pinote-electron-backend'), PINOTE_NOTE_COMMAND: resolve('../backend/bin/note'),
  HOME: join(root,'home'), XDG_DATA_HOME: join(root,'data'), XDG_STATE_HOME: join(root,'state'), XDG_CONFIG_HOME: join(root,'config'), XDG_CACHE_HOME: join(root,'cache'),
  XDG_RUNTIME_DIR: join(root,'runtime'), PI_CODING_AGENT_DIR: join(root,'pi-agent'), NO_AT_BRIDGE:'1', GIO_USE_VFS:'local', GSETTINGS_BACKEND:'memory' };
for (const name of ['WAYLAND_DISPLAY','I3SOCK','SWAYSOCK','KITTY_LISTEN_ON','KITTY_WINDOW_ID','ELECTRON_RUN_AS_NODE']) delete env[name];
for (const name of ['HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','PI_CODING_AGENT_DIR']) await mkdir(env[name], {recursive:true,mode:0o700});
// A fixed size: the saved geometry disables the content-height fit.
await mkdir(join(env.XDG_DATA_HOME,'pinote/electron'),{recursive:true,mode:0o700});
await writeFile(join(env.XDG_DATA_HOME,'pinote/electron/window.json'),JSON.stringify({width:760,height:640}));
const settingsFile = join(env.PI_CODING_AGENT_DIR,'pi-note.json');
const saved = async () => JSON.parse(await readFile(settingsFile,'utf8'));
const note = (...args) => JSON.parse(execFileSync(env.PINOTE_NOTE_COMMAND,['--no-notify',...args],{env,encoding:'utf8'}));
const until = async (check, text) => { for (let i=0;i<100;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,100)); } assert.fail(text); };

await writeFile(settingsFile, JSON.stringify({ handoffPrompt:'Keep me', footer:{ fields:[{name:'Notes'},{name:'Links',type:'list'},{name:'PRs'}] } }));
// Text saved before PRs was a list: one URL per line.
const pulls = [1,2,3].map(number => `https://github.com/owner/repo/pull/${number}`);
let task = note('agent','add','--text=Typed fields');
task = note('agent','update',String(task.id),'--expected-updated-at',task.updated_at,'--set-json',JSON.stringify({ PRs:`${pulls[0]}\n${pulls[1]}`, Notes:'Free **text**' }));
const notes = () => note('agent','get',String(task.id)).agent_notes;

let app; const errors = [];
try {
  app = await _electron.launch({ executablePath:createRequire(import.meta.url)('electron'), args:['--class=pinote-electron',resolve('dist/main.cjs')], env, chromiumSandbox:true, timeout:20000 });
  const page = await app.firstWindow();
  page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('#draft[aria-readonly="false"]').waitFor();
  await page.getByRole('button',{name:'Settings',exact:true}).click(); await page.getByRole('tab',{name:'Fields',exact:true}).click();
  const dialog = page.locator('#settings-pane-fields'), list = dialog.getByRole('group',{name:'Fields',exact:true});
  const save = dialog.getByRole('button',{name:'Save field settings',exact:true}), status = dialog.getByRole('status');
  const saveAll = async () => { await save.click(); await status.getByText('Saved.',{exact:true}).waitFor(); };
  const type = dialog.getByRole('combobox',{name:'Type',exact:true});
  const resize = async width => {
    for (let stable=0; stable<2;) {
      if (await page.evaluate(()=>innerWidth)===width) stable++;
      else { stable=0; await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,640),width); }
      await new Promise(r=>setTimeout(r,250));
    }
  };
  const capture = async name => {
    assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true,`No horizontal overflow in ${name}`);
    const box = await save.boundingBox(), height = await page.evaluate(()=>innerHeight);
    assert.ok(box.y>=0 && box.y+box.height<=height,'Save stays visible');
    await page.screenshot({path:join(root,`${name}.png`)});
  };

  // Definitions with their effective types; unsaved presets follow the saved ones.
  await list.getByRole('button',{name:/^Notes: text, enabled$/}).waitFor();
  assert.deepEqual(await list.getByRole('button').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),
    ['Notes: text, enabled','Links: list, enabled','PRs: unique list, enabled','Worktrees: unique list, disabled, preset','Pi footer layout']);
  assert.equal(await save.isDisabled(),true,'Nothing to save before a change');
  await capture('fields-760');
  await list.getByRole('button',{name:/^Links:/}).click();
  assert.equal(await type.inputValue(),'list');
  await type.selectOption('unique-list');
  await status.getByText('Unsaved changes.',{exact:true}).waitFor();
  await list.getByRole('button',{name:'Links: unique list, enabled',exact:true}).waitFor();
  await saveAll();
  assert.deepEqual(await saved(),{ handoffPrompt:'Keep me', footer:{ titleWidth:60, fieldWidth:60, maxFields:4, fields:[
    { name:'Notes', label:'Notes', link:true, format:'<value>', type:'text', enabled:true, instructions:'' },
    { name:'Links', label:'Links', link:true, format:'<value>', type:'unique-list', enabled:true, instructions:'' },
    { name:'PRs', label:'PRs', link:true, format:'#<number>', type:'unique-list', enabled:true, instructions:(await saved()).footer.fields[2].instructions }] } },
    'Only the footer changes, and the unchanged preset stays out of the file');
  assert.match((await saved()).footer.fields[2].instructions,/Forgejo PR URL/);

  // A new field, an invalid one, and the footer layout.
  const newName = dialog.getByRole('textbox',{name:'New field name',exact:true});
  await newName.fill('Links'); await newName.press('Enter');
  await status.getByText('Links already exists.',{exact:true}).waitFor();
  await newName.fill('Owner'); await newName.press('Enter');
  await list.getByRole('button',{name:'Owner: text, enabled',exact:true}).waitFor();
  await type.selectOption('list');
  await dialog.getByRole('textbox',{name:'Format',exact:true}).fill('<owner>');
  await status.getByText('Owner: the format supports only <value>, <number> and <url>.',{exact:true}).waitFor();
  assert.equal(await save.isDisabled(),true,'An invalid format cannot be saved');
  await dialog.getByRole('textbox',{name:'Format',exact:true}).fill('@<value>');
  await dialog.getByRole('button',{name:'Move Owner up',exact:true}).click();
  await list.getByRole('button',{name:'Pi footer layout',exact:true}).click();
  await dialog.getByRole('spinbutton',{name:'Max fields',exact:true}).fill('6');
  await dialog.getByRole('checkbox',{name:'Custom bar order',exact:true}).check();
  const bar = dialog.getByRole('group',{name:'Bar order',exact:true});
  await bar.getByRole('button',{name:'Hide Notes from the bar',exact:true}).click();
  await bar.getByRole('button',{name:'Move PRs up',exact:true}).click();
  await capture('fields-layout-760');
  await saveAll();
  const footer = (await saved()).footer;
  assert.deepEqual([footer.maxFields,footer.bar,footer.fields.map(field=>[field.name,field.type,field.format])],
    [6,['Links','PRs','Owner'],[['Notes','text','<value>'],['Links','unique-list','<value>'],['Owner','list','@<value>'],['PRs','unique-list','#<number>']]]);
  await list.getByRole('button',{name:/^Owner:/}).click();
  await resize(420); await capture('fields-420');
  await resize(760);
  // Another program changed the file: a stale save is refused, not merged.
  await type.selectOption('text');
  await writeFile(settingsFile,JSON.stringify({ ...(await saved()), handoffPrompt:'Changed elsewhere' }));
  await save.click();
  await status.getByText(/changed while settings were open/).waitFor();
  assert.equal((await saved()).footer.fields[2].type,'list','The stale change is not written');
  // The refused change is still unsaved: leaving asks first.
  assert.equal(await page.locator('#settings-tab-fields').getAttribute('aria-label'),'Fields, unsaved changes');
  await page.keyboard.press('Escape'); await page.getByRole('dialog',{name:'Discard changes?',exact:true}).getByRole('button',{name:'Confirm',exact:true}).click(); await dialog.waitFor({state:'detached'});

  // Before any edit the value is still text; the preview already shows it as the list its type says.
  const openPreview = async () => {
    const opened = app.waitForEvent('window');
    await page.locator(`[data-id="${task.id}"]`).getByRole('button',{name:/^(Preview full task|Unread agent update — click to view\.)$/}).click();
    const preview = await opened;
    await preview.waitForURL('pinote-app://ui/preview.html');
    await preview.locator('.field-chips').first().waitFor();
    return preview;
  };
  const chips = preview => preview.locator('.agent h4:text-is("PRs") + .field-chips');
  {
    const preview = await openPreview(), closed = preview.waitForEvent('close');
    assert.deepEqual(await chips(preview).locator('li').allTextContents(),['#1','#2']);
    await preview.keyboard.press('Escape').catch(error => { if (!preview.isClosed()) throw error; });
    await closed;
  }
  // The task editor: a list is one entry per row and saves as an array.
  await page.getByRole('button',{name:`Actions for task ${task.id}`,exact:true}).click();
  await page.getByRole('toolbar',{name:new RegExp(`^Actions for task ${task.id}:`)}).getByRole('button',{name:'Edit text…',exact:true}).click();
  const editor = page.getByRole('dialog',{name:`Edit task ${task.id}`,exact:true});
  const allSaved = () => editor.getByText('All changes saved',{exact:true}).waitFor();
  const group = name => editor.getByRole('group',{name:`Agent field ${name}`,exact:true});
  const entries = name => group(name).locator('.field-item:not(.field-add) input').evaluateAll(nodes=>nodes.map(node=>node.value));
  const add = async (name, value) => { const input = group(name).getByRole('textbox',{name:`Add ${name} entry`,exact:true}); await input.fill(value); await input.press('Enter'); };
  await group('PRs').waitFor();
  assert.deepEqual(await entries('PRs'),pulls.slice(0,2),'Saved lines become entries');
  assert.equal(await editor.getByRole('textbox',{name:'Agent field Notes',exact:true}).inputValue(),'Free **text**','A text field stays one value');
  assert.deepEqual(notes().PRs,`${pulls[0]}\n${pulls[1]}`,'Opening the editor rewrites nothing');
  await add('PRs',pulls[1]);
  await group('PRs').getByRole('status').getByText(`Already in this list: ${pulls[1]}`,{exact:true}).waitFor();
  assert.deepEqual(await entries('PRs'),pulls.slice(0,2),'A unique list refuses a repeat');
  await add('PRs',pulls[2]);
  await until(() => Array.isArray(notes().PRs) && notes().PRs.length === 3,'The list saves as an array');
  await allSaved();
  assert.deepEqual(notes(),{ Notes:'Free **text**', PRs:pulls });
  // Editing an entry into a repeat keeps the entry: nothing is saved over it.
  const second = group('PRs').getByRole('textbox',{name:'PRs entry 2',exact:true});
  await second.fill(''); await second.pressSequentially(pulls[0]);
  await group('PRs').getByRole('status').getByText(`Already in this list: ${pulls[0]}`,{exact:true}).waitFor();
  await second.blur();
  assert.deepEqual(await entries('PRs'),pulls,'The entry returns to its value');
  await page.waitForTimeout(900);
  assert.deepEqual(notes().PRs,pulls,'A repeat deletes nothing');
  // Several pasted lines are several entries.
  await group('Owner').getByRole('textbox',{name:'Add Owner entry',exact:true}).evaluate(input => {
    // The selection is replaced, as a paste does.
    input.value = 'old'; input.select();
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain','ana\nana');
    input.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
  });
  await add('Links','https://example.test/a'); await add('Links','https://example.test/a');
  await until(() => notes().Owner?.length === 2 && notes().Links?.length === 1,'A list keeps repeats; a unique list does not');
  await allSaved();
  await group('PRs').getByRole('button',{name:'Remove PRs entry 1',exact:true}).click();
  await until(() => notes().PRs.length === 2,'Removing an entry saves');
  await allSaved();
  assert.deepEqual(notes(),{ Links:['https://example.test/a'], Notes:'Free **text**', Owner:['ana','ana'], PRs:pulls.slice(1) });
  assert.equal(await editor.evaluate(node=>node.scrollWidth<=node.clientWidth),true,'The editor does not clip horizontally');
  await page.screenshot({path:join(root,'editor-typed-fields.png')});
  await group('Owner').getByRole('button',{name:'Remove Owner entry 2',exact:true}).click();
  await group('Owner').getByRole('button',{name:'Remove Owner entry 1',exact:true}).click();
  await until(() => !Object.hasOwn(notes(),'Owner'),'An emptied list removes its field');
  await allSaved();
  await page.keyboard.press('Escape'); await editor.waitFor({state:'detached'});

  // The preview shows list entries as chips in the field's format, linked.
  const preview = await openPreview();
  assert.deepEqual((await preview.locator('.agent h4').allTextContents()).sort(),['Links','Notes','PRs']);
  assert.deepEqual(await chips(preview).locator('li').allTextContents(),['#2','#3']);
  assert.deepEqual(await chips(preview).locator('a').evaluateAll(nodes=>nodes.map(node=>node.href)),pulls.slice(1));
  assert.equal(await preview.locator('.agent strong').textContent(),'text','Text fields stay Markdown');
  await preview.screenshot({path:join(root,'preview-chips.png')});
  assert.deepEqual(errors,[]);
  console.log(process.env.PINOTE_E2E_KEEP ? `Fields e2e passed; screenshots in ${root}` : 'Fields e2e passed');
} catch (error) {
  console.error(`Fields e2e failed; artifacts in ${root}`);
  throw error;
} finally {
  await app?.close().catch(()=>{});
  if (!process.env.PINOTE_E2E_KEEP) await rm(root,{recursive:true,force:true});
}
