// Pasted images in the running desktop: real clipboard paste, conversion, preview, Backspace deletion and pruning.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright';

assert.match(process.env.XAUTHORITY || '', /xvfb-run\./, 'Use xvfb-run with a private dbus-run-session');
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'), 'Use a private D-Bus session');
const root = await mkdtemp(join(tmpdir(), 'pinote-images-e2e-'));
const env = { ...process.env, PINOTE_BRIDGE_COMMAND: resolve('../backend/bin/pinote-electron-backend'), PINOTE_NOTE_COMMAND: resolve('../backend/bin/note'),
  HOME: join(root,'home'), XDG_DATA_HOME: join(root,'data'), XDG_STATE_HOME: join(root,'state'), XDG_CONFIG_HOME: join(root,'config'), XDG_CACHE_HOME: join(root,'cache'),
  XDG_RUNTIME_DIR: join(root,'runtime'), PI_CODING_AGENT_DIR: join(root,'pi-agent'), NO_AT_BRIDGE:'1', GIO_USE_VFS:'local', GSETTINGS_BACKEND:'memory' };
for (const name of ['WAYLAND_DISPLAY','I3SOCK','SWAYSOCK','KITTY_LISTEN_ON','KITTY_WINDOW_ID','ELECTRON_RUN_AS_NODE']) delete env[name];
for (const name of ['HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','PI_CODING_AGENT_DIR']) await mkdir(env[name], {recursive:true,mode:0o700});
const call = (operation, params) => {
  const run = spawnSync(env.PINOTE_BRIDGE_COMMAND, [], { env, input: JSON.stringify({ protocol:1, operation, params }), encoding:'utf8' });
  const response = JSON.parse(run.stdout); assert.ok(response.ok, run.stdout); return response.result;
};
const images = () => {
  const db = new DatabaseSync(join(env.XDG_DATA_HOME,'pinote','notes.db'), { readOnly:true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE name='images'").get() ? db.prepare('SELECT hash,mime,width,height,length(bytes) AS size FROM images ORDER BY created_at').all() : []; } finally { db.close(); }
};
const until = async (check, text) => { for (let i=0;i<150;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,100)); } assert.fail(text); };

