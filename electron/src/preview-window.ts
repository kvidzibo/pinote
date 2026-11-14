import { app, BrowserWindow, clipboard, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import type { PreviewData, PreviewRequest } from './protocol';
import { safeLink, validPreviewData, validPreviewRequest } from './security';

// The preview has its own restricted preload, never the checklist's mutation API.
export function previewWindow(owner: BrowserWindow) {
  let current: { window: BrowserWindow; request: PreviewRequest; ready: (height: number) => Promise<void>; edit: boolean } | undefined;
  const close = () => current?.window.destroy();
  const handlers: Record<string, (...args: any[]) => unknown> = {
    'preview-load': () => current!.request.data,
    'preview-ready': (height: unknown) => {
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 1 || height > 100000) throw new Error('Invalid preview height');
      return current!.ready(height);
    },
    'preview-action': (action: unknown) => {
      if (typeof action !== 'string' || !['copy','edit','close'].includes(action)) throw new Error('Invalid preview action');
      if (action === 'copy') { clipboard.writeText(current!.request.data.task.text); return; }
      current!.edit = action === 'edit';
      owner.show(); owner.focus(); close();
    },
    'preview-link': async (url: unknown) => { if (!safeLink(url)) throw new Error('Unsupported link'); await shell.openExternal(url); },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, (event, ...args) => {
    if (!current || event.sender !== current.window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.origin !== 'pinote-app://ui') throw new Error('Untrusted preview sender');
    return handler(...args);
  });
  owner.on('closed', () => { close(); for (const name of Object.keys(handlers)) ipcMain.removeHandler(name); });
  owner.on('hide', close);
  owner.on('minimize', close);
  owner.on('close', close);
  owner.webContents.on('render-process-gone', close);
  return {
    async open(value: unknown): Promise<boolean> {
      if (!validPreviewRequest(value)) throw new Error('Invalid preview request');
      close();
      const request = structuredClone(value);
      const content = owner.getContentBounds();
      const point = { x: content.x + Math.min(request.point.x, content.width - 1), y: content.y + Math.min(request.point.y, content.height - 1) };
      const area = screen.getDisplayNearestPoint(point).workArea;
      const width = Math.min(420, area.width), maxHeight = Math.min(480, area.height);
      const popup = new BrowserWindow({ width, height: maxHeight, parent: owner, type: 'popup-menu', frame: false, resizable: false, show: false,
        skipTaskbar: true, alwaysOnTop: true, title: `Task ${request.data.task.id}`, backgroundColor: '#232832',
        webPreferences: { preload: join(__dirname, 'preview-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged },
      });
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popup.webContents.on('will-navigate', event => event.preventDefault());
      popup.webContents.on('will-attach-webview', event => event.preventDefault());
      popup.webContents.on('render-process-gone', () => popup.destroy());
      return new Promise<boolean>((resolve, reject) => {
        let shown = false;
        let placementTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => { if (!shown) { reject(new Error('Task preview did not become ready.')); popup.destroy(); } }, 10000);
        const entry = { window: popup, request, edit: false, ready: (naturalHeight: number) => new Promise<void>(ready => {
          if (shown) { ready(); return; } // Polling and mouse movement never move or resize an open preview.
          const height = Math.min(Math.ceil(naturalHeight), maxHeight);
          const beside = (at: number, size: number, start: number, span: number) => {
            const preferred = at + 10 + size <= start + span ? at + 10 : at - 10 - size;
            return Math.max(start, Math.min(preferred, start + span - size));
          };
          const bounds = { x: beside(point.x, width, area.x, area.width), y: beside(point.y, height, area.y, area.height), width, height };
          popup.setBounds(bounds); shown = true; clearTimeout(timer);
          popup.show(); popup.focus();
          // X11 window managers can apply frame offsets after mapping (as for the checklist).
          popup.once('closed', ready);
          placementTimer = setTimeout(() => { popup.setBounds(bounds); resolve(true); ready(); }, 100);
        }) };
        current = entry;
        popup.on('blur', () => { if (shown) popup.destroy(); });
        popup.on('closed', () => {
          clearTimeout(timer); clearTimeout(placementTimer);
          if (current === entry) current = undefined;
          if (!owner.isDestroyed()) owner.webContents.send('preview-closed', request.token, entry.edit);
          resolve(false);
        });
        void popup.loadURL('pinote-app://ui/preview.html').catch(error => { reject(error); if (!popup.isDestroyed()) popup.destroy(); });
      });
    },
    update(token: unknown, data: unknown): void {
      if (typeof token !== 'number' || !Number.isSafeInteger(token) || token <= 0 || (data !== null && !validPreviewData(data))) throw new Error('Invalid preview update');
      if (current?.request.token !== token) return;
      if (data === null) { close(); return; }
      const next = data as PreviewData;
      if (next.task.id !== current.request.data.task.id) throw new Error('Preview task changed');
      current.request.data = next;
      current.window.webContents.send('preview-update', next);
    },
  };
}
