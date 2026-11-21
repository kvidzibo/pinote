import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, screen, session, shell } from 'electron';
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Backend } from './backend.ts';
import { backendCommand } from './backend-command.ts';
import { hasInstalledLauncher, hasBackendPreference, preferredBackendEnvironment, processEnvironment, recoverBackendSwitch, runCommand, switchToNode, verifySwitchPaths } from './backend-switch.ts';
import { previewWindow } from './preview-window.ts';
import { getAgentDir } from '../../pi/config-path.js';
import { initialState } from './protocol.ts';
import type { MenuAction, MenuRequest } from './protocol.ts';
import { MAX_STATE_FILE_BYTES, agentFieldNames, mutating, safeLink, validMenuRequest, validParams, validState } from './security.ts';

protocol.registerSchemesAsPrivileged([{ scheme: 'pinote-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
app.setName('pinote-electron');
app.commandLine.appendSwitch('class', 'pinote-electron');
const origin = 'pinote-app://ui';
const xdg = (name: string, fallback: string) => process.env[name] && isAbsolute(process.env[name]!) ? process.env[name]! : join(homedir(), fallback);
let window: BrowserWindow | undefined;
let activeMenu: Menu | undefined;
let state = initialState();
let dataDir = ''; let logFile = ''; let readonly = false;
let uncertain = false; let closing = false; let exiting = false;
let watchers: Promise<{ close(): Promise<void> } | undefined> | undefined;
let watchersStop: Promise<void> | undefined; let watchersStopped = false;
// Bounded and never rejects: quitting must not hang on a watcher.
const stopWatchers = () => watchersStop ??= Promise.race([
  Promise.resolve(watchers).then(started => started?.close()).catch(() => log('Pinote field watchers did not stop cleanly.')),
  new Promise<void>(done => setTimeout(done, 5000)),
]).then(() => { watchersStopped = true; });
let stateWrites = Promise.resolve(); let geometryWrites = Promise.resolve(); let tasks = Promise.resolve();
let manualSize = false; let changingSize = false; let geometryReady = false; let collapsed = false; let fullSize = { width: 420, height: 360 };
const warning = 'A previous operation may have succeeded without confirmation. Check saved tasks or any new Kitty tab before retrying; drafts were preserved.';
const log = (message: string) => {
  console.log(message);
  try {
    if (!logFile) verifySwitchPaths(process.env, ['HOME', 'XDG_STATE_HOME']);
    const path = logFile || join(xdg('XDG_STATE_HOME', '.local/state'), 'pinote', 'electron', 'app.log');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch { console.log('Cannot write Electron diagnostics.'); }
};

async function atomic(path: string, content: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(content), { mode: 0o600 });
  await rename(temp, path);
}
function persist() {
  const snapshot = structuredClone(state);
  if (uncertain) snapshot.warning = warning;
  stateWrites = stateWrites.catch(() => {}).then(() => {
    if (!validState(snapshot) || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_STATE_FILE_BYTES) throw new Error('Draft state exceeds its storage limit');
    return atomic(join(dataDir, 'state.json'), snapshot);
  });
  return stateWrites;
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.origin !== origin) throw new Error('Untrusted IPC sender');
}
function bounds() {
  return screen.getDisplayNearestPoint(window ? { x: window.getBounds().x, y: window.getBounds().y } : { x: 25, y: 1300 }).workArea;
}
function resize(width: number, height: number, anchored = true) {
  if (!window) return;
  const area = bounds(); const old = window.getBounds();
  const w = Math.max(280, Math.min(Math.round(width), area.width));
  const h = Math.max(120, Math.min(Math.round(height), area.height));
  const x = Math.max(area.x, Math.min(old.x, area.x + area.width - w));
  const y = Math.max(area.y, Math.min(anchored ? old.y + old.height - h : old.y, area.y + area.height - h));
  changingSize = true; window.setBounds({ x, y, width: w, height: h });
  setTimeout(() => { changingSize = false; }, 150);
}

function saveGeometry() {
  if (!window || !geometryReady) return;
  const current = window.getBounds();
  fullSize = { width: current.width, height: collapsed ? fullSize.height : current.height };
  const geometry = { ...fullSize, x: current.x, y: current.y, manualSize };
  // Geometry is best-effort; it must not poison draft writes or trap a read-only window.
  geometryWrites = geometryWrites.then(() => atomic(join(dataDir, 'window.json'), geometry))
    .catch(() => log('Cannot save Electron window geometry.'));
  return geometryWrites;
}

function popupMenu(request: MenuRequest, showBackend: boolean): Promise<MenuAction | null> {
  if (!window || closing || activeMenu) return Promise.resolve(null);
  const owner = window;
  return new Promise(resolve => {
    let selected: MenuAction | null = null;
    // Native menus cannot load SVG: icons/menu holds 16/32 px PNG copies in a grey readable on light and dark menus.
    const item = (id: MenuAction, label: string, icon: string): Electron.MenuItemConstructorOptions => ({ id, label,
      icon: nativeImage.createFromPath(join(__dirname, 'icons', 'menu', `${icon}-symbolic.png`)), click: () => { selected = id; } });
    const separator: Electron.MenuItemConstructorOptions = { type: 'separator' };
    const menu = Menu.buildFromTemplate([
      item('scheduled', 'Scheduled reminders', 'preferences-system-notifications'), item('archive', 'Archive', 'archive'), separator,
      item('manage-tags', 'Manage tags…', 'tag'), item('task-actions', 'Task actions…', 'open-menu'), item('composer-settings', 'New task editor…', 'list-add'), item('watchers', 'Watchers…', 'view-reveal'),
      ...showBackend ? [item('backend-settings', 'Switch to Node backend…', 'utilities-terminal')] : [], separator,
      item('drafts', 'Recover edit drafts…', 'document-revert'), separator, item('close', 'Quit Pinote', 'window-close'),
    ]);
    const content = owner.getContentBounds();
    activeMenu = menu;
    menu.popup({ window: owner,
      // With an owning window, Electron interprets these as content-relative DIPs.
      x: Math.min(request.x, content.width - 1),
      y: Math.min(request.y, content.height - 1),
      callback: () => { if (activeMenu === menu) activeMenu = undefined; resolve(selected); },
    });
  });
}

async function boot() {
  // Before respawning the backend, ensure our inherited profile paths were not
  // already lossily decoded by Node. Do not log to an unverified profile.
  try { await processEnvironment(process.pid); }
  catch { console.error('Cannot verify Pinote startup paths as UTF-8.'); app.exit(1); return; }
  const bundles = join(app.isPackaged ? process.resourcesPath : __dirname, 'pinote-backend');
  const bundle = join(bundles, 'bridge.mjs');
  const switchRuntime = () => ({ bundles, node: backendCommand(bundle, { ...process.env, PINOTE_ELECTRON_BACKEND: undefined }).executable });
  await recoverBackendSwitch(process.env);
  const environment = await preferredBackendEnvironment(process.env);
  const command = backendCommand(bundle, environment);
  const backend = new Backend(command.executable, environment, command.args);
  const hello = await backend.call('handshake', {});
  if (!hello.ok) throw new Error(hello.error.message);
  const identity = hello.result as { protocol?: unknown; database?: unknown; version?: unknown };
  if (identity.protocol !== 1 || typeof identity.database !== 'string' || !isAbsolute(identity.database) || typeof identity.version !== 'string' || !/^0\.(2[3-9]|[3-9]\d|\d{3,})\./.test(identity.version) && !/^[1-9]\d*\./.test(identity.version)) throw new Error('Incompatible Pinote backend; install Pinote 0.23.0+ with protocol 1.');
  const database = identity.database;
  let switchRequested = false, switchConfirming = false;
  const switchOptions = () => ({ ...switchRuntime(), env: process.env, database });
  // Resolve the runtime once: each menu opening only rereads the preference and launcher.
  let menuSwitchOptions: ReturnType<typeof switchOptions> | undefined;
  const backendSwitched = async () => {
    try { return await hasBackendPreference(process.env) && await hasInstalledLauncher(menuSwitchOptions ??= switchOptions()); } catch { return false; }
  };
  const hash = createHash('sha256').update(identity.database).digest('hex').slice(0,32);
  dataDir = join(dirname(identity.database), 'electron');
  const profile = join(xdg('XDG_STATE_HOME', '.local/state'), 'pinote', 'electron', hash);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // Electron's singleton lock must follow the database even when XDG_STATE_HOME differs.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  app.setPath('userData', join(dataDir, 'profile')); app.setPath('sessionData', join(profile, 'session'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  logFile = join(profile, 'app.log');
  try {
    const raw = await readFile(join(dataDir, 'state.json'), 'utf8');
    if (Buffer.byteLength(raw) > MAX_STATE_FILE_BYTES) throw new Error('Oversized state');
    const value: unknown = JSON.parse(raw);
    if (!validState(value)) throw new Error('Invalid state');
    state = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { readonly = true; state.warning = 'Electron state/drafts cannot be read safely. This window is read-only; close it and repair or back up electron/state.json before retrying. GTK remains available.'; }
  }
  await app.whenReady();
  const watcherHost = () => import(pathToFileURL(join(bundles, 'service/watcher-host.mjs')).href);
  let watcherSaving = false;
  // Field watchers run exactly as long as this desktop; Pi sessions read their saved results.
  watchers = (async () => {
    try {
      const { startFieldWatchers } = await watcherHost();
      const started = await startFieldWatchers({ log: (event: string) => log(`Pinote field watchers: ${event}`) }) as { close(): Promise<void> };
      log('Pinote field watchers started');
      return { close: async () => { await started.close(); log('Pinote field watchers stopped'); } };
    } catch { log('Pinote field watchers did not start; check the watcher state directory. The desktop remains usable.'); }
  })();
  const styleNonce = randomUUID();
  const assets = new Set(['index.html','renderer.js','preview.html','preview.js','style.css', ...readdirSync(join(__dirname, 'icons')).filter(f => /^[\w-]+\.svg$/.test(f)).map(f => `icons/${f}`)]);
  protocol.handle('pinote-app', async request => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname).replace(/^\//,'');
    if (request.method !== 'GET' || url.protocol !== 'pinote-app:' || url.hostname !== 'ui' || url.port !== '' || url.username || url.password || url.search || !assets.has(path)) return new Response('Not found', { status: 404 });
    const rawContent = await readFile(join(__dirname, path));
    const content = path === 'index.html' ? rawContent.toString().replace('PINOTE_STYLE_NONCE', styleNonce) : rawContent;
    const mime = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    return new Response(content, { headers: { 'Content-Type': mime, 'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`, 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  let area = screen.getDisplayNearestPoint({ x:25, y:1300 }).workArea;
  let position: { x: number; y: number } | undefined;
  try {
    const size = JSON.parse(await readFile(join(dataDir, 'window.json'), 'utf8'));
    if (Number.isSafeInteger(size.x) && Number.isSafeInteger(size.y)) {
      position = { x: size.x, y: size.y }; area = screen.getDisplayNearestPoint(position).workArea;
    }
    if (Number.isFinite(size.width) && Number.isFinite(size.height)) { fullSize = { width: Math.max(280, Math.min(size.width,area.width)), height: Math.max(120,Math.min(size.height,area.height)) }; manualSize = size.manualSize !== false; }
  } catch { /* Missing/invalid geometry never damages drafts or task data. */ }
  const x = Math.max(area.x, Math.min(position?.x ?? area.x + 25, area.x + area.width - fullSize.width));
  collapsed = state.collapsed ?? false;
  const height = collapsed ? 132 : fullSize.height;
  const y = Math.max(area.y, Math.min(position?.y ?? area.y + area.height - height - 25, area.y + area.height - height));
  const bottom = y + height;
  window = new BrowserWindow({ width: fullSize.width, height, x, y,
    minWidth: 280, minHeight: 120, type: 'utility', frame: false, show: false, title: 'Pinote Electron', backgroundColor: '#232832', alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged },
  });
  const preview = previewWindow(window);
  window.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    if (exiting) return;
    activeMenu?.closePopup(window);
    log('Renderer exited unexpectedly; drafts and any uncertain operation were preserved.');
    state.warning = warning; uncertain = true; closing = true;
    void (async () => {
      await tasks;
      if (!readonly) for (;;) {
        try { await persist(); break; }
        catch {
          const result = await dialog.showMessageBox(window!, {
            type: 'warning', message: 'Recovered drafts could not be saved.',
            detail: 'Pinote will stay open to preserve recovered text. Restore access to draft storage and retry, or copy the recovered state before quitting. No task operation will be replayed.',
            buttons: ['Retry saving', 'Copy recovered state', 'Quit without saving'], defaultId: 0, cancelId: 0,
          });
          if (result.response === 1) clipboard.writeText(JSON.stringify(state));
          if (result.response === 2) break; // Explicit user consent to discard unsaved recovery state.
        }
      }
      exiting = true; window?.destroy(); app.quit();
    })().catch(() => log('Cannot show recovery controls; recovered drafts remain in memory. Do not force quit before recovering them.'));
  });
  window.on('ready-to-show', () => { window?.show(); window?.focus(); });
  window.once('show', () => setTimeout(() => {
    if (!window) return;
    const current = window.getBounds(); changingSize = true;
    window.setBounds({ x, y: Math.max(area.y, bottom - current.height), width: current.width, height: current.height });
    setTimeout(() => { changingSize = false; geometryReady = true; }, 150);
  }, 100));
  window.on('resize', () => {
    if (!window || !geometryReady || changingSize || collapsed) return;
    manualSize = true;
    void saveGeometry();
  });
  window.on('move', () => {
    if (changingSize) return;
    void saveGeometry();
  });
  window.on('close', event => {
    if (exiting) return;
    event.preventDefault();
    if (!closing) { closing = true; activeMenu?.closePopup(window); window?.webContents.send('close-requested'); }
  });
  const handlers: Record<string, (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown> = {
    'open-preview': (_event, request: unknown) => closing ? false : preview.open(request),
    'update-preview': (_event, token: unknown, data: unknown) => preview.update(token, data),
    'popup-menu': async (_event, request: unknown) => { if (!validMenuRequest(request)) throw new Error('Invalid menu request'); return popupMenu(request, !await backendSwitched()); },
    'load-state': () => structuredClone(state),
    'backend-settings': async () => {
      try {
        const options = switchOptions();
        const version = (await runCommand(options.node, [join(bundles, 'cli.mjs'), '--version'], process.env)).trim();
        const selected = await hasBackendPreference(process.env);
        const switched = selected && await hasInstalledLauncher(options);
        return { switched, canSwitch: !switched && !readonly && !closing && !state.warning,
          detail: switched ? 'Node is selected for the desktop. The user CLI matches this installation.' : selected ? 'Node is selected for the desktop, but the installed user CLI is missing or different. Check your CLI before switching again.' : command.args.length ? 'The desktop uses bundled Node. Install the matching user CLI to complete the switch.' : 'The desktop still uses an explicit backend override. Switch to the bundled Node backend and matching CLI.', version };
      } catch { return { switched: false, canSwitch: false, detail: 'The bundled backend or Node.js 22.19+ is unavailable. Install this version completely before switching.', version: '' }; }
    },
    'switch-backend': async () => {
      if (readonly || state.warning || closing || switchRequested || switchConfirming) return false;
      switchConfirming = true;
      try {
        switchOptions();
        const result = await dialog.showMessageBox(window!, { type: 'warning', message: 'Switch to the Node backend?',
          detail: 'Saves pending edits, backs up SQLite, Electron drafts and configuration, and replaces your ~/.local/bin/note command. An existing note command must use the same database.\n\nThe current desktop backend override will be replaced by your explicit Node choice. A different future diagnostic override will still work. Electron restarts after verification. On failure, configuration is restored; task data is never converted or automatically restored from backup. No downloads, administrator access or model requests.',
          buttons: ['Cancel', 'Switch to Node backend'], defaultId: 0, cancelId: 0 });
        if (result.response !== 1 || closing) return false;
        switchRequested = true;
        // Let the IPC caller finish before the existing close/drain protocol.
        setTimeout(() => window?.close(), 0);
        return true;
      } finally { switchConfirming = false; }
    },
    'acknowledge-warning': async () => {
      if (readonly) return false;
      const result = await dialog.showMessageBox(window!, { type: 'warning', message: 'Have you checked saved tasks and any new Kitty tab?', detail: 'Continue only after reconciling the uncertain operation. No task or launch will be retried.', buttons: ['Cancel', 'I checked; enable writes'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return false;
      uncertain = false; state.warning = ''; await persist(); return true;
    },
    // Field names configured in Pi's settings; the editor offers them even when a task has no value yet.
    'agent-fields': async () => { try { return agentFieldNames(JSON.parse(await readFile(join(getAgentDir(), 'pi-note.json'), 'utf8'))); } catch { return []; } },
    'save-state': async (_event, value: unknown) => { if (readonly || !validState(value)) throw new Error('Cannot save invalid or unreadable state'); const next = structuredClone(value); next.warning = state.warning; state = next; await persist(); },
    backend: async (_event, op: unknown, params: unknown) => {
      if (op === 'handshake' || !validParams(op,params)) return { protocol:1,ok:false,error:{code:'invalid',message:'Invalid operation.'} };
      if ((readonly || state.warning) && mutating(op)) return { protocol:1,ok:false,error:{code:'invalid',message:'Draft storage is read-only; repair it before saving tasks.'} };
      const work = tasks.then(async () => {
        if (mutating(op) && (readonly || state.warning)) return { protocol:1 as const,ok:false as const,error:{code:'invalid' as const,message:'Resolve the previous warning before making further changes.'} };
        if (mutating(op)) { uncertain = true; await persist(); }
        const response = await backend.call(op,params);
        if (mutating(op)) {
          uncertain = !response.ok && response.error.code === 'unknown';
          if (uncertain) state.warning = warning;
          await persist().catch(() => { state.warning = 'Task operation finished, but local draft state could not be saved. Check tasks before retrying.'; log('Cannot persist Electron state after task operation.'); });
        }
        return mutating(op) && response.ok && state.warning ? { ...response, warning: state.warning } : response;
      });
      tasks = work.then(() => {}, () => {});
      return work;
    },
    'watcher-settings': async () => (await watcherHost()).watcherSettings(),
    'choose-watcher': async () => {
      const result = await dialog.showOpenDialog(window!, { title: 'Add watcher script', properties: ['openFile'] });
      return result.canceled || !result.filePaths[0] ? null : (await watcherHost()).describeWatcher(result.filePaths[0]);
    },
    // The running scheduler rereads pi-note.json: saved changes apply to its next check.
    'save-watchers': async (_event, entries: unknown, raw: unknown) => {
      if (readonly || state.warning) throw new Error('Resolve the saved-state warning before changing watchers.');
      if (closing || watcherSaving || !Array.isArray(entries) || !(raw === null || typeof raw === 'string') || Buffer.byteLength(JSON.stringify([entries, raw])) > 2 * 1024 * 1024) throw new Error('Invalid watcher settings');
      watcherSaving = true;
      try {
        // Validated first: the confirmation names every enabled script and each shared value, such as a
        // Forgejo instance and the token variable sent to it.
        const host = await watcherHost(), trusted: string[] = host.watcherSaveSummary(entries);
        const result = await dialog.showMessageBox(window!, { type: 'warning', message: 'Save watcher settings?',
          detail: trusted.length ? `Enabled watchers are trusted code, not sandboxed. They run with your permissions and credentials while Pinote is open:\n\n${trusted.join('\n')}` : 'No watcher will be enabled.',
          buttons: ['Cancel', 'Save'], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return false;
        host.saveWatcherSettings(entries, raw);
        return true;
      } finally { watcherSaving = false; }
    },
    'choose-folder': async () => { const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
    copy: (_event, text: unknown) => { if (typeof text !== 'string' || text.length > 1024*1024) throw new Error('Invalid clipboard text'); clipboard.writeText(text); },
    'open-link': async (_event, url: unknown) => { if (!safeLink(url)) throw new Error('Unsupported link'); await shell.openExternal(url); },
    fit: (_event, height: unknown) => { if (typeof height !== 'number' || !Number.isFinite(height) || height < 0 || height > 100000) throw new Error('Invalid height'); if (!manualSize && !collapsed && window && Math.abs(window.getBounds().height - height) > 1) resize(fullSize.width,height); },
    collapse: (_event, value: unknown) => { if (typeof value !== 'boolean') throw new Error('Invalid collapse'); if (value === collapsed) return; if (value && window) { const [width,height] = window.getSize(); fullSize = {width,height}; } collapsed = value; resize(fullSize.width,value ? 132 : fullSize.height); },
    'cancel-close': () => { if (!exiting) { closing = false; switchRequested = false; } },
    'finish-close': async () => {
      if (!closing) throw new Error('Close was not requested.');
      await tasks; await stateWrites; await saveGeometry();
      if (switchRequested) {
        try {
          if (readonly || state.warning) throw new Error('Resolve the saved-state warning before switching backends.');
          await switchToNode(switchOptions(), text => window?.webContents.send('backend-switch-progress', text));
          app.relaunch();
        } catch (error) { switchRequested = false; throw error; }
      }
      exiting = true; window?.destroy(); app.quit();
    },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, (event,...args) => { trusted(event); return handler(event,...args); });
  await window.loadURL(`${origin}/index.html`);
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', event => {
  if (!watchers || watchersStopped) return;
  event.preventDefault();
  void stopWatchers().then(() => app.quit());
});
process.on('uncaughtException', () => { log('Unexpected Electron failure; check saved state before retrying.'); void stopWatchers().then(() => app.exit(1)); });
process.on('unhandledRejection', () => { log('Unexpected Electron operation failure; check saved state before retrying.'); });
void boot().catch(error => { log(error instanceof Error ? error.message : 'Cannot start Pinote Electron'); void stopWatchers().then(() => app.exit(1)); });