// An image left by an interrupted paste: nothing references it, so start-up removes it.
const orphan = call('image_add', { data: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64').toString('base64') }).hash;
const missing = call('add', { text:`Old screenshot\n![image](pinote:sha256-${'0'.repeat(64)})`, tag:null }).id;
for (const text of ['Review the release notes','Update the README screenshots','Check the nightly backup','Reply to the design review','Plan the next sprint']) call('add', { text, tag:null });

let wm, app; const errors = [];
try {
  const socket = join(root,'i3.sock'), config = join(root,'i3.conf');
  await writeFile(config,`font pango:monospace 9\nipc-socket ${socket}\nfor_window [class="^pinote-electron$"] floating enable, border none\n`);
  wm = spawn('i3',['-a','-c',config],{env,stdio:'ignore'});
  for (let i=0;i<100;i++) { if (spawnSync('i3-msg',['-s',socket,'-t','get_tree'],{env,stdio:'ignore'}).status===0) break; await new Promise(r=>setTimeout(r,30)); }
  env.I3SOCK = socket;
  app = await _electron.launch({ executablePath:createRequire(import.meta.url)('electron'), args:['--class=pinote-electron',resolve('dist/main.cjs')], env, chromiumSandbox:true, timeout:20000 });
  const page = await app.firstWindow();
  page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('.task-row').first().waitFor();
  await until(() => !images().some(i => i.hash===orphan), 'Start-up prunes an unreferenced image');

  // A wide screenshot, copied to the real clipboard as a screenshot tool does.
  const screenshot = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(3200,1600), g = canvas.getContext('2d');
    g.fillStyle = '#f4f6fb'; g.fillRect(0,0,3200,1600);
    g.fillStyle = '#3b6fd8'; g.fillRect(0,0,3200,180);
    g.fillStyle = '#ffffff'; g.font = 'bold 96px sans-serif'; g.fillText('Build failed: 3 tests', 80, 125);
    g.fillStyle = '#d94848'; g.fillRect(80,300,1400,120); g.fillStyle = '#2b9348'; g.fillRect(80,480,2100,120); g.fillStyle = '#e0a526'; g.fillRect(80,660,900,120);
    g.fillStyle = '#222'; g.font = '72px monospace'; for (let i=0;i<6;i++) g.fillText(`error TS2345 at src/main.ts:${200+i}`, 80, 950+i*100);
    const blob = await canvas.convertToBlob({ type:'image/png' });
    return `data:image/png;base64,${btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), b => String.fromCharCode(b)).join(''))}`;
  });
  const copy = () => app.evaluate(({clipboard,ClipboardItem},url) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(url.slice(url.indexOf(',')+1),'base64')],{type:'image/png'}) })]), screenshot);
  const composer = page.locator('#draft-host .cm-content');
  await copy();
  await composer.click(); await page.keyboard.type('Fix the failing build');
  await page.keyboard.press('Control+V');
  const thumbnail = page.locator('#draft-host img.cm-image');
  await thumbnail.waitFor();
  await until(() => thumbnail.evaluate(image => image.complete && image.naturalWidth > 0), 'The composer shows the pasted image');
  const [stored] = images();
  assert.deepEqual({ mime:stored.mime, width:stored.width, height:stored.height }, { mime:'image/webp', width:2560, height:1280 }, 'Large screenshots become 2560-pixel WebP');
  assert.ok(stored.size < 512 * 1024, `Converted screenshot is small (${stored.size} bytes)`);
  console.log(`Pasted ${Math.round(screenshot.length * 3 / 4 / 1024)} KiB PNG (3200×1600), stored ${Math.round(stored.size / 1024)} KiB WebP (2560×1280)`);
  await page.screenshot({ path:join(root,'composer.png') });
  await page.keyboard.press('Enter');
  await page.getByText('Fix the failing build',{exact:true}).waitFor();
  const task = call('snapshot',{view:'active'}).notes.find(n => n.text.startsWith('Fix the failing build'));
  assert.equal(task.text, `Fix the failing build\n![image](pinote:sha256-${stored.hash})`);
  assert.equal(images().length, 1, 'The submitted task keeps its image');

  // The preview loads the stored image and sizes itself for it.
  const opened = app.waitForEvent('window');
  await page.locator(`[data-id="${task.id}"]`).getByRole('button',{name:'Preview full task',exact:true}).click();
  const preview = await opened; await preview.waitForURL('pinote-app://ui/preview.html');
  const shown = preview.locator('#body img.note-image');
  await shown.waitFor();
  await until(() => shown.evaluate(image => image.complete && image.naturalWidth === 2560), 'The preview shows the stored image');
  await preview.screenshot({ path:join(root,'preview.png') });
  const closed = preview.waitForEvent('close'); await preview.keyboard.press('Escape').catch(() => {}); await closed;

  // Backspace deletes the whole image; undo restores it while the editor is open; closing prunes it.
  await page.getByRole('button',{name:`Actions for task ${task.id}`,exact:true}).click();
  await page.getByRole('toolbar',{name:new RegExp(`^Actions for task ${task.id}:`)}).getByRole('button',{name:'Edit text…',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:`Edit task ${task.id}`,exact:true});
  const editorImage = dialog.locator('img.cm-image');
  await until(() => editorImage.evaluate(image => image.complete && image.naturalWidth > 0).catch(() => false), 'The editor shows the image');
  await page.screenshot({ path:join(root,'editor.png') });
  const text = () => call('snapshot',{view:'active'}).notes.find(n => n.id === task.id).text;
  await dialog.getByRole('textbox',{name:'Task text',exact:true}).click(); await page.keyboard.press('Control+End');
  await page.keyboard.press('Backspace');
  await until(() => text() === 'Fix the failing build', 'One Backspace deletes the image reference');
  assert.equal(await editorImage.count(), 0);
  assert.equal(images().length, 1, 'An open editor keeps a deleted image for undo');
  await page.keyboard.press('Control+z');
  await until(() => text() === task.text, 'Undo restores the image');
  await until(() => editorImage.evaluate(image => image.naturalWidth > 0).catch(() => false), 'The restored image shows');
  await page.keyboard.press('Backspace');
  await until(() => text() === 'Fix the failing build', 'Backspace deletes it again');
  await dialog.getByText('All changes saved',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await until(() => images().length === 0, 'Closing the editor deletes the unused image');

  // In the composer, a deleted image is pruned once the composer loses focus.
  await copy(); await composer.click(); await page.keyboard.press('Control+V');
  await thumbnail.waitFor(); await until(() => images().length === 1, 'The pasted image is stored');
  await page.keyboard.press('Backspace');
  assert.equal(await thumbnail.count(), 0);
  await page.locator(`[data-id="${task.id}"]`).getByRole('button',{name:'Preview full task',exact:true}).focus();
  await until(() => images().length === 0, 'Leaving the composer deletes the unused image');
  // A reference to a deleted image shows a placeholder.
  const openedMissing = app.waitForEvent('window');
  await page.locator(`[data-id="${missing}"]`).getByRole('button',{name:'Preview full task',exact:true}).click();
  const missingPreview = await openedMissing; await missingPreview.waitForURL('pinote-app://ui/preview.html');
  await missingPreview.locator('#body .image-missing').getByText('Image unavailable',{exact:true}).waitFor();
  await missingPreview.screenshot({ path:join(root,'missing.png') });
  const missingClosed = missingPreview.waitForEvent('close'); await missingPreview.keyboard.press('Escape').catch(() => {}); await missingClosed;
  assert.deepEqual(errors, []);
  console.log(`Image validation screenshots: ${root}`);
} catch (error) { console.error(`Failure artifacts: ${root}`); throw error; }
finally { await app?.close().catch(() => {}); wm?.kill('SIGTERM'); }
